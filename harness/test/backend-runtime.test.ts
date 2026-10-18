import test from "node:test";
import assert from "node:assert/strict";
import { executeV8Dag, selectCandidateDags, prototypeTools, type ToolRuntimeFactory } from "../src/index.js";

test("injected backend owns every read, write and test without adding inference", async () => {
  const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
  const selected = candidates.find(c => c.routeLabel === "targeted_symbol_search")!;
  const files = new Map([
    ["src/value.mjs", "export function value() { return 1; }"],
    ["test/value.test.mjs", "import { value } from '../src/value.mjs';"],
    ["package.json", "{}"],
  ]);
  let models = 0, tests = 0, writes = 0;
  const runtimeFactory: ToolRuntimeFactory = ({ outputLimit }) => ({
    outputLimit, events: [],
    listFiles: async () => [...files.keys()],
    searchCode: async () => [{ path: "src/value.mjs", score: 1 }],
    readText: async path => { const text = files.get(path); assert.ok(text); return text; },
    readFiles: async paths => paths.filter(p => files.has(p)).map(path => ({ path, content: files.get(path)! })),
    writeFiles: async patch => { writes++; for (const file of patch) files.set(file.path, file.content); return patch.map(f => f.path); },
    runTests: async () => { tests++; return { exitCode: 0, output: "pass" }; },
  });
  const result = await executeV8Dag({
    trialRoot: "/does-not-exist/backend-owned", runtimeFactory,
    task: { id: "adapter", prompt: "Fix value().", allowedWrites: ["src/value.mjs"], visibleTestPath: "test/value.test.mjs" },
    candidates, router: { route: async () => ({ status: "selected", candidateId: selected.id, probabilityMargin: 0.9 }) },
    synthesize: async () => { models++; return { files: [{ path: "src/value.mjs", content: "export function value() { return 2; }" }] }; },
  });
  assert.equal(result.execution.status, "completed");
  assert.equal(models, 1);
  assert.equal(writes, 1);
  assert.equal(tests, 1);
  assert.equal(result.route.candidateId, selected.id);
  assert.deepEqual(result.execution.executedRoutes, ["targeted_symbol_search"]);
});
