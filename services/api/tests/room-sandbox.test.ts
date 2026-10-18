import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { RoomSandbox } from "../src/sandbox/room";
import { SandboxHost } from "../src/sandbox/host";
import { BackendTools } from "../src/harness/tools";
import { executeV8Dag, selectCandidateDags, prototypeTools } from "@pineagent/harness";

it("selects pytest without a shell and fails closed on an incompatible test path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-python-runner-"));
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const commands: string[][] = [];
  const runner = new RoomSandbox(ws, { quiesce: async () => {}, ensure: async session => {
    expect(session.grants).toEqual([]); return "generation";
  }, execute: async (_session, argv) => { commands.push(argv); return { code: 5, stdout: "no tests ran", stderr: "" }; } });
  expect((await runner.runTests("alice", "py", "test_app.py", "python")).exitCode).toBe(5);
  expect((await runner.runTests("alice", "py", null, "python")).exitCode).toBe(5);
  expect(commands[0]).toEqual(["/opt/python/bin/python", "-I", "-B", "/opt/python/bin/pytest", "-q", "-p", "no:cacheprovider", "--basetemp=/tmp/pytest", "/workspace/test_app.py"]);
  expect(commands[1].at(-1)).toBe("/workspace");
  await expect(runner.runTests("alice", "py", "test/app.js", "python")).rejects.toThrow("verification language");
  expect(commands).toHaveLength(2);
});

it.runIf(Boolean(process.env.PINEAGENT_SANDBOX_IMAGE && process.env.PINEAGENT_PTY_ROOT))("cannot shadow pytest with repository code or pass with zero tests", async () => {
  const root = await mkdtemp(join(process.env.PINEAGENT_PTY_ROOT!, "python-shadow-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, "pytest.py"), "import sys\nsys.exit(0)\n");
  await writeFile(join(repo, "test_failure.py"), "def test_failure():\n    assert False, 'real test executed'\n");
  const host = new SandboxHost({ workspaceRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE!, uid: process.getuid!() });
  const runner = new RoomSandbox(new Workspace(repo, { leaseMs: 30_000, idleMs: 600_000 }), host);
  try {
    const failed = await runner.runTests("alice", "r", null, "python");
    expect(failed.exitCode, failed.output).toBe(1);
    expect(failed.output).toContain("real test executed");
    await writeFile(join(repo, "test_failure.py"), "# no tests\n");
    const empty = await runner.runTests("alice", "r", null, "python");
    expect(empty.exitCode, empty.output).toBe(5);
  } finally { await host.close(); }
}, 60_000);

it("runs verification read-only behind the workspace barrier and releases it after errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-room-sandbox-"));
  await writeFile(join(root, "value.mjs"), "old");
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const calls: string[] = [];
  const runner = new RoomSandbox(ws, {
    quiesce: async () => { calls.push("stop"); },
    ensure: async (session) => { expect(session.grants).toEqual([]); calls.push("open"); return "container"; },
    execute: async (_session, argv) => { expect(argv).toEqual(["node", "--test", "/workspace/test/value.test.mjs"]); calls.push("test"); throw new Error("deadline"); },
  });
  await expect(runner.runTests("alice", "r1", "test/value.test.mjs")).rejects.toThrow("deadline");
  expect(calls).toEqual(["stop", "open", "test", "stop"]);
  await ws.acquireSafely("value.mjs", "file", "alice");
  expect(await ws.applyOps("value.mjs", "alice", 1, [{ offset: 0, length: 3, text: "new" }])).toMatchObject({ ok: true });
});

it.runIf(Boolean(process.env.PINEAGENT_SANDBOX_IMAGE))("executes V8 through versioned backend writes and real read-only Docker verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-v8-docker-"));
  const repo = join(root, "repo");
  for (const dir of [".git", "src", "test"]) await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, "package.json"), "{}");
  await writeFile(join(repo, "src/value.mjs"), "export function value() { return 1; }");
  await writeFile(join(repo, "test/value.test.mjs"), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value(),2);");
  const ws = new Workspace(repo, { leaseMs: 30_000, idleMs: 600_000 });
  const host = new SandboxHost({ workspaceRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE! });
  const sandbox = new RoomSandbox(ws, host);
  const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
  const selected = candidates.find(candidate => candidate.routeLabel === "targeted_symbol_search")!;
  let modelCalls = 0;
  try {
    await ws.acquireRunSafely(["src/value.mjs"], "alice", "r1");
    const result = await executeV8Dag({ trialRoot: repo,
      task: { id: "r1", prompt: "Fix value() to return 2.", allowedWrites: ["src/value.mjs"], visibleTestPath: "test/value.test.mjs" },
      candidates, router: { route: async () => ({ status: "selected", candidateId: selected.id }) },
      synthesize: async () => { modelCalls++; return { files: [{ path: "src/value.mjs", content: "export function value() { return 2; }" }] }; },
      runtimeFactory: ({ allowedWrites, outputLimit }) => new BackendTools({ ws, ownerId: "alice", runId: "r1", allowedWrites, outputLimit,
        files: async () => ["package.json", "src/value.mjs", "test/value.test.mjs"],
        runTests: path => sandbox.runTests("alice", "r1", path), changed: () => {}, boundary: async () => {} }),
    });
    expect(result.execution.status).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(await ws.read("src/value.mjs")).toMatchObject({ version: 2 });
    expect(await readFile(join(repo, "src/value.mjs"), "utf8")).toContain("return 2");
  } finally { await ws.releaseRunSafely("r1"); await host.close(); }
}, 60_000);
