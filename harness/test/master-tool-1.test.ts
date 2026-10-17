import test from "node:test";
import assert from "node:assert/strict";
import { selectCandidateDags } from "../src/master-tool-0.js";
import { MasterTool1Router } from "../src/master-tool-1.js";
import { prototypeTools } from "../src/registry.js";
import { createFrozenRouter } from "../src/frozen-config.js";

const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
const firstLabel = candidates[0].routeLabel;
const secondLabel = candidates[1].routeLabel;
const thirdLabel = candidates[2].routeLabel;

function probabilityVector(selected = firstLabel, selectedProbability = 0.9) {
  const remainder = (1 - selectedProbability) / 2;
  return [firstLabel, secondLabel, thirdLabel].map((value) => ({
    value,
    probability: value === selected ? selectedProbability : remainder,
  }));
}

test("Master-1 oracle requires an existing candidate", async () => {
  const router = new MasterTool1Router({ mode: "oracle" });
  await assert.rejects(
    router.route({ taskId: "x", task: "x", candidates, oracleCandidateId: "missing" }),
    /Oracle candidate missing/,
  );
});

test("Master-1 caches successful provider choices", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        answers: [{
          type: "choice",
          name: "route",
          choice: firstLabel,
          confidence: 0.9,
          probabilities: probabilityVector(),
        }],
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    };
  };
  const router = new MasterTool1Router({ mode: "openai", apiKey: "test", fetchImpl });
  const first = await router.route({ taskId: "x", task: "task", candidates });
  const second = await router.route({ taskId: "x", task: "task", candidates });
  assert.equal(first.status, "selected");
  assert.equal(second.routerMode, "cache");
  assert.equal(calls, 1);
});

test("Master-1 pauses low-confidence writes", async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      answers: [{
        type: "choice",
        name: "route",
        choice: firstLabel,
        confidence: 0.2,
        probabilities: probabilityVector(firstLabel, 0.4),
      }],
    }),
  });
  const router = new MasterTool1Router({ mode: "openai", apiKey: "test", fetchImpl });
  const result = await router.route({ taskId: "x", task: "task", candidates });
  assert.equal(result.status, "awaiting_approval");
});

test("Master-1 pauses an ambiguous top choice despite high confidence", async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      answers: [{
        type: "choice",
        name: "route",
        choice: firstLabel,
        confidence: 0.9,
        probabilities: [
          { value: firstLabel, probability: 0.45 },
          { value: secondLabel, probability: 0.44 },
          { value: thirdLabel, probability: 0.11 },
        ],
      }],
    }),
  });
  const router = new MasterTool1Router({ mode: "openai", apiKey: "test", fetchImpl });
  const result = await router.route({ taskId: "x", task: "task", candidates });
  assert.equal(result.status, "awaiting_approval");
  assert.ok(result.probabilityMargin != null && result.probabilityMargin < 0.1);
});

test("Master-1 falls back after retry exhaustion", async () => {
  let attempts = 0;
  const router = new MasterTool1Router({
    mode: "openai",
    apiKey: "test",
    retryCount: 1,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("down");
    },
    fallback: async ({ candidates: available }) => available[0].id,
  });
  const result = await router.route({ taskId: "x", task: "task", candidates });
  assert.equal(attempts, 2);
  assert.equal(result.routerMode, "llm");
  assert.equal(result.status, "selected");
});

test("Master-1 uses Jev only when Decisions is unavailable", async () => {
  const calls: string[] = [];
  const router = new MasterTool1Router({
    mode: "openai",
    apiKey: "openai-test",
    retryCount: 0,
    secondaryProvider: { mode: "jev", apiKey: "jev-test" },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("api.openai.com")) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: async () => "quota exhausted",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          answers: {
            route: {
              choice: firstLabel,
              confidence: 0.9,
              probabilities: Object.fromEntries(probabilityVector().map((item) => [item.value, item.probability])),
            },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      };
    },
  });
  const result = await router.route({ taskId: "x", task: "task", candidates });
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["api.openai.com", "jev-ai.org"]);
  assert.equal(result.routerMode, "jev");
  assert.equal(result.reasonCode, "provider-fallback:openai->jev");
  assert.equal(result.routerCalls, 2);
});

test("Master-1 does not mask a malformed Decisions response with Jev", async () => {
  let jevCalls = 0;
  const router = new MasterTool1Router({
    mode: "openai",
    apiKey: "openai-test",
    retryCount: 0,
    secondaryProvider: { mode: "jev", apiKey: "jev-test" },
    fetchImpl: async (url) => {
      if (url.includes("jev-ai.org")) jevCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ answers: [] }),
      };
    },
  });
  const result = await router.route({ taskId: "x", task: "task", candidates });
  assert.equal(jevCalls, 0);
  assert.equal(result.status, "error");
});

test("frozen factory retains V8's 0.30 margin and never uses Jev for uncertainty", async () => {
  let calls = 0;
  const router = createFrozenRouter({ decisionsApiKey: "test", jevApiKey: "test-backup",
    fetchImpl: async url => {
      calls++;
      assert.match(url, /api\.openai\.com/);
      return new Response(JSON.stringify({ answers: [{ name: "route", type: "choice", choice: firstLabel,
        confidence: 0.37, probabilities: [
          { value: firstLabel, probability: 0.58 },
          { value: secondLabel, probability: 0.35 },
          { value: thirdLabel, probability: 0.07 },
        ] }], usage: { input_tokens: 20, output_tokens: 0 } }));
    } });
  const result = await router.route({ taskId: "gap", task: "repair", candidates });
  assert.equal(router.threshold, 0);
  assert.equal(router.minMargin, 0.3);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(calls, 1);
});
