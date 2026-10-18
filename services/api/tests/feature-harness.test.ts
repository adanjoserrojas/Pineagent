import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { LiveHarness } from "../src/harness/controller";
import { validateFeaturePlan } from "../src/harness/feature-plan";
import { RoomSandbox } from "../src/sandbox/room";
import { SandboxHost } from "../src/sandbox/host";
import type { FeaturePlan } from "../src/harness/feature-plan";

const exec = promisify(execFile);
async function filesAt(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await filesAt(root, path + "/")); else result.push(path);
  }
  return result;
}
type FeatureFixture = { language: string; original: Record<string, string>; additions: Record<string, string>; caller: string; replacement: string; test: string };
const cases: FeatureFixture[] = [
  { language: "node", original: { "app.mjs": "export const name = 'shop';", "test/regression.test.mjs": "import assert from 'node:assert/strict'; import {name} from '../app.mjs'; assert.equal(name, 'shop');" },
    additions: { "lib/pricing.mjs": "export function total(items) { return items.reduce((sum, item) => sum + item.price * item.quantity, 0); }",
      "test/pricing.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from '../app.mjs'; test('total',()=>{assert.equal(total([{price:3,quantity:2}]),6); assert.equal(total([]),0);});" },
    caller: "app.mjs", replacement: "export const name = 'shop'; export {total} from './lib/pricing.mjs';", test: "test/pricing.test.mjs" },
  { language: "python", original: { "app.py": "name = 'shop'\n", "test_regression.py": "from app import name\ndef test_name():\n    assert name == 'shop'\n" },
    additions: { "pricing.py": "def total(items):\n    return sum(item['price'] * item['quantity'] for item in items)\n",
      "test_pricing.py": "from app import total\ndef test_total():\n    assert total([{'price': 3, 'quantity': 2}]) == 6\n    assert total([]) == 0\n" },
    caller: "app.py", replacement: "name = 'shop'\nfrom pricing import total\n", test: "test_pricing.py" },
];
async function exercise(spec: typeof cases[number], docker: boolean) {
  const parent = await mkdtemp(join(tmpdir(), "pineagent-feature-")), root = join(parent, "repo");
  await mkdir(join(root, ".git"), { recursive: true });
  for (const [path, content] of Object.entries(spec.original)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content!); }
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  const host = docker ? new SandboxHost({ workspaceRoot: parent, image: process.env.PINEAGENT_FEATURE_IMAGE! }) : undefined;
  const sandbox = host ? new RoomSandbox(ws, host) : undefined;
  let plans = 0, patches = 0, routes = 0, evidence = "";
  const plan: FeaturePlan = { allowedWrites: [spec.caller, ...Object.keys(spec.additions)], visibleTestPath: spec.test,
    acceptanceCriteria: ["Calculate price times quantity across every item", "An empty cart totals zero", "Preserve the existing shop name"] };
  const harness = new LiveHarness({ context: { ws, roomId: "feature", files: () => filesAt(root),
    events: { run: () => {}, lockChanged: () => {}, fileChanged: () => {} } },
    model: () => ({ plan: async () => { plans++; return plan; }, patch: async input => {
      patches++; evidence = input.evidence;
      return { files: [{ path: spec.caller, content: spec.replacement }, ...Object.entries(spec.additions).map(([path, content]) => ({ path, content: content! }))] };
    } }),
    router: () => ({ route: async ({ candidates }) => { routes++; return { status: "selected", candidateId: candidates.find(c => c.routeLabel === "repository_flow_mapping")!.id }; } }),
    runTests: async (owner, run, path, validator) => {
      if (sandbox) return sandbox.runTests(owner, run, path, validator);
      const result = await exec(process.execPath, ["--test"], { cwd: root, timeout: 10000 });
      return { exitCode: 0, output: result.stdout };
    },
  });
  try {
    harness.start({ id: "alice", name: "Alice" }, "Build cart pricing: total every item's price times quantity, return zero for empty carts, and expose it through app. Preserve the shop name.");
    await expect.poll(() => harness.list()[0].state, { timeout: docker ? 45000 : 5000 }).toBe("done");
    expect({ plans, routes, patches }).toEqual({ plans: 1, routes: 1, patches: 1 });
    expect(evidence).toContain("Acceptance criteria:");
    for (const [path, content] of Object.entries(spec.original)) if (path !== spec.caller) expect(await readFile(join(root, path), "utf8")).toBe(content);
    expect((await ws.read(spec.caller))?.version).toBe(Object.hasOwn(spec.original, spec.caller) ? 2 : 1);
    expect((await ws.read(spec.test))?.version).toBe(1);
    expect(ws.allLocks()).toEqual([]);
  } finally { await harness.close(); await host?.close(); }
}
it("builds and executes a multi-file Node feature with one planning and one coding call", () => exercise(cases[0], false));
it("creates a working feature from requirements in an empty repository", () => exercise({ ...cases[0], original: {} }, false));
for (const spec of cases) it.runIf(Boolean(process.env.PINEAGENT_FEATURE_IMAGE))(`builds ${spec.language} features and validates them in real read-only Docker`, () => exercise(spec, true), 60000);

it("rejects test weakening, missing acceptance criteria and unsafe creation plans", () => {
  const existing = ["app.py", "test_app.py"];
  expect(() => validateFeaturePlan({ allowedWrites: ["test_app.py"], visibleTestPath: "test_app.py" }, existing)).toThrow("immutable");
  expect(() => validateFeaturePlan({ allowedWrites: ["new.py"], visibleTestPath: "test_app.py" }, existing)).toThrow("acceptance criteria");
  for (const path of ["../new.py", ".env", ".git/config", "folder/../new.py", "node_modules/a.js"])
    expect(() => validateFeaturePlan({ allowedWrites: [path], visibleTestPath: "test_app.py", acceptanceCriteria: ["works"] }, existing)).toThrow();
});
