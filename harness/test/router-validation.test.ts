import test from "node:test";
import assert from "node:assert/strict";
import { createFrozenRouter, prototypeTools, selectCandidateDags } from "../src/index.js";

const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
const labels = candidates.map(c => c.routeLabel);
for (const [name, scores, choice] of [
  ["choice contradicts scores", [0.9, 0.05, 0.05], 1],
  ["negative probability", [1.2, -0.1, -0.1], 0],
  ["incomplete vector", [0.9, 0.1], 0],
  ["unnormalised vector", [0.9, 0.8, 0.1], 0],
  ["numeric strings", ["0.9", "0.05", "0.05"], 0],
] as const) {
  test(`routing fails closed for ${name} without extra inference`, async () => {
    let calls = 0;
    const router = createFrozenRouter({ decisionsApiKey: "fixture", jevApiKey: "fixture",
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ answers: [{ name: "route",
        choice: labels[choice], confidence: 0.9,
        probabilities: scores.map((probability, i) => ({ value: labels[i], probability })),
      }] })); } });
    const result = await router.route({ task: "Implement a feature", candidates });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.probabilityMargin, null);
    assert.equal(calls, 1);
  });
}
