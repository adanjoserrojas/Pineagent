import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import type { RunEvent } from "@pineagent/core/contracts";
import { LiveHarness } from "../src/harness/controller";
import { ModelFailure } from "../src/models/bedrock";

it("attributes a rejected patch to synthesis, not the last completed search, and counts the failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-patch-error-"));
  const files = { "app.py": "def value(): return 1", "test_app.py": "from app import value" };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  let receipt: Record<string, unknown> | undefined;
  const harness = new LiveHarness({ context: { ws, roomId: "r", files: async () => Object.keys(files),
    events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => ({ plan: async () => ({ allowedWrites: ["app.py"], visibleTestPath: "test_app.py" }),
      patch: async () => { throw new ModelFailure("MODEL_INVALID_JSON"); } }),
    router: () => ({ route: async ({ candidates }) => ({ status: "selected", candidateId: candidates.find(c => c.routeLabel === "targeted_symbol_search")!.id }) }),
    runTests: async () => { throw Error("Verification must not run"); }, receipt: (_id, result) => { receipt = result; },
  });
  try {
    harness.start({ id: "alice", name: "Alice" }, "Fix value().");
    await expect.poll(() => harness.list()[0].state).toBe("error");
    const view = harness.list()[0];
    expect(view.steps[view.error!.nodeIndex].tool).toBe("edit_code");
    expect(view.error?.message).toContain("invalid JSON");
    expect(receipt).toMatchObject({ executorModelCalls: 1, failureCode: "MODEL_INVALID_JSON", failurePhase: "synthesis" });
    expect(await ws.read("app.py")).toMatchObject({ content: files["app.py"], version: 1 });
    expect(ws.allLocks()).toEqual([]);
  } finally { await harness.close(); }
});

async function setup(routeStatus: "selected" | "awaiting_approval" = "selected") {
  const root = await mkdtemp(join(tmpdir(), "pineagent-control-"));
  for (const dir of ["src", "test"]) await mkdir(join(root, dir));
  const files = { "src/value.mjs": "export function value() { return 1; }", "test/value.test.mjs": "import { value } from '../src/value.mjs';", "package.json": "{}" };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  let patches = 0;
  const recoveries: boolean[] = [];
  const harness = new LiveHarness({
    context: { ws, roomId: "room", files: async () => Object.keys(files), events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => ({ plan: async () => ({ allowedWrites: ["src/value.mjs"], visibleTestPath: "test/value.test.mjs" }),
      patch: async (_input, _signal, recovery) => { patches++; recoveries.push(Boolean(recovery)); return { files: [{ path: "src/value.mjs", content: `export function value() { return ${patches + 1}; }` }] }; } }),
    router: () => ({ route: async ({ candidates }) => ({ status: routeStatus, candidateId: candidates.find(c => c.routeLabel === "targeted_symbol_search")!.id, routerMode: "openai" }) }),
    runTests: async () => ({ exitCode: patches < 2 ? 1 : 0, output: "verification" }),
  });
  return { ws, harness, recoveries, count: () => patches };
}

it("pauses uncertain routes without synthesis, rejects foreign approval, then uses bounded warm recovery", async () => {
  const { ws, harness, recoveries, count } = await setup("awaiting_approval");
  try {
    const started = harness.start({ id: "alice", name: "Alice" }, "Fix value().");
    if (!started.ok) throw new Error("not started");
    await expect.poll(() => harness.list()[0].state).toBe("awaiting_approval");
    expect(count()).toBe(0);
    expect(ws.allLocks()).toEqual([]);
    const choice = harness.list()[0].candidates![0].id;
    expect(harness.approve(started.runId, "bob", { candidateId: choice })).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(harness.approve(started.runId, "alice", { candidateId: choice })).toEqual({ ok: true });
    await expect.poll(() => harness.list()[0].state).toBe("done");
    expect(recoveries).toEqual([false, true]);
    expect(harness.list()[0]).toMatchObject({ routerMode: "openai", codingRecovery: "warm_agent" });
    expect(ws.allLocks()).toEqual([]);
  } finally { await harness.close(); }
});

it("stops stale approval instead of writing over a collaborator's intervening edit", async () => {
  const { ws, harness, count } = await setup("awaiting_approval");
  try {
    const started = harness.start({ id: "alice", name: "Alice" }, "Fix value().");
    if (!started.ok) throw new Error("not started");
    await expect.poll(() => harness.list()[0].state).toBe("awaiting_approval");
    await ws.acquireSafely("src/value.mjs", "file", "bob");
    await ws.applyOps("src/value.mjs", "bob", 1, [{ offset: 0, length: 0, text: "// changed\n" }]);
    await ws.releaseSafely("src/value.mjs", "bob");
    harness.approve(started.runId, "alice", { candidateId: harness.list()[0].candidates![0].id });
    await expect.poll(() => harness.list()[0].state).toBe("error");
    expect(count()).toBe(0);
    expect((await ws.read("src/value.mjs"))?.content).toContain("// changed");
  } finally { await harness.close(); }
});

it("pauses a blocked run before its conflicting lock is released and resumes only as owner", async () => {
  const { ws, harness } = await setup();
  await ws.acquireSafely("src/value.mjs", "file", "bob");
  try {
    const started = harness.start({ id: "alice", name: "Alice" }, "Fix value().");
    if (!started.ok) throw new Error("not started");
    await expect.poll(() => harness.list()[0].state).toBe("blocked");
    expect(harness.pause(started.runId, "alice")).toEqual({ ok: true });
    await expect.poll(() => harness.list()[0].state).toBe("paused");
    expect(harness.resume(started.runId, "bob")).toEqual({ ok: false, code: "NOT_OWNER" });
    await ws.releaseSafely("src/value.mjs", "bob");
    expect(harness.resume(started.runId, "alice")).toEqual({ ok: true });
    await expect.poll(() => harness.list()[0].state).toBe("done");
  } finally { await harness.close(); }
});

it("contains provider initialization failures inside the run lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-init-"));
  const harness = new LiveHarness({ context: { ws: new Workspace(root, { leaseMs: 1000, idleMs: 1000 }), roomId: "room",
    files: async () => [], events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => { throw new Error("configuration"); }, router: () => { throw new Error("unused"); },
    runTests: async () => ({ exitCode: 0, output: "" }) });
  harness.start({ id: "alice", name: "Alice" }, "Fix value().");
  await expect.poll(() => harness.list()[0].state).toBe("error");
  await harness.close();
});

it("runs the frozen DAG as the authenticated owner and publishes monotonic workspace events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-live-"));
  for (const path of ["src", "test"]) await mkdir(join(root, path));
  const files = { "src/value.mjs": "export function value() { return 1; }", "test/value.test.mjs": "import { value } from '../src/value.mjs';", "package.json": "{}" };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const events: RunEvent[] = [];
  const receipts: Record<string, unknown>[] = [];
  let patches = 0;
  const harness = new LiveHarness({
    context: { ws, roomId: "room", files: async () => Object.keys(files), events: { run: event => { events.push(event); }, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => ({ plan: async () => ({ allowedWrites: ["src/value.mjs"], visibleTestPath: "test/value.test.mjs" }),
      patch: async () => { patches++; return { files: [{ path: "src/value.mjs", content: "export function value() { return 2; }" }] }; } }),
    router: () => ({ route: async ({ candidates }) => ({ status: "selected", candidateId: candidates.find(c => c.routeLabel === "targeted_symbol_search")!.id, routerMode: "openai" }) }),
    runTests: async () => ({ exitCode: 0, output: "pass" }),
    receipt: (_id, result) => { receipts.push(result); },
  });
  try {
    const started = harness.start({ id: "alice", name: "Alice" }, "Fix value().");
    expect(started.ok).toBe(true);
    await expect.poll(() => harness.list()[0].state).toBe("done");
    expect(harness.list()[0].ownerId).toBe("alice");
    expect(patches).toBe(1);
    expect(await ws.read("src/value.mjs")).toMatchObject({ version: 2 });
    expect(ws.allLocks()).toEqual([]);
    expect(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq)).toBe(true);
  } finally { await harness.close(); }
  expect(receipts).toMatchObject([{ modelCalls: 2, executorModelCalls: 1, status: "done" }]);
});
