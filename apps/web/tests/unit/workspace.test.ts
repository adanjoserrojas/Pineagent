import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../../mock/workspace";
import { applyOps } from "../../src/shared/ops";

const FIXTURE = fileURLToPath(new URL("../../mock/fixtures/demo-repo", import.meta.url));
const LEASE = 30_000;
const IDLE = 600_000;
const ALICE = "dev|alice";
const BOB = "dev|bob";

let now: number;
let ws: Workspace;

beforeEach(async () => {
  now = 1_000_000;
  const root = await mkdtemp(join(tmpdir(), "pineagent-ws-test-"));
  await cp(FIXTURE, root, { recursive: true });
  ws = new Workspace(root, { leaseMs: LEASE, idleMs: IDLE }, () => now);
});

describe("applyOps (shared by browser and server)", () => {
  it("applies ops in order against the progressively updated text", () => {
    expect(applyOps("hello", [{ offset: 5, length: 0, text: " world" }, { offset: 0, length: 1, text: "H" }])).toBe("Hello world");
  });
  it("rejects ops that point outside the text", () => {
    expect(applyOps("abc", [{ offset: 2, length: 5, text: "" }])).toBeNull();
    expect(applyOps("abc", [{ offset: -1, length: 0, text: "x" }])).toBeNull();
  });
});

describe("locks", () => {
  it("gives a free file to the first asker and refuses the second (L2 at the server)", () => {
    const a = ws.acquire("src/auth.ts", "file", ALICE);
    expect(a).toMatchObject({ ok: true, created: true, lock: { holder: ALICE, expiresAt: now + LEASE } });
    const b = ws.acquire("src/auth.ts", "file", BOB);
    expect(b).toMatchObject({ ok: false, code: "HELD", lock: { holder: ALICE } });
  });

  it("re-acquiring your own lock renews it instead of creating another", () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    now += 5_000;
    expect(ws.acquire("src/auth.ts", "file", ALICE)).toMatchObject({ ok: true, created: false, lock: { expiresAt: now + LEASE } });
  });

  it("folder claims conflict with locks above and below them", () => {
    ws.acquire("src/routes/users.ts", "file", BOB);
    expect(ws.acquire("src/", "dir", ALICE)).toMatchObject({ ok: false, lock: { path: "src/routes/users.ts" } });
    ws.acquire("src/routes/", "dir", BOB);
    expect(ws.acquire("src/routes/index.ts", "file", ALICE)).toMatchObject({ ok: false, lock: { path: "src/routes/" } });
    expect(ws.acquire("src/auth.ts", "file", ALICE).ok).toBe(true);
  });

  it("your own agent's lock makes the file read-only for you", () => {
    // Agent locks come from the harness (SE1); simulate one directly.
    (ws as unknown as { locks: Map<string, object> }).locks.set("src/db.ts", {
      path: "src/db.ts", kind: "file", holder: ALICE, holderType: "run", runId: "r1", expiresAt: now + LEASE, lastEditAt: now,
    });
    expect(ws.acquire("src/db.ts", "file", ALICE)).toMatchObject({ ok: false, code: "HELD", lock: { holderType: "run" } });
  });

  it("only the holder can release", () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    expect(ws.release("src/auth.ts", BOB)).toBeNull();
    expect(ws.release("src/auth.ts", ALICE)).toMatchObject({ path: "src/auth.ts" });
    expect(ws.allLocks()).toEqual([]);
  });
});

describe("leases", () => {
  it("heartbeats keep a lock alive; silence for the lease frees it (L4 at the server)", () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    now += 20_000;
    ws.heartbeat(ALICE);
    now += 20_000; // 40 s since acquire, 20 s since the beat
    expect(ws.sweep()).toEqual([]);
    now += 10_001;
    expect(ws.sweep()).toMatchObject([{ lock: { path: "src/auth.ts" }, reason: "expired" }]);
    expect(ws.acquire("src/auth.ts", "file", BOB).ok).toBe(true);
    // The next heartbeat tells Alice which lease she lost.
    expect(ws.heartbeat(ALICE)).toEqual(["src/auth.ts"]);
    expect(ws.heartbeat(ALICE)).toEqual([]);
  });

  it("a lock with heartbeats but no edits for 10 minutes is released as idle", async () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    for (let t = 0; t < IDLE; t += 10_000) {
      now += 10_000;
      ws.heartbeat(ALICE);
    }
    expect(ws.sweep()).toMatchObject([{ reason: "idle" }]);
  });

  it("editing resets the idle clock", async () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    now += IDLE - 1_000;
    ws.heartbeat(ALICE);
    await ws.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "// hi\n" }]);
    now += 2_000;
    ws.heartbeat(ALICE);
    expect(ws.sweep()).toEqual([]);
  });
});

describe("file:ops", () => {
  it("refuses edits from someone without the lock and leaves the disk alone (L3)", async () => {
    const before = await readFile(join(ws.root, "src/auth.ts"), "utf8");
    ws.acquire("src/auth.ts", "file", ALICE);
    expect(await ws.applyOps("src/auth.ts", BOB, 1, [{ offset: 0, length: 0, text: "x" }])).toEqual({
      ok: false, code: "NOT_HOLDER", currentVersion: 1,
    });
    expect(await readFile(join(ws.root, "src/auth.ts"), "utf8")).toBe(before);
  });

  it("accepts in-order batches, bumps the version and writes to disk", async () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    expect(await ws.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }])).toEqual({ ok: true, version: 2 });
    expect(await ws.applyOps("src/auth.ts", ALICE, 2, [{ offset: 1, length: 0, text: "B" }])).toEqual({ ok: true, version: 3 });
    const disk = await readFile(join(ws.root, "src/auth.ts"), "utf8");
    expect(disk.startsWith("ABimport")).toBe(true);
    expect((await ws.read("src/auth.ts"))?.content).toBe(disk);
  });

  it("rejects a batch built on an old version as STALE", async () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    await ws.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }]);
    expect(await ws.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "B" }])).toEqual({
      ok: false, code: "STALE", currentVersion: 2,
    });
  });

  it("rejects ops that don't fit the text without changing anything", async () => {
    ws.acquire("src/auth.ts", "file", ALICE);
    expect(await ws.applyOps("src/auth.ts", ALICE, 1, [{ offset: 99_999, length: 0, text: "x" }])).toMatchObject({ ok: false, code: "STALE" });
    expect((await ws.read("src/auth.ts"))?.version).toBe(1);
  });

  it("a folder claim lets you edit files inside it", async () => {
    ws.acquire("src/routes/", "dir", ALICE);
    expect(await ws.applyOps("src/routes/users.ts", ALICE, 1, [{ offset: 0, length: 0, text: "//\n" }])).toEqual({ ok: true, version: 2 });
  });
});
