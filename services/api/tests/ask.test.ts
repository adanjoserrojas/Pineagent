import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { LiveHarness } from "../src/harness/controller";
import { OpusRun } from "../src/models/bedrock";
import { readQuestionEvidence } from "../src/harness/ask";

it("answers through authenticated, bounded reads without routing, locks, patches or tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-ask-"));
  const files = { "README.md": "A Flask notes app.", "app.py": "print('hello')", ".env": "NEVER_SEND_ENV", "credentials.json": "NEVER_SEND_CREDENTIALS" };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  let calls = 0, checks = 0;
  let receipt: Record<string, unknown> | undefined;
  const unexpected = () => { throw new Error("Ask must not use coding capabilities"); };
  const model = new OpusRun({ runId: "read-only", ownerId: "alice", transport: async input => {
    calls++;
    const prompt = JSON.stringify(input);
    expect(prompt).toContain("A Flask notes app");
    expect(prompt).not.toContain("NEVER_SEND");
    expect(input.system?.[0].text).toContain("read-only");
    return { $metadata: {}, stream: (async function* () {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"answer":"This is a Flask notes app. I have not changed any files."}' } } };
      yield { messageStop: { stopReason: "end_turn" } };
    })() };
  } });
  const harness = new LiveHarness({ context: { ws, roomId: "r", files: async () => Object.keys(files),
    canWrite: async () => { checks++; return true; },
    events: { run: () => {}, lockChanged: unexpected, fileChanged: unexpected } },
    model: () => model, router: unexpected, runTests: unexpected,
    receipt: (_id, result) => { receipt = result; } });
  try {
    expect(harness.start({ id: "alice", name: "Alice" }, "What is this repo? Also modify app.py", "ask").ok).toBe(true);
    await expect.poll(() => harness.list()[0].state).toBe("done");
    expect(harness.list()[0]).toMatchObject({ mode: "ask", answer: "This is a Flask notes app. I have not changed any files.", writeSet: [], routerMode: null,
      evidencePaths: ["README.md", "app.py"] });
    expect(receipt).toMatchObject({ mode: "ask", modelCalls: 1, executorModelCalls: 0 });
    expect(model.receipts()).toMatchObject([{ purpose: "answer", status: "ok" }]);
    expect(calls).toBe(1);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(ws.allLocks()).toEqual([]);
    for (const [path, content] of Object.entries(files)) expect(await ws.read(path)).toMatchObject({ content, version: 1 });
  } finally { await harness.close(); }
});

it.each(["permission", "version"])("does not publish an answer after %s changes", async kind => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-ask-stale-"));
  await writeFile(join(root, "README.md"), "Original");
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  let allowed = true;
  const unexpected = () => { throw new Error("Must not use coding tools"); };
  const harness = new LiveHarness({ context: { ws, roomId: "r", files: async () => ["README.md"], canWrite: async () => allowed,
    events: { run: () => {}, lockChanged: unexpected, fileChanged: unexpected } },
    model: () => ({ plan: unexpected, patch: unexpected, answer: async () => {
      if (kind === "permission") allowed = false;
      else {
        await ws.acquireSafely("README.md", "file", "bob");
        await ws.applyOps("README.md", "bob", 1, [{ offset: 0, length: 0, text: "Changed " }]);
        await ws.releaseSafely("README.md", "bob");
      }
      return "Stale answer";
    } }), router: unexpected, runTests: unexpected });
  try {
    expect(harness.start({ id: "alice", name: "Alice" }, "question", "invalid")).toEqual({ ok: false, code: "BAD_REQUEST" });
    const start = harness.start({ id: "alice", name: "Alice" }, "question", "ask");
    if (!start.ok) throw Error("not started");
    expect(harness.pause(start.runId, "alice")).toEqual({ ok: false, code: "NOT_WAITING" });
    await expect.poll(() => harness.list()[0].state).toBe("error");
    expect(harness.list()[0].answer).toBeUndefined();
    expect(harness.list()[0].error?.code).toBe(kind === "permission" ? "ACCESS_DENIED" : "STALE_EVIDENCE");
  } finally { await harness.close(); }
});

it("caps repository question evidence and excludes hidden/generated and credential paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-ask-bounds-"));
  const files = Array.from({ length: 20 }, (_, i) => `source${i}.py`);
  for (const path of files) await writeFile(join(root, path), "x".repeat(10000));
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  const result = await readQuestionEvidence({ ws, roomId: "r", files: async () => [
    ...files, ".env", "keys/private-key.json", "node_modules/x.js", "dist/generated.js", ".hidden/x.py", "credentials.json",
  ], events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } }, "What is this?", async () => {});
  const data = JSON.parse(result.evidence);
  expect(data.files).toHaveLength(4);
  expect(data.files.every((file: { truncated: boolean }) => file.truncated)).toBe(true);
  expect(data.files.reduce((sum: number, file: { content: string }) => sum + file.content.length, 0)).toBe(24000);
  expect(result.paths.every(path => files.includes(path))).toBe(true);
});
