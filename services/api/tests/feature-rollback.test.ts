import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "@pineagent/core/server";

const fault = vi.hoisted(() => ({ destination: "", fired: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === fault.destination && !fault.fired) { fault.fired = true; throw new Error("simulated disk failure"); }
    return fs.rename(...args);
  } };
});
it("rolls back the first published file when the second publication fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-rollback-"));
  for (const file of ["a.py", "b.py"]) await writeFile(join(root, file), "old");
  const ws = new Workspace(root, { leaseMs: 30000, idleMs: 600000 });
  ws.acquireForRun(["a.py", "b.py"], "alice", "r");
  const observed = new Map([["a.py", await ws.observeForRun("a.py")], ["b.py", await ws.observeForRun("b.py")]]);
  fault.destination = join(root, "b.py"); fault.fired = false;
  const applied = vi.fn();
  await expect(ws.applyRunPatch("alice", "r", observed, [{ path: "a.py", content: "new" }, { path: "b.py", content: "new" }], applied)).rejects.toThrow("disk failure");
  expect(fault.fired).toBe(true);
  for (const file of ["a.py", "b.py"]) {
    expect(await readFile(join(root, file), "utf8")).toBe("old");
    expect(await ws.read(file)).toMatchObject({ version: 1, content: "old" });
  }
  expect(applied).not.toHaveBeenCalled();
  await ws.applyRunPatch("alice", "r", observed, [{ path: "a.py", content: "retried" }], applied);
  expect(await ws.read("a.py")).toMatchObject({ version: 3, content: "retried" });
});
