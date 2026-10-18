import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "@pineagent/core/server";

describe("workspace write authority", () => {
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
