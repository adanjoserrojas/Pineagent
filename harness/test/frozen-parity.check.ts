/** Optional transfer verification against the owner's original frozen source, never a live API benchmark. */
import type { TestContext } from "node:test";
import type { ExecutionResult, RouteDecision, RouteRequest } from "../src/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { prototypeTools } from "../src/registry.js";
import { selectCandidateDags } from "../src/master-tool-0.js";
import { MasterTool1Router } from "../src/master-tool-1.js";
import { executeV8Dag } from "../src/v8-executor.js";
import { FROZEN_HISTORY } from "../src/frozen-config.js";

const referenceRoot = process.env.FROZEN_JS_REFERENCE;
if (!referenceRoot) throw new Error("Set FROZEN_JS_REFERENCE to the original Pear/harness directory; no network access is required.");
const source = (file: string) => path.join(referenceRoot, file);
const original0 = await import(pathToFileURL(source("src/master-tool-0.mjs")).href) as typeof import("../src/master-tool-0.js");
const original1 = await import(pathToFileURL(source("src/master-tool-1.mjs")).href) as typeof import("../src/master-tool-1.js");
const original8 = await import(pathToFileURL(source("src/v8-executor.mjs")).href) as typeof import("../src/v8-executor.js");
const originalRegistry = await import(pathToFileURL(source("src/registry.mjs")).href) as typeof import("../src/registry.js");
const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
const targeted = candidates.find(candidate => candidate.routeLabel === "targeted_symbol_search")!;
const selected: RouteDecision = { candidateId: targeted.id, status: "selected", probabilityMargin: 0.8 };
const uncertain: RouteDecision = { ...selected, status: "awaiting_approval", probabilityMargin: 0.1 };

test("original reference files still match the V8 freeze-review hashes", async () => {
  const manifest = JSON.parse(await fs.readFile(source("V8_FREEZE_CANDIDATE.json"), "utf8")) as { sourceHashes: Record<string, string> };
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    assert.equal(createHash("sha256").update(await fs.readFile(source(file))).digest("hex"), expected, file);
  }
});

test("Master-0 registry, full candidates and frozen history match the original", async () => {
  assert.deepEqual(prototypeTools, originalRegistry.prototypeTools);
  assert.deepEqual(candidates, original0.selectCandidateDags({ goalCapability: "verified_change", tools: originalRegistry.prototypeTools }));
  const history = JSON.parse(await fs.readFile(source("benchmarks/V4_ROUTE_HISTORY.json"), "utf8"));
  assert.deepEqual(FROZEN_HISTORY.global, history.global);
  assert.deepEqual(FROZEN_HISTORY.byShape, history.byShape);
});

test("Master-1 preserves selected, ambiguous and malformed-response outcomes", async () => {
  for (const probabilities of [[0.9, 0.06, 0.04], [0.49, 0.48, 0.03], null]) {
    const run = async (RouterClass: typeof MasterTool1Router) => {
      const router = new RouterClass({ mode: "openai", apiKey: "fake", retryCount: 0,
        threshold: 0, minMargin: 0.3, cacheTtlMs: 0,
        fetchImpl: async () => new Response(JSON.stringify({ answers: probabilities ? [{
          type: "choice", name: "route", choice: candidates[0].routeLabel, confidence: 0.9,
          probabilities: candidates.map((candidate, i) => ({ value: candidate.routeLabel, probability: probabilities[i] })),
        }] : [] })) });
      const result = await router.route({ taskId: "parity", task: "Repair value().", candidates });
      const { routerMs, ...stable } = result;
      return stable;
    };
    assert.deepEqual(await run(MasterTool1Router), await run(original1.MasterTool1Router));
  }
});

async function exercise(t: TestContext, execute: typeof executeV8Dag, scenario: string) {
  const trialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pineagent-reference-"));
  t.after(() => fs.rm(trialRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(trialRoot, "src"));
  await fs.mkdir(path.join(trialRoot, "test"));
  await fs.writeFile(path.join(trialRoot, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(trialRoot, "src/value.mjs"), "export function value(){return 0;}\n");
  await fs.writeFile(path.join(trialRoot, "test/value.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import {value} from "../src/value.mjs"; test("value",()=>assert.equal(value(),1));\n');
  const decisions = scenario === "recovered" ? [uncertain, selected]
    : scenario === "persistent_uncertainty" ? [uncertain, uncertain]
    : scenario === "exhausted" ? [uncertain] : [selected];
  const routingInputs: RouteRequest[] = [], synthesisInputs: unknown[] = [];
  const result = await execute({ trialRoot, task: { id: "parity", prompt: "Repair value().", allowedWrites: ["src/"], visibleTestPath: "test/value.test.mjs" },
    candidates, history: FROZEN_HISTORY,
    router: { route: async input => { routingInputs.push(input); assert.ok(decisions.length); return decisions.shift()!; } },
    ...(scenario === "exhausted" ? { limits: { maxFiles: 1, maxChars: 24000, maxMs: 10000 } } : {}),
    synthesize: async input => { synthesisInputs.push(input); return { files: [{ path: "src/value.mjs", content: "export function value(){return 1;}\n" }] }; } });
  const execution: ExecutionResult = result.execution;
  const stableEvents = (events: ExecutionResult["nodeEvents"]) => events?.map(({ ms, ...event }) => event);
  const { wallMs, nodeEvents, fullTest, initialVerification, recovery, model, ...stable } = execution;
  const stableRecovery = recovery ? (({ wallMs, nodeEvents, ...rest }) => ({ ...rest, nodeEvents: stableEvents(nodeEvents) }))(recovery) : recovery;
  return { route: result.route, execution: { ...stable, nodeEvents: stableEvents(nodeEvents), recovery: stableRecovery,
    fullTest: fullTest?.exitCode, initialVerification: initialVerification?.exitCode, model: model ? { usage: model.usage, model: model.model } : model },
    routingInputs, synthesisInputs, finalFile: await fs.readFile(path.join(trialRoot, "src/value.mjs"), "utf8") };
}

for (const scenario of ["selected", "recovered", "persistent_uncertainty", "exhausted"]) {
  test(`V8 JavaScript/TypeScript behavioral parity: ${scenario}`, async t => {
    assert.deepEqual(await exercise(t, executeV8Dag, scenario), await exercise(t, original8.executeV8Dag, scenario));
  });
}
