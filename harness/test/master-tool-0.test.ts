import test from "node:test";
import assert from "node:assert/strict";
import { selectCandidateDags } from "../src/master-tool-0.js";
import { prototypeTools } from "../src/registry.js";

test("Master-0 emits three deterministic non-redundant routes", () => {
  const first = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
  const second = selectCandidateDags({ goalCapability: "verified_change", tools: [...prototypeTools].reverse() });
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((candidate) => candidate.discoveryTool).sort(),
    ["map_repository", "run_failing_test", "search_code"],
  );
  assert.equal(new Set(first.map((candidate) => candidate.id)).size, 3);
});

test("Master-0 rejects dependency cycles", () => {
  const cyclic = [
    { name: "a", description: "a", requiredTools: ["b"], requires: [], provides: ["goal"], writes: [], maxRepeats: 1, timeoutMs: 1 },
    { name: "b", description: "b", requiredTools: ["a"], requires: [], provides: ["other"], writes: [], maxRepeats: 1, timeoutMs: 1 },
  ];
  assert.deepEqual(selectCandidateDags({ goalCapability: "goal", tools: cyclic }), []);
});

test("Master-0 rejects unordered overlapping writers", () => {
  const tools = [
    { name: "left", description: "left", requiredTools: [], requires: [], provides: ["left-cap"], writes: ["src"], maxRepeats: 1, timeoutMs: 1 },
    { name: "right", description: "right", requiredTools: [], requires: [], provides: ["right-cap"], writes: ["src/a.js"], maxRepeats: 1, timeoutMs: 1 },
    { name: "join", description: "join", requiredTools: ["left", "right"], requires: [], provides: ["goal"], writes: [], maxRepeats: 1, timeoutMs: 1 },
  ];
  assert.deepEqual(selectCandidateDags({ goalCapability: "goal", tools }), []);
});

test("Master-0 enforces its depth bound", () => {
  assert.deepEqual(
    selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools, maxDepth: 3 }),
    [],
  );
});

test("TypeScript candidates retain the frozen V8 JavaScript IDs", () => {
  const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
  assert.deepEqual(Object.fromEntries(candidates.map(candidate => [candidate.routeLabel, candidate.id])), {
    failure_first_diagnosis: "0d5e2295602567d704f9ea002fb0bc72fce013b0bd7480645cb4d5c8d0265984",
    repository_flow_mapping: "533dc927fa662381ca6cb7095d245296bd5ae750bb97720bec93545534ed6286",
    targeted_symbol_search: "934fc524005cd939a118fcb284af33d704d38e45a4fe2610863e08e500545394",
  });
});
