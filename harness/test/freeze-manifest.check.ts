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

test("freeze manifest seals every runtime source and the recorded transfer artifacts", async () => {
  const runtimeFiles = (await fs.readdir(path.join(root, "src"))).filter(file => file.endsWith(".ts")).map(file => `src/${file}`).sort();
  assert.deepEqual(Object.keys(manifest.normalizedLfSha256).filter(file => file.startsWith("src/")).sort(), runtimeFiles);
  for (const [file, expected] of Object.entries(manifest.normalizedLfSha256)) {
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(`${path.resolve(root)}${path.sep}`), "manifest path must stay inside the package");
    const normalized = (await fs.readFile(target, "utf8")).replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(normalized).digest("hex"), expected, `frozen file changed: ${file}`);
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
