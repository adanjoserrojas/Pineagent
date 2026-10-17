// Thin wrapper over the git CLI for the mock's per-room repositories.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type GitStatusEntry = { path: string; status: "M" | "A" | "D" };

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args[0]} failed: ${stderr.trim().split("\n")[0] ?? ""}`);
  }
}

// Never let a developer's global git config, hooks or signing settings leak into the mock.
const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_COMMITTER_NAME: "Pineagent",
  GIT_COMMITTER_EMAIL: "pineagent@users.noreply.github.com",
};

export class GitRepo {
  constructor(
    readonly dir: string,
    readonly branch = "main",
  ) {}

  run(args: string[], env: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.dir, env: { ...BASE_ENV, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new GitError(args, stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  // A repo with one commit of whatever is in `dir`, pushed to a bare repo standing in for GitHub.
  static async init(dir: string, remoteDir: string, branch = "main"): Promise<GitRepo> {
    const remote = new GitRepo(remoteDir, branch);
    await remote.run(["init", "--bare", "-q", "-b", branch]);
    const repo = new GitRepo(dir, branch);
    await repo.run(["init", "-q", "-b", branch]);
    await repo.run(["add", "-A"]);
    await repo.run(["commit", "-q", "-m", "Initial import", "--author", "Pineagent <pineagent@users.noreply.github.com>"]);
    await repo.run(["remote", "add", "origin", remoteDir]);
    await repo.run(["push", "-q", "-u", "origin", branch]);
    return repo;
  }

  // Read-only and lock-free, so it can run alongside a queued job.
  async status(): Promise<GitStatusEntry[]> {
    const out = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { GIT_OPTIONAL_LOCKS: "0" });
    const entries: GitStatusEntry[] = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      const path = rec.slice(3);
      if (xy[0] === "R" || xy[0] === "C") i++; // the original path follows a rename/copy
      const status = xy === "??" || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
      entries.push({ path, status });
    }
    return entries;
  }

  async lineCounts(entries: GitStatusEntry[]): Promise<Map<string, { added: number; removed: number }>> {
    const counts = new Map<string, { added: number; removed: number }>();
    const tracked = entries.filter((e) => e.status !== "A").map((e) => e.path);
    if (tracked.length) {
      const out = await this.run(["diff", "--numstat", "HEAD", "--", ...tracked], { GIT_OPTIONAL_LOCKS: "0" });
      for (const line of out.split("\n")) {
        const [a, r, p] = line.split("\t");
        if (p) counts.set(p, { added: Number(a) || 0, removed: Number(r) || 0 });
      }
    }
    for (const e of entries.filter((x) => x.status === "A")) {
      const text = await readFile(join(this.dir, e.path), "utf8").catch(() => "");
      counts.set(e.path, { added: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, removed: 0 });
    }
    return counts;
  }

  async head(): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  // Local commits the remote doesn't have yet, as of the last fetch.
  async ahead(): Promise<number> {
    const out = await this.run(["rev-list", "--count", `origin/${this.branch}..HEAD`], { GIT_OPTIONAL_LOCKS: "0" });
    return Number(out.trim()) || 0;
  }
}
