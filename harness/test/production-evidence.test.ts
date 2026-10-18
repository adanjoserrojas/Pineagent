import test from "node:test";
import assert from "node:assert/strict";
import { boundedEvidenceRuntime } from "../src/evidence-runtime.js";
import { javascriptLanguage } from "../src/repository-language.js";
import { executeV8Dag, prototypeTools, selectCandidateDags } from "../src/index.js";
import type { ToolRuntime } from "../src/types.js";

function runtime(files: Map<string, string>): ToolRuntime {
  return { outputLimit: 48000, events: [], listFiles: async () => [...files.keys()],
    readText: async path => { if (!files.has(path)) throw Error("Missing file"); return files.get(path)!; },
    readFiles: async paths => paths.map(path => ({ path, content: files.get(path)! })),
    searchCode: async () => [...files.keys()].map(path => ({ path, score: 1 })),
    writeFiles: async patch => { for (const f of patch) files.set(f.path, f.content); return patch.map(f => f.path); },
    runTests: async () => ({ exitCode: 0, output: "ok" }) };
}
test("complete evidence is reused within a run and oversized content is refused", async () => {
  const files = new Map([["lib/value.js", "export const value = 1"], ["large.js", "x".repeat(2000)]]);
  const base = runtime(files); let reads = 0;
  const original = base.readText;
  base.readText = async path => { reads++; return original(path); };
  const cached = boundedEvidenceRuntime(base, 1024);
  await cached.readText("lib/value.js"); await cached.readFiles(["lib/value.js"]);
  assert.equal(reads, 1);
  await assert.rejects(cached.readFiles(["large.js"]), /budget/);
});
test("Node adapter resolves CommonJS and ESM outside src without execution", () => {
  const available = new Set(["lib/a.cjs", "lib/b.js", "root.ts"]);
  assert.deepEqual(javascriptLanguage.references("lib/a.cjs", "const b = require('./b'); import root from '../root.js'", available), ["lib/b.js", "root.ts"]);
  assert.equal(javascriptLanguage.isSource("lib/a.cjs"), true);
  assert.equal(javascriptLanguage.isSource("test/a.test.js"), false);
});
test("requirements authorize bounded new-file synthesis without per-tool model calls", async () => {
  const files = new Map<string, string>(); const tools = runtime(files);
  let routes = 0, synthesis = 0;
  const result = await executeV8Dag({ trialRoot: "/unused", runtimeFactory: () => tools,
    language: javascriptLanguage, evidenceLimit: 48000,
    task: { id: "feature", prompt: "Build a greeting module and acceptance test", allowedWrites: ["greet.mjs", "test/greet.test.mjs"],
      createPaths: ["greet.mjs", "test/greet.test.mjs"], visibleTestPath: "test/greet.test.mjs", acceptanceCriteria: ["greet(name) returns Hello name"] },
    candidates: selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools }),
    router: { route: async ({ candidates }) => { routes++; return { status: "selected", candidateId: candidates[0].id }; } },
    synthesize: async ({ evidence }) => { synthesis++; assert.match(evidence, /Acceptance criteria/); return { files: [
      { path: "greet.mjs", content: "export const greet = name => `Hello ${name}`" },
      { path: "test/greet.test.mjs", content: "// acceptance" },
    ] }; } });
  assert.equal(result.execution.status, "completed");
  assert.equal(routes, 1); assert.equal(synthesis, 1); assert.equal(files.size, 2);
});
