// One serial Git queue per worktree (LLD section 6, contracts/GIT_QUEUE.md).
// Commits only paths the requester alone edited, as that user; push = commit, fetch, rebase, push.
import type { GitChange, GitErrorCode, GitJob, GitResult, GitStatusAck } from "../contracts";
import { GitError, type GitRepo } from "./git";
import type { Workspace } from "./workspace";

export type Author = { id: string; name: string; email: string };

export type QueueEvents = {
  queue(jobs: GitJob[]): void;
  result(result: GitResult): void;
  // Git changed a file under the editors (rebase brought in remote work).
  fileChanged(path: string, before: string, after: string, version: number): void;
  treeChanged(path: string, change: "add" | "delete"): void;
};

const MAX_MESSAGE = 5000;
const MAX_PATHS = 500;

export class GitQueue {
  private tail: Promise<void> = Promise.resolve();
  private jobs: GitJob[] = [];
  private seq = 0;

  constructor(
    private readonly ws: Workspace,
    private readonly repo: GitRepo,
    private readonly events: QueueEvents,
    // Environment that lets git reach the remote as this user (their own GitHub token, rule 5).
    private readonly credentials: (userId: string) => Promise<Record<string, string>> = async () => ({}),
  ) {}

  async changes(userId: string): Promise<GitChange[]> {
    const entries = await this.repo.status();
    const counts = await this.repo.lineCounts(entries);
    return entries.map((e) => {
      const editors = this.ws.editorsOf(e.path);
      const reason: GitChange["reason"] =
        editors.length === 0
          ? "UNATTRIBUTED"
          : editors.some((x) => x !== userId)
            ? "OTHERS_EDITED"
            : this.ws.lockedByOther(e.path, userId)
              ? "LOCKED_BY_OTHER"
              : undefined;
      const { added, removed } = counts.get(e.path) ?? { added: 0, removed: 0 };
      return { path: e.path, status: e.status, added, removed, editors, committable: !reason, ...(reason ? { reason } : {}) };
    });
  }

  async status(userId: string): Promise<GitStatusAck> {
    return { ok: true, branch: this.repo.branch, ahead: await this.repo.ahead(), changes: await this.changes(userId), queue: this.jobs };
  }

  // Validates the request shape; ownership is checked when the job runs.
  enqueue(author: Author, paths: unknown, message: unknown, push: unknown): string | null {
    if (!Array.isArray(paths) || paths.length > MAX_PATHS || !paths.every((p) => typeof p === "string" && this.ws.resolvePath(p))) return null;
    if (typeof push !== "boolean" || typeof message !== "string") return null;
    const unique = [...new Set(paths as string[])];
    const text = message.trim();
    if (unique.length && (!text || text.length > MAX_MESSAGE)) return null;
    if (!unique.length && !push) return null;

    const job: GitJob = {
      id: `job-${++this.seq}`,
      userId: author.id,
      name: author.name,
      kind: unique.length && push ? "commit+push" : push ? "push" : "commit",
      state: "queued",
    };
    this.jobs = [...this.jobs, job];
    this.events.queue(this.jobs);
    this.tail = this.tail.then(() => this.run(job, author, unique, text, push));
    return job.id;
  }

  private async run(job: GitJob, author: Author, paths: string[], message: string, push: boolean) {
    this.jobs = this.jobs.map((j) => (j.id === job.id ? { ...j, state: "running" } : j));
    this.events.queue(this.jobs);
    let result: GitResult;
    try {
      result = await this.execute(job, author, paths, message, push);
    } catch (err) {
      result = this.fail(job, "FAILED", err instanceof GitError ? err.message : String(err));
    }
    this.jobs = this.jobs.filter((j) => j.id !== job.id);
    this.events.queue(this.jobs);
    this.events.result(result);
  }

  private fail(job: GitJob, code: GitErrorCode, message: string, paths?: string[]): GitResult {
    return { jobId: job.id, userId: job.userId, ok: false, code, message, ...(paths ? { paths } : {}) };
  }

  private async execute(job: GitJob, author: Author, paths: string[], message: string, push: boolean): Promise<GitResult> {
    let sha: string | undefined;
    let committed: string[] = [];

    if (paths.length) {
      // Freeze first, then check: no edit can land between the ownership check and the commit.
      const release = await this.ws.freeze(paths);
      try {
        const changes = await this.changes(author.id);
        const dirty = paths.filter((p) => changes.some((c) => c.path === p));
        if (!dirty.length) return this.fail(job, "NOTHING_TO_COMMIT", "None of these files have changes to commit.");
        const notYours = dirty.filter((p) => !changes.find((c) => c.path === p)?.committable);
        if (notYours.length) {
          return this.fail(job, "NOT_YOURS", `These files include work that isn't only yours: ${notYours.join(", ")}`, notYours);
        }
        await this.repo.run(["add", "--", ...dirty]);
        await this.repo.run(["commit", "-q", "-m", message, "--author", `${author.name} <${author.email}>`, "--", ...dirty]);
        sha = await this.repo.head();
        committed = dirty;
        this.ws.clearEditors(dirty);
      } finally {
        release();
      }
    }

    if (!push) return { jobId: job.id, userId: job.userId, ok: true, sha, pushed: false, paths: committed };

    const branch = this.repo.branch;
    // A failed push after a successful commit must say the commit is safe.
    const kept = committed.length ? " Your commit is saved and will go out with the next push." : "";
    const pushFail = (code: GitErrorCode, msg: string, held?: string[]) => this.fail(job, code, msg + kept, held);
    const auth = await this.credentials(author.id);
    await this.repo.run(["fetch", "-q", "origin"], auth);
    const behind = Number((await this.repo.run(["rev-list", "--count", `HEAD..origin/${branch}`])).trim());
    if (behind > 0) {
      // Never rebase over someone's uncommitted work: hold the push if incoming commits touch it.
      const incoming = (await this.repo.run(["diff", "--name-only", `HEAD...origin/${branch}`])).split("\n").filter(Boolean);
      const dirty = new Set((await this.repo.status()).map((e) => e.path));
      const held = incoming.filter((p) => dirty.has(p));
      if (held.length) {
        return pushFail("REMOTE_HELD", `Remote changes touch files with uncommitted work: ${held.join(", ")}.`, held);
      }
      const release = await this.ws.freeze("all");
      try {
        const before = await this.repo.head();
        try {
          await this.repo.run(["rebase", "-q", "--autostash", `origin/${branch}`]);
        } catch {
          await this.repo.run(["rebase", "--abort"]).catch(() => {});
          return pushFail("REBASE_CONFLICT", "Your commit conflicts with remote changes; nothing was pushed.");
        }
        // What the rebase brought in: refresh the server's copies and tell the editors.
        const diff = await this.repo.run(["diff", "--name-status", before, "HEAD"]);
        for (const line of diff.split("\n").filter(Boolean)) {
          const [status, path] = line.split("\t");
          const r = await this.ws.reloadFromDisk(path);
          if (!r) this.events.treeChanged(path, "delete");
          else if (status === "A") this.events.treeChanged(path, "add");
          else this.events.fileChanged(path, r.before, r.after, r.version);
        }
      } finally {
        release();
      }
    }

    try {
      await this.repo.run(["push", "-q", "origin", `HEAD:${branch}`], auth);
    } catch {
      return pushFail("PUSH_REJECTED", "The remote changed while pushing; try again.");
    }
    return { jobId: job.id, userId: job.userId, ok: true, sha: sha ?? (await this.repo.head()), pushed: true, paths: committed };
  }
}
