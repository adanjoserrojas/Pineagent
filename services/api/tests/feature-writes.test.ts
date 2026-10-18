import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";
import { BackendTools } from "../src/harness/tools";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pineagent-feature-writes-"));
  await writeFile(join(root, "app.py"), "old");
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  ws.acquireForRun(["app.py", "pkg/feature.py"], "alice", "r");
  const events: string[] = [];
  const tools = new BackendTools({ ws, ownerId: "alice", runId: "r", allowedWrites: ["app.py", "pkg/feature.py"],
    files: async () => ["app.py"], runTests: async () => ({ exitCode: 0, output: "" }), boundary: async () => {},
    changed: path => { events.push(path); } });
  await tools.readText("app.py"); await tools.observeCreates(["pkg/feature.py"]);
  return { root, ws, tools, events };
}
it("publishes a new module and its caller under one authority barrier", async () => {
  const { root, ws, tools, events } = await setup();
  await tools.writeFiles([{ path: "app.py", content: "from pkg.feature import value" }, { path: "pkg/feature.py", content: "value = 42" }]);
  expect(await readFile(join(root, "pkg/feature.py"), "utf8")).toBe("value = 42");
  expect(await ws.read("app.py")).toMatchObject({ version: 2 });
  expect(await ws.read("pkg/feature.py")).toMatchObject({ version: 1 });
  expect(ws.editorsOf("pkg/feature.py")).toEqual(["alice"]);
  expect(events).toEqual(["app.py", "pkg/feature.py"]);
});
it("rejects an intervening creation before changing any existing file", async () => {
  const { root, tools, events } = await setup();
  await mkdir(join(root, "pkg")); await writeFile(join(root, "pkg/feature.py"), "someone else's work");
  await expect(tools.writeFiles([{ path: "app.py", content: "changed" }, { path: "pkg/feature.py", content: "overwrite" }])).rejects.toThrow("Evidence changed");
  expect(await readFile(join(root, "app.py"), "utf8")).toBe("old");
  expect(events).toEqual([]);
});
it("staging failure never exposes half of a feature", async () => {
  const { root, ws, tools, events } = await setup();
  ws.setWriteFence(async path => { if (path === "pkg/feature.py") throw new Error("authority unavailable"); });
  await expect(tools.writeFiles([{ path: "app.py", content: "changed" }, { path: "pkg/feature.py", content: "new" }])).rejects.toThrow("authority unavailable");
  expect(await readFile(join(root, "app.py"), "utf8")).toBe("old");
  expect((await readdir(root)).filter(p => p.includes("pineagent-"))).toEqual([]);
  expect(events).toEqual([]);
});
it("directories and binary files cannot masquerade as absent feature paths", async () => {
  const { root, ws } = await setup();
  await mkdir(join(root, "directory")); await writeFile(join(root, "binary"), "\0");
  await expect(ws.observeForRun("directory")).rejects.toThrow("Unsupported");
  await expect(ws.observeForRun("binary")).rejects.toThrow("Unsupported");
});
