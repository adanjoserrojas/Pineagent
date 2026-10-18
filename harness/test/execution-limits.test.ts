import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxToolRuntime, createFrozenRouter, prototypeTools, selectCandidateDags } from "../src/index.js";

test("verification terminates a hung fixture process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-timeout-"));
  await writeFile(join(root, "hung.test.mjs"), "setInterval(() => {}, 1000);");
  const runtime = new SandboxToolRuntime({ root, allowedWrites: [], testTimeoutMs: 200 });
  await assert.rejects(runtime.runTests("hung.test.mjs"), /timed out/);
});
test("aborting retry backoff stops further router inference and records the failed request", async () => {
  const controller = new AbortController(); let calls = 0;
  const router = createFrozenRouter({ decisionsApiKey: "test", fetchImpl: async () => {
    calls++; setTimeout(() => controller.abort(), 5);
    return new Response("unavailable", { status: 429, headers: { "retry-after": "3600" } });
  } });
  await assert.rejects(router.route({ task: "feature", signal: controller.signal,
    candidates: selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools }) }), /abort/i);
  assert.equal(calls, 1);
  assert.deepEqual(router.receipts().map(receipt => ({ status: receipt.status, usage: receipt.usage })), [{ status: "failed", usage: null }]);
});
