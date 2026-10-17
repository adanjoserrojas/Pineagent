import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { MockHarness } from "../../mock/harness";
import { Workspace } from "@pineagent/core/server";
import type { Lock, RunEvent, RunView } from "@pineagent/core/contracts";

const FIXTURE = fileURLToPath(new URL("../../mock/fixtures/demo-repo", import.meta.url));
const ALICE = { id: "dev|alice", name: "alice" };
const BOB = { id: "dev|bob", name: "bob" };
const FILES = ["README.md", "package.json", "src/auth.ts", "src/db.ts", "src/jwt.ts", "src/routes/index.ts", "src/routes/users.ts", "src/types.ts"];

let ws: Workspace;
let harness: MockHarness;
let events: RunEvent[];
let lockEvents: { path: string; lock: Lock | null; reason: string }[];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-harness-test-"));
  await cp(FIXTURE, root, { recursive: true });
  ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  events = [];
  lockEvents = [];
  harness = new MockHarness(
    ws,
    "ws:test:main",
    async () => FILES,
    {
      run: (e) => events.push(e),
      lockChanged: (path, lock, reason) => lockEvents.push({ path, lock, reason }),
      fileChanged: () => {},
    },
    5,
  );
});

const startRun = (owner: typeof ALICE, task: string): string => {
  const res = harness.start(owner, task);
  if (!res.ok) throw new Error(`run:start refused: ${res.code}`);
  return res.runId;
};
const runOf = (id: string): RunView => harness.list().find((r) => r.runId === id)!;
const statesOf = (id: string) => events.filter((e) => e.runId === id).map((e) => e.state);
const until = (id: string, state: string) => expect.poll(() => runOf(id).state, { timeout: 5000 }).toBe(state);

describe("happy path", () => {
  it("plans, locks, routes, executes three steps and finishes", async () => {
    const id = startRun(ALICE, "add a test for currentUser");
    await until(id, "done");
    const states = statesOf(id);
    expect(states[0]).toBe("planning");
    expect(states).toContain("routing");
    expect(states.at(-1)).toBe("done");
    expect(events.filter((e) => e.runId === id && e.state === "executing").map((e) => e.nodeIndex)).toEqual([0, 1, 2]);
    // seq is strictly increasing and each event carries the matching snapshot
    const seqs = events.filter((e) => e.runId === id).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.every((e) => e.run.seq === e.seq && e.run.state === e.state)).toBe(true);
    expect(runOf(id)).toMatchObject({ routerMode: "openai", codingRecovery: "none", writeSet: ["src/auth.ts"] });
  });

  it("really edits the file under a run lock, then releases it; the edit counts as the owner's", async () => {
    const id = startRun(ALICE, "tidy auth");
    await until(id, "done");
    expect((await ws.read("src/auth.ts"))!.content.startsWith("// alice's agent: tidy auth\n")).toBe(true);
    expect(lockEvents.map((l) => `${l.reason}:${l.lock?.holderType ?? "-"}`)).toEqual(["acquired:run", "released:-"]);
    expect(ws.allLocks()).toEqual([]);
    expect(ws.editorsOf("src/auth.ts")).toEqual([ALICE.id]);
  });

  it("targets the file named in the task", async () => {
    const id = startRun(ALICE, "speed up db.ts");
    await until(id, "done");
    expect(runOf(id).writeSet).toEqual(["src/db.ts"]);
  });
});

describe("router modes", () => {
  it("uses the LLM when the scorer is down, and the cache for a repeated task", async () => {
    const a = startRun(ALICE, "fallback please");
    await until(a, "done");
    expect(runOf(a).routerMode).toBe("llm");
    const b = startRun(ALICE, "same task");
    await until(b, "done");
    const c = startRun(ALICE, "same task");
    await until(c, "done");
    expect([runOf(b).routerMode, runOf(c).routerMode]).toEqual(["openai", "cache"]);
  });
});

describe("routing versus coding recovery (contracts/RUN_EVENTS.md)", () => {
  it("Jev scores only when Decisions can't, and that is a router mode, not recovery", async () => {
    const id = startRun(ALICE, "backup scorer please");
    await until(id, "done");
    expect(runOf(id)).toMatchObject({ routerMode: "jev", codingRecovery: "none" });
  });

  it("a failed step hands over to a warm coding agent without changing the router mode", async () => {
    const id = startRun(ALICE, "recover from a bad step");
    await until(id, "done");
    expect(runOf(id)).toMatchObject({ routerMode: "openai", codingRecovery: "warm_agent" });
    // The top-level field and the snapshot agree on every event, and the change got its own seq.
    const mine = events.filter((e) => e.runId === id);
    expect(mine.every((e) => e.codingRecovery === e.run.codingRecovery && e.routerMode === e.run.routerMode)).toBe(true);
    const flip = mine.findIndex((e) => e.codingRecovery === "warm_agent");
    expect(flip).toBeGreaterThan(0);
    expect(mine[flip].seq).toBe(mine[flip - 1].seq + 1);
  });
});

describe("approval", () => {
  it("low confidence waits for the owner; only the owner can choose", async () => {
    const id = startRun(ALICE, "unsure how to fix auth");
    await until(id, "awaiting_approval");
    const run = runOf(id);
    expect(run.candidates).toHaveLength(3);
    expect(run.confidence).toBeLessThan(0.6);
    expect(run.candidates!.map((c) => c.score)).toEqual([...run.candidates!.map((c) => c.score)].sort((a, b) => b - a));
    expect(harness.approve(id, BOB.id, { candidateId: "dag-2" })).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(harness.approve(id, ALICE.id, { candidateId: "dag-2" })).toEqual({ ok: true });
    await until(id, "done");
    expect(runOf(id).steps.map((s) => s.tool)).toEqual(["grep", "edit_file", "format", "run_tests"]);
    expect(runOf(id).candidates).toBeUndefined();
  });

  it("'none of these' replans with the hint and goes on", async () => {
    const id = startRun(ALICE, "unsure");
    await until(id, "awaiting_approval");
    expect(harness.approve(id, ALICE.id, { none: true, hint: "keep the API" })).toEqual({ ok: true });
    await until(id, "done");
    expect(runOf(id).steps[0]).toMatchObject({ tool: "plan_with_hint", detail: "keep the API" });
    expect(harness.approve(id, ALICE.id, { candidateId: "dag-1" })).toEqual({ ok: false, code: "NOT_WAITING" });
  });
});

describe("failure, blocking and pause", () => {
  it("a failing step ends in error at that step and frees the locks", async () => {
    const id = startRun(ALICE, "this will fail");
    await until(id, "error");
    expect(runOf(id).error).toMatchObject({ nodeIndex: 1 });
    expect(ws.allLocks()).toEqual([]);
  });

  it("waits as blocked while someone else edits the file, then continues", async () => {
    ws.acquire("src/auth.ts", "file", BOB.id);
    const id = startRun(ALICE, "fix auth");
    await until(id, "blocked");
    expect(runOf(id).blockedOn).toEqual({ path: "src/auth.ts", holder: BOB.id });
    ws.release("src/auth.ts", BOB.id);
    await until(id, "done");
    expect(runOf(id).blockedOn).toBeUndefined();
  });

  it("the owner's own editor lock blocks their agent too", async () => {
    ws.acquire("src/auth.ts", "file", ALICE.id);
    const id = startRun(ALICE, "fix auth");
    await until(id, "blocked");
    ws.release("src/auth.ts", ALICE.id);
    await until(id, "done");
  });

  it("pause stops at the next step boundary and hands the file back; resume continues", async () => {
    const id = startRun(ALICE, "pause me");
    // Requested while planning, so it lands on the first step boundary (steps are 5 ms here).
    expect(harness.pause(id, BOB.id)).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(harness.pause(id, ALICE.id)).toEqual({ ok: true });
    await until(id, "paused");
    expect(runOf(id).nodeIndex).toBe(0);
    expect(ws.allLocks()).toEqual([]); // the owner can edit while paused
    harness.resume(id, ALICE.id);
    await until(id, "done");
  });
});
