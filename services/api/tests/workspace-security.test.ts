import { mkdtemp, mkdir, writeFile, link, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";

describe("workspace write authority", () => {
  it("does not allow a hardlink alias to become a second writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await writeFile(join(root, "original.ts"), "original");
    await link(join(root, "original.ts"), join(root, "alias.ts"));
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquire("alias.ts", "file", "bob");
    expect(await ws.applyOps("alias.ts", "bob", 1, [{ offset: 0, length: 8, text: "modified" }]))
      .toMatchObject({ ok: false });
    expect(await readFile(join(root, "original.ts"), "utf8")).toBe("original");
  });
  it.skipIf(process.platform === "win32")("rejects internal symlink aliases as well as escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await writeFile(join(root, "original.ts"), "original");
    await symlink("original.ts", join(root, "alias.ts"));
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquire("alias.ts", "file", "bob");
    expect(await ws.applyOps("alias.ts", "bob", 1, [{ offset: 0, length: 8, text: "modified" }])).toMatchObject({ ok: false });
    expect(await readFile(join(root, "original.ts"), "utf8")).toBe("original");
  });
  it("fails closed before disk or versions change when a kernel writer cannot be stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await writeFile(join(root, "source.ts"), "original");
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquire("source.ts", "file", "alice");
    ws.setWriteFence(async () => { throw new Error("sandbox stop failed"); });
    await expect(ws.applyOps("source.ts", "alice", 1, [{ offset: 0, length: 8, text: "changed" }])).rejects.toThrow("stop failed");
    expect(await ws.read("source.ts")).toMatchObject({ content: "original", version: 1 });
  });
  it("accepts only one concurrent write based on a given version", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await writeFile(join(root, "source.ts"), "original");
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquire("source.ts", "file", "alice");
    const results = await Promise.all(["first", "second"].map((text) => ws.applyOps("source.ts", "alice", 1, [{ offset: 0, length: 8, text }])));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await ws.read("source.ts")).toMatchObject({ content: "first", version: 2 });
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe("first");
  });
  it("rejects alternate spellings before they can create independent locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "demo.ts"), "original");
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquire("src/demo.ts", "file", "alice");
    for (const path of ["./src/demo.ts", "src/../src/demo.ts", "src//demo.ts", "src\\demo.ts", "src/demo.ts.", "src/demo.ts:stream"]) {
      expect(ws.resolvePath(path), path).toBeNull();
      expect(() => ws.acquire(path, "file", "bob"), path).toThrow();
    }
    expect(ws.allLocks()).toHaveLength(1);
  });
  it("a run ID alone cannot authorize another user's edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-security-"));
    await writeFile(join(root, "demo.ts"), "original");
    const ws = new Workspace(root, { leaseMs: 30_000, idleMs: 600_000 });
    ws.acquireForRun(["demo.ts"], "alice", "run-1");
    expect(await ws.applyOps("demo.ts", "bob", 1, [{ offset: 0, length: 8, text: "overwritten" }], "run-1"))
      .toMatchObject({ ok: false, code: "NOT_HOLDER" });
    expect((await ws.read("demo.ts"))?.content).toBe("original");
  });
});
