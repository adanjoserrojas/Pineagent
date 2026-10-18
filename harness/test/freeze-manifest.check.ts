import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import * as harness from "../src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
interface FreezeManifest {
  version: string;
  gate: { confidenceThreshold: number; minMargin: number };
  coding: { model: string; effort: string };
  recovery: { maxFiles: number; maxChars: number; maxMs: number };
  normalizedLfSha256: Record<string, string>;
}
const manifest = JSON.parse(await fs.readFile(path.join(root, "FREEZE_MANIFEST.json"), "utf8")) as FreezeManifest;
const integration = JSON.parse(await fs.readFile(path.join(root, "INTEGRATION_MANIFEST.json"), "utf8")) as {
  baseManifestSha256: string;
  overrides: Record<string, { originalSha256: string; integrationSha256: string }>;
  additions: Record<string, string>;
};
const hash = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");

test("original freeze and explicitly approved integration overrides seal the runtime", async () => {
  assert.equal(hash(await fs.readFile(path.join(root, "FREEZE_MANIFEST.json"), "utf8")), integration.baseManifestSha256);
  for (const file of Object.keys(integration.overrides)) assert.ok(Object.hasOwn(manifest.normalizedLfSha256, file), `unknown baseline override: ${file}`);
  const runtimeFiles = (await fs.readdir(path.join(root, "src"))).filter(file => file.endsWith(".ts")).map(file => `src/${file}`).sort();
  assert.deepEqual([...Object.keys(manifest.normalizedLfSha256), ...Object.keys(integration.additions)].filter(file => file.startsWith("src/")).sort(), runtimeFiles);
  for (const [file, expected] of Object.entries(manifest.normalizedLfSha256)) {
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(`${path.resolve(root)}${path.sep}`), "manifest path must stay inside the package");
    const normalized = (await fs.readFile(target, "utf8")).replaceAll("\r\n", "\n");
    const override = integration.overrides[file];
    if (override) assert.equal(override.originalSha256, expected, `original provenance changed: ${file}`);
    assert.equal(hash(normalized), override?.integrationSha256 ?? expected, `unrecorded file change: ${file}`);
  }
  for (const [file, expected] of Object.entries(integration.additions)) {
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(`${path.resolve(root)}${path.sep}`));
    assert.equal(hash(await fs.readFile(target, "utf8")), expected, `integration artifact changed: ${file}`);
  }
});

test("public factory configuration matches the recorded freeze", () => {
  assert.equal(manifest.version, "V8-typescript-0.8.0");
  assert.deepEqual(harness.FROZEN_GATE, manifest.gate);
  assert.deepEqual(harness.FROZEN_CODING, manifest.coding);
  assert.deepEqual(harness.V8_RECOVERY_LIMITS, manifest.recovery);
});

test("compiled public ESM surface exposes the two master tools and frozen executor", () => {
  for (const key of ["selectCandidateDags", "MasterTool1Router", "createFrozenRouter", "createFrozenSynthesize", "executeV8Dag"] as const) {
    assert.equal(typeof harness[key], "function", key);
  }
});
