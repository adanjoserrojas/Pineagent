import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pineagent-fence-"));
  await writeFile(join(root, "a.ts"), "old");
  let now = 0;
  return { ws: new Workspace(root, { leaseMs: 100, idleMs: 1000 }, () => now), advance: () => { now = 101; } };
}

it("rejects queued edits and claims after their credential is revoked", async () => {
  const { ws } = await fixture();
  ws.acquire("a.ts", "file", "alice");
  const release = await ws.freeze("all");
  let active = true;
  const edit = ws.applyOps("a.ts", "alice", 1, [{ offset: 0, length: 3, text: "new" }], undefined, () => active);
  const claim = ws.acquireSafely("b.ts", "file", "alice", () => active);
  const rejectedEdit = expect(edit).rejects.toThrow("authorization expired");
  const rejectedClaim = expect(claim).rejects.toThrow("authorization expired");
  active = false;
  release();
  await Promise.all([rejectedEdit, rejectedClaim]);
  expect(await ws.read("a.ts")).toEqual({ content: "old", version: 1 });
  expect(ws.allLocks().map(lock => lock.path)).toEqual(["a.ts"]);
});

it("retains authority when a container cannot be stopped, then allows a safe retry", async () => {
  const { ws } = await fixture();
  ws.acquire("a.ts", "file", "alice");
  ws.setLeaseFence(async () => { throw new Error("stop failed"); });
  await expect(ws.releaseSafely("a.ts", "alice")).rejects.toThrow("stop failed");
  expect(ws.allLocks()[0].holder).toBe("alice");
  ws.setLeaseFence(async () => {});
  expect(await ws.releaseSafely("a.ts", "alice")).toMatchObject({ holder: "alice" });
  expect(ws.allLocks()).toEqual([]);
});

it("never hands off an expired grant before physical revocation succeeds", async () => {
  const { ws, advance } = await fixture();
  ws.acquire("a.ts", "file", "alice");
  advance();
  ws.setLeaseFence(async () => { throw new Error("stop failed"); });
  await expect(ws.sweepSafely()).rejects.toThrow("stop failed");
  expect(ws.allLocks()[0].holder).toBe("alice");
  expect(ws.heartbeat("alice")).toEqual([]);
  ws.setLeaseFence(async () => {});
  expect(await ws.sweepSafely()).toMatchObject([{ reason: "expired" }]);
  expect((await ws.acquireSafely("a.ts", "file", "bob")).ok).toBe(true);
});

it("rejects unfenced mutation entrypoints once sandbox protection is enabled", async () => {
  const { ws } = await fixture();
  ws.setLeaseFence(async () => {});
  expect(() => ws.acquire("a.ts", "file", "alice")).toThrow("fenced");
  expect(() => ws.release("a.ts", "alice")).toThrow("fenced");
  expect(() => ws.sweep()).toThrow("fenced");
  expect(() => ws.acquireForRun(["a.ts"], "alice", "run")).toThrow("fenced");
  expect(() => ws.releaseRun("run")).toThrow("fenced");
  expect((await ws.acquireRunSafely(["a.ts"], "alice", "run")).ok).toBe(true);
  expect(await ws.releaseRunSafely("run")).toHaveLength(1);
});

it("serializes overlapping freezes without losing the first write barrier", async () => {
  const { ws } = await fixture();
  ws.acquire("a.ts", "file", "alice");
  const first = await ws.freeze("all");
  let secondEntered = false;
  const pending = ws.freeze(["a.ts"]).then((release) => { secondEntered = true; return release; });
  await new Promise((r) => setTimeout(r, 10));
  expect(secondEntered).toBe(false);
  first();
  const second = await pending;
  let written = false;
  const edit = ws.applyOps("a.ts", "alice", 1, [{ offset: 0, length: 3, text: "new" }]).then(() => { written = true; });
  await new Promise((r) => setTimeout(r, 10));
  expect(written).toBe(false);
  second();
  await edit;
  expect(written).toBe(true);
});

it("stops sandboxes before Git enters a frozen region and unwinds a failed fence", async () => {
  const { ws } = await fixture();
  let calls = 0;
  ws.setLeaseFence(async () => { calls++; if (calls === 1) throw new Error("stop failed"); });
  await expect(ws.freeze("all")).rejects.toThrow("stop failed");
  const release = await ws.freeze("all");
  expect(calls).toBe(2);
  release();
});

it("does not interrupt a holder for denied edits, denied claims, renewal or foreign release", async () => {
  const { ws } = await fixture();
  ws.acquire("a.ts", "file", "alice");
  let calls = 0;
  ws.setLeaseFence(async () => { calls++; });
  ws.setWriteFence(async () => { calls++; });
  expect(await ws.releaseSafely("a.ts", "bob")).toBeNull();
  expect(await ws.acquireSafely("a.ts", "file", "bob")).toMatchObject({ ok: false });
  expect(await ws.acquireSafely("a.ts", "file", "alice")).toMatchObject({ ok: true, created: false });
  expect(await ws.acquireRunSafely(["a.ts"], "bob", "run")).toMatchObject({ ok: false });
  expect(await ws.releaseRunSafely("unknown")).toEqual([]);
  expect(await ws.applyOps("a.ts", "bob", 1, [])).toMatchObject({ ok: false });
  expect(await ws.applyOps("a.ts", "alice", 0, [])).toMatchObject({ ok: false });
  expect(calls).toBe(0);
});
