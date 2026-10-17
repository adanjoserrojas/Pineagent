import type { TestContext } from "node:test";
import type { RouteDecision, RouteRequest } from "../src/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectV8Recovery, executeV8Dag } from "../src/v8-executor.js";
import { selectCandidateDags } from "../src/master-tool-0.js";
import { prototypeTools } from "../src/registry.js";

const candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
const targeted = candidates.find(item => item.routeLabel === "targeted_symbol_search")!;
const selected: RouteDecision = { status: "selected", candidateId: targeted.id, probabilityMargin: 0.8 };
const uncertain: RouteDecision = { status: "awaiting_approval", candidateId: targeted.id, probabilityMargin: 0.16 };

async function fixture(t: TestContext) {
  const trialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pear-v8-unit-"));
  t.after(() => fs.rm(trialRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(trialRoot, "src"));
  await fs.mkdir(path.join(trialRoot, "test"));
  await fs.writeFile(path.join(trialRoot, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(trialRoot, "src/value.mjs"), "export function value(){return 0;}\n");
  await fs.writeFile(path.join(trialRoot, "test/value.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; const {value}=await import(new URL("../src/value.mjs",import.meta.url)); test("value",()=>assert.equal(value(),1));\n');
  return { trialRoot, task: { id: "value", prompt: "Repair value().", visibleTestPath: "test/value.test.mjs", allowedWrites: ["src/"] } };
}

function routerWith(...answers: RouteDecision[]) {
  const calls: RouteRequest[] = [];
  return { calls, route: async (input: RouteRequest) => { calls.push(input); assert.ok(answers.length, "extra routing call"); return answers.shift()!; } };
}
const patch = async () => ({ files: [{ path: "src/value.mjs", content: "export function value(){return 1;}\n" }],
  usage: { inputTokens: 100, outputTokens: 20 }, model: "fake", wallMs: 1 });

test("uncertainty reads once, reassesses once, and reuses evidence in one synthesis", async t => {
  const setup = await fixture(t), router = routerWith(uncertain, selected);
  let synthesisCalls = 0;
  const { execution } = await executeV8Dag({ ...setup, router, candidates, history: {}, synthesize: async input => {
    synthesisCalls++;
    assert.match(input.evidence, /BOUNDED READ-ONLY RECOVERY/);
    assert.match(router.calls[1].task, /export function value/);
    assert.equal(await fs.readFile(path.join(setup.trialRoot, "src/value.mjs"), "utf8"), "export function value(){return 0;}\n");
    return patch();
  } });
  assert.equal(execution.status, "completed");
  assert.equal(router.calls.length, 2);
  assert.equal(synthesisCalls, 1);
  assert.equal(execution.recovery!.sufficient, true);
  assert.equal(execution.writeGate!.evidenceSufficient, true);
  assert.ok(execution.recovery!.nodeEvents.every(event => ["list_files", "read_files"].includes(event.name)));
});

test("reassessment below the same gate never synthesizes or falls back", async t => {
  const setup = await fixture(t), router = routerWith(uncertain, uncertain);
  const before = await fs.readFile(path.join(setup.trialRoot, "src/value.mjs"), "utf8");
  const forbidden = async () => assert.fail("writing path reached");
  const { execution } = await executeV8Dag({ ...setup, router, candidates, synthesize: forbidden, fallbackAgent: forbidden });
  assert.equal(execution.status, "awaiting_approval");
  assert.equal(execution.pauseReason, "reassessment_below_gate");
  assert.equal(router.calls.length, 2);
  assert.deepEqual(execution.changedPaths, []);
  assert.equal(await fs.readFile(path.join(setup.trialRoot, "src/value.mjs"), "utf8"), before);
});

test("file budget exhaustion pauses without a reassessment or a write", async t => {
  const setup = await fixture(t), router = routerWith(uncertain);
  const { execution } = await executeV8Dag({ ...setup, router, candidates,
    limits: { maxFiles: 1, maxChars: 24000, maxMs: 10000 }, synthesize: async () => assert.fail("synthesis reached") });
  assert.equal(execution.pauseReason, "recovery_evidence_insufficient");
  assert.equal(execution.recovery!.fileCount, 1);
  assert.equal(execution.recovery!.budgetReason, "file_limit");
  assert.equal(router.calls.length, 1);
});

test("text budget exhaustion does not use truncated source as permission", async t => {
  const setup = await fixture(t), router = routerWith(uncertain);
  const { execution } = await executeV8Dag({ ...setup, router, candidates,
    limits: { maxFiles: 12, maxChars: 25, maxMs: 10000 }, synthesize: async () => assert.fail("synthesis reached") });
  assert.equal(execution.status, "awaiting_approval");
  assert.ok(execution.recovery!.chars <= 25);
  assert.equal(router.calls.length, 1);
});

test("missing evidence pauses even when no source was found", async t => {
  const setup = await fixture(t), router = routerWith(uncertain);
  await fs.rm(path.join(setup.trialRoot, "src/value.mjs"));
  const { execution } = await executeV8Dag({ ...setup, router, candidates, synthesize: async () => assert.fail("synthesis reached") });
  assert.equal(execution.status, "awaiting_approval");
  assert.ok(execution.recovery!.reasons.includes("no_complete_source"));
});

test("a selected initial route keeps one router call and one synthesis", async t => {
  const setup = await fixture(t), router = routerWith(selected);
  const { execution } = await executeV8Dag({ ...setup, router, candidates, synthesize: patch });
  assert.equal(execution.status, "completed");
  assert.equal(router.calls.length, 1);
  assert.equal(execution.recovery, null);
});

test("router unavailability cannot reach a writing fallback", async t => {
  const setup = await fixture(t), router = routerWith({ status: "error", candidateId: null });
  const { execution } = await executeV8Dag({ ...setup, router, candidates, synthesize: async () => assert.fail("synthesis reached") });
  assert.equal(execution.pauseReason, "router_unavailable");
  assert.equal(execution.recovery, null);
});

test("recovery follows CommonJS dependencies without executing repository code", async t => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.trialRoot, "src/helper.cjs"), "module.exports=1;\n");
  await fs.writeFile(path.join(setup.trialRoot, "src/value.mjs"), 'const x=require("./helper.cjs"); export function value(){return x;}\n');
  const recovery = await collectV8Recovery(setup);
  assert.ok(recovery.files.includes("src/helper.cjs"));
  assert.equal(recovery.sufficient, true);
  assert.ok(recovery.nodeEvents.every(event => event.name !== "run_tests"));
});

test("limits cannot exceed the frozen recovery envelope", async t => {
  const setup = await fixture(t);
  await assert.rejects(collectV8Recovery({ ...setup, limits: { maxFiles: 13, maxChars: 24000, maxMs: 10000 } }), /Invalid recovery limit/);
});

test("an approved broad route without source evidence still pauses before synthesis", async t => {
  const setup = await fixture(t);
  const broad = candidates.find(item => item.routeLabel === "repository_flow_mapping")!;
  const router = routerWith({ ...selected, candidateId: broad.id });
  // V7's broad collector cannot follow new URL; the V8 writing guard catches it.
  const { execution } = await executeV8Dag({ ...setup, task: { ...setup.task, prompt: "Repair the operation demonstrated by the visible test." },
    router, candidates, synthesize: async () => assert.fail("synthesis without source") });
  assert.equal(execution.status, "awaiting_approval");
  assert.equal(execution.pauseReason, "write_evidence_insufficient");
});

test("a recovered execution passes its evidence into a warm fallback", async t => {
  const setup = await fixture(t), router = routerWith(uncertain, selected);
  let seen = false;
  const { execution } = await executeV8Dag({ ...setup, router, candidates,
    synthesize: async () => ({ files: [] }), fallbackAgent: async ({ evidencePacket }) => {
      seen = evidencePacket.includes("BOUNDED READ-ONLY RECOVERY");
      await fs.writeFile(path.join(setup.trialRoot, "src/value.mjs"), "export function value(){return 1;}\n");
      return { modelCalls: 1 };
    } });
  assert.equal(execution.status, "completed_via_fallback");
  assert.equal(seen, true);
});
