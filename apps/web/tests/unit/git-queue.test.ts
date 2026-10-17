import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { GitRepo } from "@pineagent/core/server";
import { GitQueue, type Author } from "@pineagent/core/server";
import { Workspace } from "@pineagent/core/server";
import type { GitJob, GitResult } from "@pineagent/core/contracts";

// The Git queue against real git: a worktree repo plus a bare repo standing in for GitHub.

const FIXTURE = fileURLToPath(new URL("../../mock/fixtures/demo-repo", import.meta.url));
const ALICE: Author = { id: "dev|alice", name: "alice", email: "alice@users.noreply.github.com" };
const BOB: Author = { id: "dev|bob", name: "bob", email: "bob@users.noreply.github.com" };

let ws: Workspace;
let repo: GitRepo;
let queue: GitQueue;
let remoteDir: string;
let results: GitResult[];
let queueSnapshots: GitJob[][];
let fileEvents: { path: string; after: string; version: number }[];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-git-test-"));
  await cp(FIXTURE, root, { recursive: true });
  remoteDir = await mkdtemp(join(tmpdir(), "pineagent-git-remote-"));
  repo = await GitRepo.init(root, remoteDir);
  ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  results = [];
  queueSnapshots = [];
  fileEvents = [];
  queue = new GitQueue(ws, repo, {
    queue: (jobs) => queueSnapshots.push(jobs),
    result: (r) => results.push(r),
    fileChanged: (path, _before, after, version) => fileEvents.push({ path, after, version }),
    treeChanged: () => {},
  });
});

// An edit through the normal editor path: take the lock, apply one op.
async function edit(user: Author, path: string, text: string) {
  expect(ws.acquire(path, "file", user.id).ok).toBe(true);
  const { version } = (await ws.read(path))!;
  expect(await ws.applyOps(path, user.id, version, [{ offset: 0, length: 0, text }])).toMatchObject({ ok: true });
  ws.release(path, user.id);
}

async function runJob(author: Author, paths: string[], message: string, push = false): Promise<GitResult> {
  const id = queue.enqueue(author, paths, message, push);
  expect(id).not.toBeNull();
  await expect.poll(() => results.find((r) => r.jobId === id), { timeout: 10_000 }).toBeTruthy();
  return results.find((r) => r.jobId === id)!;
}

const lastCommit = async (dir = repo) => {
  const [author, ...files] = (await dir.run(["show", "--name-only", "--format=%an", "HEAD"])).trim().split("\n").filter(Boolean);
  return { author, files };
};

describe("attribution (release scenario 7)", () => {
  it("lists each person's own changes as committable and everyone else's as not", async () => {
    await edit(ALICE, "src/auth.ts", "// alice\n");
    await edit(BOB, "src/db.ts", "// bob\n");
    const forAlice = await queue.changes(ALICE.id);
    expect(forAlice.find((c) => c.path === "src/auth.ts")).toMatchObject({ committable: true, editors: [ALICE.id], added: 1, removed: 0 });
    expect(forAlice.find((c) => c.path === "src/db.ts")).toMatchObject({ committable: false, reason: "OTHERS_EDITED", editors: [BOB.id] });
  });

  it("commits only the requester's paths, as the requester", async () => {
    await edit(ALICE, "src/auth.ts", "// alice\n");
    await edit(BOB, "src/db.ts", "// bob\n");
    const r = await runJob(ALICE, ["src/auth.ts"], "Alice's change");
    expect(r).toMatchObject({ ok: true, pushed: false, paths: ["src/auth.ts"] });
    expect(await lastCommit()).toEqual({ author: "alice", files: ["src/auth.ts"] });
    expect((await repo.status()).map((e) => e.path)).toEqual(["src/db.ts"]); // Bob's work untouched
    expect((await queue.changes(BOB.id)).find((c) => c.path === "src/db.ts")?.committable).toBe(true);
  });

  it("refuses a commit that names someone else's path, and commits nothing", async () => {
    await edit(ALICE, "src/auth.ts", "// alice\n");
    await edit(BOB, "src/db.ts", "// bob\n");
    const head = await repo.head();
    const r = await runJob(ALICE, ["src/auth.ts", "src/db.ts"], "sneaky");
    expect(r).toMatchObject({ ok: false, code: "NOT_YOURS", paths: ["src/db.ts"] });
    expect(await repo.head()).toBe(head);
  });

  it("a file edited by two people can't be committed by either alone", async () => {
    await edit(ALICE, "src/auth.ts", "// alice\n");
    await edit(BOB, "src/auth.ts", "// bob\n");
    for (const u of [ALICE, BOB]) {
      expect((await queue.changes(u.id)).find((c) => c.path === "src/auth.ts")).toMatchObject({ committable: false, reason: "OTHERS_EDITED" });
    }
  });

  it("your edit is held back while someone else holds the file's lock", async () => {
    await edit(ALICE, "src/auth.ts", "// alice\n");
    ws.acquire("src/auth.ts", "file", BOB.id);
    expect((await queue.changes(ALICE.id)).find((c) => c.path === "src/auth.ts")).toMatchObject({ committable: false, reason: "LOCKED_BY_OTHER" });
  });

  it("changes made outside the editor belong to nobody", async () => {
    await writeFile(join(ws.root, "README.md"), "changed by a formatter\n");
    expect((await queue.changes(ALICE.id)).find((c) => c.path === "README.md")).toMatchObject({ committable: false, reason: "UNATTRIBUTED" });
  });
});

describe("queue", () => {
  it("runs jobs one at a time in order and reports positions", async () => {
    await edit(ALICE, "src/auth.ts", "// a\n");
    await edit(BOB, "src/db.ts", "// b\n");
    const a = queue.enqueue(ALICE, ["src/auth.ts"], "first", false)!;
    const b = queue.enqueue(BOB, ["src/db.ts"], "second", false)!;
    expect(queueSnapshots.at(-1)?.map((j) => j.id)).toEqual([a, b]);
    await expect.poll(() => results.length, { timeout: 10_000 }).toBe(2);
    expect(results.map((r) => r.jobId)).toEqual([a, b]);
    expect(queueSnapshots.at(-1)).toEqual([]);
    const log = (await repo.run(["log", "--format=%an %s", "-2"])).trim().split("\n");
    expect(log).toEqual(["bob second", "alice first"]);
  });

  it("edits to a file being committed wait for the commit instead of slipping in", async () => {
    await edit(ALICE, "src/auth.ts", "// a\n");
    ws.acquire("src/auth.ts", "file", ALICE.id);
    const release = await ws.freeze(["src/auth.ts"]);
    let landed = false;
    const pending = ws.applyOps("src/auth.ts", ALICE.id, 2, [{ offset: 0, length: 0, text: "x" }]).then((r) => ((landed = true), r));
    await new Promise((r) => setTimeout(r, 50));
    expect(landed).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: true, version: 3 });
  });

  it("rejects malformed requests up front", () => {
    expect(queue.enqueue(ALICE, ["../escape"], "m", false)).toBeNull();
    expect(queue.enqueue(ALICE, [".git/config"], "m", false)).toBeNull();
    expect(queue.enqueue(ALICE, ["src/auth.ts"], "   ", false)).toBeNull();
    expect(queue.enqueue(ALICE, [], "m", false)).toBeNull();
  });
});

describe("push", () => {
  it("commit and push lands on the remote", async () => {
    await edit(ALICE, "src/auth.ts", "// pushed\n");
    const r = await runJob(ALICE, ["src/auth.ts"], "Push it", true);
    expect(r).toMatchObject({ ok: true, pushed: true });
    const remote = new GitRepo(remoteDir);
    expect((await remote.run(["log", "-1", "--format=%an %s", "main"])).trim()).toBe("alice Push it");
    expect(await repo.ahead()).toBe(0);
  });

  async function teammatePushes(path: string, text: string) {
    const cloneDir = await mkdtemp(join(tmpdir(), "pineagent-git-clone-"));
    const clone = new GitRepo(cloneDir);
    await clone.run(["clone", "-q", remoteDir, "."]);
    await writeFile(join(cloneDir, path), text);
    await clone.run(["commit", "-qam", "teammate", "--author", "Teammate <t@example.com>"]);
    await clone.run(["push", "-q", "origin", "main"]);
  }

  it("rebases over remote changes to other files and refreshes them for the editors", async () => {
    await ws.read("README.md"); // someone has it open at version 1
    await teammatePushes("README.md", "# from the remote\n");
    await edit(ALICE, "src/auth.ts", "// mine\n");
    const r = await runJob(ALICE, ["src/auth.ts"], "After rebase", true);
    expect(r).toMatchObject({ ok: true, pushed: true });
    expect(await readFile(join(ws.root, "README.md"), "utf8")).toBe("# from the remote\n");
    expect(fileEvents).toEqual([{ path: "README.md", after: "# from the remote\n", version: 2 }]);
    expect((await ws.read("README.md"))?.content).toBe("# from the remote\n");
  });

  it("holds the push when remote changes touch someone's uncommitted work; the commit stays local", async () => {
    await teammatePushes("src/db.ts", "// remote db\n");
    await edit(BOB, "src/db.ts", "// bob's unsaved work\n");
    await edit(ALICE, "src/auth.ts", "// alice\n");
    const r = await runJob(ALICE, ["src/auth.ts"], "Held", true);
    expect(r).toMatchObject({ ok: false, code: "REMOTE_HELD", paths: ["src/db.ts"] });
    expect(r.ok === false && r.message).toContain("Your commit is saved");
    expect(await lastCommit()).toEqual({ author: "alice", files: ["src/auth.ts"] });
    expect(await readFile(join(ws.root, "src/db.ts"), "utf8")).toContain("bob's unsaved work");
  });
});
