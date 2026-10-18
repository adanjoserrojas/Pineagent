import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { LiveHarness } from "../src/harness/controller";
import { collectV8Recovery, executeV8Dag, prototypeTools, selectCandidateDags } from "@pineagent/harness";
import { pythonLanguage, languageForPlan } from "../src/harness/python";
import { BackendTools } from "../src/harness/tools";

it("reads root-level Python imports and patches through the unchanged selected DAG", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-python-"));
  const files = { "app.py": "from storage import load_tasks\ndef get_tasks():\n    return load_tasks()\n",
    "storage.py": "def load_tasks():\n    return []\n", "test_app.py": "from app import get_tasks\ndef test_tasks():\n    assert get_tasks() == []\n",
    "requirements.txt": "flask>=3.0\npytest>=8.0\n" };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  let evidence = "", calls = 0;
  const harness = new LiveHarness({
    context: { ws, roomId: "python", files: async () => Object.keys(files), events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => ({ plan: async () => ({ allowedWrites: ["app.py"], visibleTestPath: "test_app.py" }),
      patch: async input => { evidence = input.evidence; calls++; return { files: [{ path: "app.py", content: files["app.py"] + "# validated\n" }] }; } }),
    router: () => ({ route: async ({ candidates }) => ({ status: "selected", candidateId: candidates.find(c => c.routeLabel === "targeted_symbol_search")!.id }) }),
    runTests: async (_owner, _run, _path, validator) => { expect(validator).toBe("python"); return { exitCode: 0, output: "3 passed" }; },
  });
  try {
    expect(harness.start({ id: "alice", name: "Alice" }, "Fix get_tasks().").ok).toBe(true);
    await expect.poll(() => harness.list()[0].state).toBe("done");
    expect(evidence).toContain("FILE storage.py\n");
    expect(evidence).toContain("FILE test_app.py\n");
    expect(evidence).toContain("FILE requirements.txt\n");
    expect(evidence).not.toContain("FILE package.json\n");
    expect(calls).toBe(1);
    expect(await ws.read("app.py")).toMatchObject({ version: 2 });
    expect(ws.allLocks()).toEqual([]);
  } finally { await harness.close(); }
});

it("keeps bounded Python recovery read-only and retains the approval gate after reassessment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-python-gate-"));
  const files = { "app.py": "from storage import load_tasks\ndef get_tasks():\n    return load_tasks()\n",
    "storage.py": "def load_tasks():\n    return []\n", "test_app.py": "from app import get_tasks\n", "requirements.txt": "pytest\n" };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const task = { id: "py", prompt: "Fix get_tasks().", allowedWrites: ["app.py"], visibleTestPath: "test_app.py" };
  const runtimeFactory = ({ allowedWrites, outputLimit }: { allowedWrites: string[]; outputLimit: number }) => new BackendTools({ ws,
    ownerId: "alice", runId: "py", allowedWrites, outputLimit, files: async () => Object.keys(files),
    changed: () => { throw Error("Unexpected write"); }, boundary: async () => {}, runTests: async () => { throw Error("Read-only recovery ran tests"); } });
  const options = { trialRoot: root, task, runtimeFactory, language: pythonLanguage };
  const recovery = await collectV8Recovery(options);
  expect(recovery.sufficient).toBe(true);
  expect(recovery.files).toEqual(["test_app.py", "app.py", "storage.py", "requirements.txt"]);
  expect(recovery.nodeEvents.every(e => ["list_files", "read_files"].includes(e.name))).toBe(true);
  const limited = await collectV8Recovery({ ...options, limits: { maxFiles: 1, maxChars: 24000, maxMs: 10000 } });
  expect(limited.sufficient).toBe(false);
  expect(limited.budgetReason).toBe("file_limit");
  let routes = 0;
  const result = await executeV8Dag({ ...options, candidates: selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools }),
    router: { route: async () => { routes++; return { status: "awaiting_approval", candidateId: null }; } },
    synthesize: async () => { throw Error("Synthesis before approval"); }, fallbackAgent: async () => { throw Error("Fallback before approval"); } });
  expect(routes).toBe(2);
  expect(result.execution).toMatchObject({ status: "awaiting_approval", modelCalls: 0, pauseReason: "reassessment_below_gate", changedPaths: [] });
  expect(await ws.read("app.py")).toMatchObject({ version: 1, content: files["app.py"] });
});

it("resolves package imports statically and rejects unsupported or mixed-language plans", () => {
  const available = new Set(["pkg/__init__.py", "pkg/app.py", "pkg/storage.py", "src/shared.py", "external.py"]);
  expect(pythonLanguage.references("pkg/app.py", "from . import storage\nfrom src import shared\nimport os, external as e\n", available))
    .toEqual(["external.py", "pkg/__init__.py", "pkg/storage.py", "src/shared.py"]);
  expect(pythonLanguage.references("pkg/app.py", "from ... import external\nimportlib.import_module('external')", available)).toEqual([]);
  expect(languageForPlan({ visibleTestPath: "test_app.py", allowedWrites: ["app.py"] })).toBe(pythonLanguage);
  expect(languageForPlan({ visibleTestPath: "test/app.test.mjs", allowedWrites: ["src/app.mjs"] })).toBeUndefined();
  for (const plan of [
    { visibleTestPath: "test_app.py", allowedWrites: ["app.js"] },
    { visibleTestPath: "test_app.py", allowedWrites: ["test_storage.py"] },
    { visibleTestPath: "app.py", allowedWrites: ["storage.py"] },
    { visibleTestPath: "test.rb", allowedWrites: ["app.rb"] },
  ]) expect(() => languageForPlan(plan)).toThrow();
});
