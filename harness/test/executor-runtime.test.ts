import type { TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SandboxToolRuntime } from "../src/sandbox-tools.js";
import { executeV7Dag } from "../src/v7-executor.js";
import { selectCandidateDags } from "../src/master-tool-0.js";
import { prototypeTools } from "../src/registry.js";
import { benchmarkEnvironment } from "../src/benchmark-environment.js";

const targeted = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools })
  .find(candidate => candidate.routeLabel === "targeted_symbol_search")!;

async function fixture(t: TestContext) {
  const trialRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pineagent-executor-"));
  t.after(() => fs.rm(trialRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(trialRoot, "src"));
  await fs.mkdir(path.join(trialRoot, "test"));
  await fs.writeFile(path.join(trialRoot, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(trialRoot, "src/value.mjs"), "export function value(){return 0;}\n");
  await fs.writeFile(path.join(trialRoot, "test/value.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import {value} from "../src/value.mjs"; test("value",()=>assert.equal(value(),1));\n');
  return { trialRoot, task: { id: "value", prompt: "Repair value().", visibleTestPath: "test/value.test.mjs", allowedWrites: ["src/"] } };
}

test("sandbox rejects traversal and writes outside the declared write set", async t => {
  const { trialRoot } = await fixture(t);
  const runtime = new SandboxToolRuntime({ root: trialRoot, allowedWrites: ["src/"] });
  for (const file of ["../escaped.mjs", "src/../../escaped.mjs", "test/value.test.mjs", "src-other/value.mjs"]) {
    await assert.rejects(runtime.writeFiles([{ path: file, content: "invalid" }]), /Unsafe relative path|Write outside scope/);
  }
  assert.equal(await fs.readFile(path.join(trialRoot, "src/value.mjs"), "utf8"), "export function value(){return 0;}\n");
  assert.ok(runtime.events.every(event => event.status === "error"));
});

test("cross-file discovery expands deterministically before one synthesis", async t => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.trialRoot, "src/value.mjs"), 'import {core} from "./helper.mjs"; export function value(){return core();}\n');
  await fs.writeFile(path.join(setup.trialRoot, "src/helper.mjs"), "export function core(){return 0;}\n");
  let calls = 0;
  const result = await executeV7Dag({ ...setup, candidate: targeted,
    synthesize: async ({ evidence }) => {
      calls++;
      assert.match(evidence, /FILE src\/helper\.mjs/);
      return { files: [{ path: "src/helper.mjs", content: "export function core(){return 1;}\n" }] };
    } });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executedRoutes, ["targeted_symbol_search", "repository_flow_mapping"]);
  assert.equal(calls, 1);
  assert.equal(result.modelCalls, 1);
});

test("failed patch fallback receives current files and failure evidence without restarting discovery", async t => {
  const setup = await fixture(t);
  let fallbackCalls = 0;
  const result = await executeV7Dag({ ...setup, candidate: targeted,
    synthesize: async () => ({ files: [{ path: "src/value.mjs", content: "export function value(){return 2;}\n" }] }),
    fallbackAgent: async ({ evidencePacket }) => {
      fallbackCalls++;
      assert.match(evidencePacket, /pre-patch snapshots/);
      assert.match(evidencePacket, /CURRENT FILE src\/value\.mjs\nexport function value\(\)\{return 2;\}/);
      assert.match(evidencePacket, /Visible verification failed/);
      await fs.writeFile(path.join(setup.trialRoot, "src/value.mjs"), "export function value(){return 1;}\n");
      return { modelCalls: 2 };
    } });
  assert.equal(result.status, "completed_via_fallback");
  assert.equal(result.initialVerification!.exitCode, 1);
  assert.equal(result.fullTest!.exitCode, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.modelCalls, 3);
  assert.deepEqual(result.executedRoutes, ["targeted_symbol_search"]);
  assert.deepEqual(result.changedPaths, ["src/value.mjs"]);
});

test("an uncertain optional checkpoint cannot invoke synthesis or fallback", async t => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.trialRoot, "src/value.mjs"), 'import {core} from "./helper.mjs"; export function value(){return core();}\n');
  await fs.writeFile(path.join(setup.trialRoot, "src/helper.mjs"), "export function core(){return 0;}\n");
  const forbidden = async () => assert.fail("writing callback reached");
  const result = await executeV7Dag({ ...setup, candidate: targeted, synthesize: forbidden, fallbackAgent: forbidden,
    chooseExpansion: async () => ({ candidateId: null, status: "awaiting_approval" }) });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.changedPaths, []);
});

test("child-process environment excludes credential-like entries", () => {
  const key = "HARNESS_TEST_SECRET";
  const prior = process.env[key];
  try {
    process.env[key] = "fake-test-value";
    const env = benchmarkEnvironment();
    assert.equal(env[key], undefined);
    assert.ok(Object.keys(env).every(name => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|FIXTURE_ROOT|CODEX_THREAD|NODE_TEST_CONTEXT)/i.test(name)));
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});
