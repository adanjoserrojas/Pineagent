import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { BackendTools } from "../src/harness/tools";

it("applies a model patch only through the run's lock and observed file version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-tools-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.mjs"), "old");
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const changes: string[] = [];
  const tools = new BackendTools({ ws, ownerId: "alice", runId: "r1", allowedWrites: ["src/value.mjs"],
    files: async () => ["src/value.mjs"], runTests: async () => ({ exitCode: 0, output: "ok" }),
    changed: (path) => { changes.push(path); }, boundary: async () => {} });
  await tools.readFiles(["src/value.mjs"]);
  await expect(tools.writeFiles([{ path: "src/value.mjs", content: "changed" }])).rejects.toThrow();
  ws.acquireForRun(["src/value.mjs"], "alice", "r1");
  expect(await tools.writeFiles([{ path: "src/value.mjs", content: "changed" }])).toEqual(["src/value.mjs"]);
  expect(await readFile(join(root, "src/value.mjs"), "utf8")).toBe("changed");
  expect(await ws.read("src/value.mjs")).toMatchObject({ version: 2 });
  expect(changes).toEqual(["src/value.mjs"]);
});

it("rejects stale evidence after a pause and never treats read-only recovery as write approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-stale-"));
  await writeFile(join(root, "value.mjs"), "old");
  const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
  const base = { ws, ownerId: "alice", runId: "r1", files: async () => ["value.mjs"],
    runTests: async () => ({ exitCode: 0, output: "ok" }), changed: () => {}, boundary: async () => {} };
  const tools = new BackendTools({ ...base, allowedWrites: ["value.mjs"] });
  await tools.readFiles(["value.mjs"]);
  ws.acquire("value.mjs", "file", "bob");
  await ws.applyOps("value.mjs", "bob", 1, [{ offset: 0, length: 3, text: "new" }]);
  ws.release("value.mjs", "bob");
  ws.acquireForRun(["value.mjs"], "alice", "r1");
  await expect(tools.writeFiles([{ path: "value.mjs", content: "stale patch" }])).rejects.toThrow("Evidence changed");
  const recovery = new BackendTools({ ...base, allowedWrites: [] });
  await recovery.readFiles(["value.mjs"]);
  await expect(recovery.writeFiles([{ path: "value.mjs", content: "not authorized" }])).rejects.toThrow("scope");
  expect(await readFile(join(root, "value.mjs"), "utf8")).toBe("new");
});
