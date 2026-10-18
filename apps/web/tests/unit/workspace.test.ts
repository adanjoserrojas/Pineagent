import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MemoryStore, Workspace, type RoomStore } from "@pineagent/core/server";
import { applyOps } from "@pineagent/core/ops";

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
    // Keep the lease live while approaching idle expiry; an expired lease
    // cannot be resurrected by a late heartbeat after sandbox revocation.
    for (let elapsed = 0; elapsed < IDLE - 10_000; elapsed += 10_000) {
      now += 10_000;
      ws.heartbeat(ALICE);
    }
    now += 9_000;
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

describe("files a real repository can contain", () => {
  it("won't follow a symlink out of the workspace, for reading or editing", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pineagent-outside-"));
    await writeFile(join(outside, "secret.txt"), "do not leak");
    await symlink(join(outside, "secret.txt"), join(ws.root, "leak.txt"));
    await symlink(outside, join(ws.root, "leakdir"));
    expect(await ws.open("leak.txt")).toBeNull();
    expect(await ws.open("leakdir/secret.txt")).toBeNull();
    ws.acquire("leak.txt", "file", ALICE);
    expect(await ws.applyOps("leak.txt", ALICE, 1, [{ offset: 0, length: 0, text: "x" }])).toMatchObject({ ok: false });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("do not leak");
  });

  it("still follows a symlink that stays inside the workspace", async () => {
    await symlink("auth.ts", join(ws.root, "src/auth-link.ts"));
    expect(await ws.open("src/auth-link.ts")).toMatchObject({ version: 1, content: expect.stringContaining("currentUser") });
  });

  it("reports binary and oversized files instead of opening them as text", async () => {
    await writeFile(join(ws.root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(ws.root, "big.json"), "x".repeat(MAX_FILE_BYTES + 1));
    expect(await ws.open("logo.png")).toEqual({ unsupported: "binary" });
    expect(await ws.open("big.json")).toEqual({ unsupported: "too_large" });
    expect(await ws.read("logo.png")).toBeNull(); // so file:ops can't touch it either
  });

  it("serves allowed image files as base64 with a mime type", async () => {
    const res = await ws.image("images/logo.png");
    expect(res).toMatchObject({ ok: true, mime: "image/png", bytes: expect.any(Number) });
    if (!res.ok) return;
    expect(Buffer.from(res.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(await ws.image("images/mark.svg")).toMatchObject({ ok: true, mime: "image/svg+xml" });
    await writeFile(join(ws.root, "UP.JPG"), Buffer.from([0xff, 0xd8, 0xff]));
    expect(await ws.image("UP.JPG")).toMatchObject({ ok: true, mime: "image/jpeg", bytes: 3 });
  });

  it("refuses images with other extensions, oversized images, and missing files", async () => {
    expect(await ws.image("README.md")).toEqual({ ok: false, code: "UNSUPPORTED" });
    await writeFile(join(ws.root, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(await ws.image("big.png")).toEqual({ ok: false, code: "TOO_LARGE" });
    expect(await ws.image("nope.png")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await ws.image("images/")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await ws.image("../x.png")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("won't follow an image symlink out of the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pineagent-outside-"));
    await writeFile(join(outside, "secret.png"), Buffer.from([1, 2, 3]));
    await symlink(join(outside, "secret.png"), join(ws.root, "leak.png"));
    await symlink(outside, join(ws.root, "leakdir"));
    expect(await ws.image("leak.png")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await ws.image("leakdir/secret.png")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses an edit that would grow a file past the limit", async () => {
    ws.acquire("README.md", "file", ALICE);
    const res = await ws.applyOps("README.md", ALICE, 1, [{ offset: 0, length: 0, text: "x".repeat(MAX_FILE_BYTES) }]);
    expect(res).toMatchObject({ ok: false, code: "STALE" });
  });
});

describe("restart recovery (store written through, memory stays the authority)", () => {
  const ROOM = "ws:demo:main";
  let store: MemoryStore;
  let failures: string[];
  const start = (roomStore: RoomStore = store.room(ROOM)) =>
    new Workspace(ws.root, { leaseMs: LEASE, idleMs: IDLE }, () => now, { store: roomStore, failed: (op) => failures.push(op) });

  beforeEach(() => {
    store = new MemoryStore();
    failures = [];
  });

  it("brings back editor locks with a fresh lease, file versions and editors", async () => {
    const a = start();
    a.acquire("src/auth.ts", "file", ALICE);
    a.acquire("src/routes/", "dir", BOB);
    await a.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }]);
    await a.saved();

    now += 20_000; // the restart takes a while
    const b = start();
    expect(await b.restore()).toEqual({ locks: 2, files: 1 });
    expect(b.allLocks()).toEqual([
      { path: "src/auth.ts", kind: "file", holder: ALICE, holderType: "user", expiresAt: now + LEASE },
      { path: "src/routes/", kind: "dir", holder: BOB, holderType: "user", expiresAt: now + LEASE },
    ]);
    expect(await b.read("src/auth.ts")).toMatchObject({ version: 2 });
    expect(b.editorsOf("src/auth.ts")).toEqual([ALICE]);
    expect(await b.applyOps("src/auth.ts", ALICE, 2, [{ offset: 0, length: 0, text: "B" }])).toEqual({ ok: true, version: 3 });
  });

  it("forgets released and expired locks, and committed paths' editors", async () => {
    const a = start();
    a.acquire("src/auth.ts", "file", ALICE);
    a.acquire("src/db.ts", "file", BOB);
    await a.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }]);
    a.release("src/auth.ts", ALICE);
    now += LEASE;
    a.heartbeat(ALICE);
    a.sweep(); // Bob went quiet
    a.clearEditors(["src/auth.ts"]);
    await a.saved();

    const b = start();
    await b.restore();
    expect(b.allLocks()).toEqual([]);
    expect(b.editorsOf("src/auth.ts")).toEqual([]);
    expect(await b.read("src/auth.ts")).toMatchObject({ version: 2 }); // the version stays
  });

  it("doesn't keep agent run locks: the run ends with the process", async () => {
    const a = start();
    expect(a.acquireForRun(["src/db.ts"], ALICE, "r1").ok).toBe(true);
    await a.saved();
    expect((await store.room(ROOM).load()).locks).toEqual([]);
  });

  it("a file Git changed after the restart gets a newer version than anyone holds", async () => {
    const a = start();
    a.acquire("src/auth.ts", "file", ALICE);
    await a.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }]);
    await a.saved();

    const b = start();
    await b.restore();
    await writeFile(join(ws.root, "src/auth.ts"), "pulled\n");
    expect(await b.reloadFromDisk("src/auth.ts")).toMatchObject({ after: "pulled\n", version: 3 });
    const c = start();
    await c.restore();
    expect(await c.read("src/auth.ts")).toMatchObject({ version: 3 });
  });

  it("keeps editing when the store fails, and says so", async () => {
    const broken: RoomStore = {
      load: async () => ({ locks: [], files: [] }),
      putLock: async () => { throw new Error("throttled"); },
      deleteLock: async () => { throw new Error("throttled"); },
      saveFile: async () => { throw new Error("throttled"); },
      clearEditors: async () => { throw new Error("throttled"); },
    };
    const a = start(broken);
    expect(a.acquire("src/auth.ts", "file", ALICE).ok).toBe(true);
    await a.lockSaved("src/auth.ts");
    expect(await a.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }])).toEqual({ ok: true, version: 2 });
    expect((await readFile(join(ws.root, "src/auth.ts"), "utf8")).startsWith("A")).toBe(true);
    expect(failures).toEqual(["putLock", "saveFile"]);
  });

  it("writes the version to the store before the disk", async () => {
    const seen: string[] = [];
    const inner = store.room(ROOM);
    const spy: RoomStore = {
      ...inner,
      saveFile: async (path, version, editor) => {
        const disk = await readFile(join(ws.root, path), "utf8");
        seen.push(`v${version} saved while disk ${disk.startsWith("A") ? "had" : "lacked"} the edit`);
        await inner.saveFile(path, version, editor);
      },
    };
    const a = start(spy);
    a.acquire("src/auth.ts", "file", ALICE);
    await a.applyOps("src/auth.ts", ALICE, 1, [{ offset: 0, length: 0, text: "A" }]);
    expect(seen).toEqual(["v2 saved while disk lacked the edit"]);
  });
});

describe("creating files and folders (tree:create)", () => {
  it("makes an empty file, and its missing folders, that the creator can edit and commit", async () => {
    expect(await ws.create("src/utils/date.ts", "file", ALICE)).toEqual({ ok: true, path: "src/utils/date.ts" });
    expect(await readFile(join(ws.root, "src/utils/date.ts"), "utf8")).toBe("");
    expect(await ws.read("src/utils/date.ts")).toEqual({ content: "", version: 1 });
    expect(ws.editorsOf("src/utils/date.ts")).toEqual([ALICE]);
    ws.acquire("src/utils/date.ts", "file", ALICE);
    expect(await ws.applyOps("src/utils/date.ts", ALICE, 1, [{ offset: 0, length: 0, text: "x" }])).toEqual({ ok: true, version: 2 });
  });

  it("makes a folder, named with a trailing slash like a folder lock", async () => {
    expect(await ws.create("docs/notes", "dir", ALICE)).toEqual({ ok: true, path: "docs/notes/" });
    expect((await stat(join(ws.root, "docs/notes"))).isDirectory()).toBe(true);
    expect(await ws.create("docs/notes/", "dir", BOB)).toEqual({ ok: false, code: "EXISTS" });
  });

  it("refuses names that exist, escape, touch .git, or sit inside a file", async () => {
    expect(await ws.create("src/auth.ts", "file", ALICE)).toEqual({ ok: false, code: "EXISTS" });
    expect(await ws.create("src/auth.ts/inner.ts", "file", ALICE)).toEqual({ ok: false, code: "EXISTS" });
    for (const bad of ["../escape.ts", "/etc/x", "src/../../x", ".git/hooks/x", "a//b", "a/./b", ""]) {
      expect(await ws.create(bad, "file", ALICE)).toEqual({ ok: false, code: "INVALID" });
    }
  });

  it("won't create through a symlink that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pineagent-outside-"));
    await symlink(outside, join(ws.root, "out"));
    expect(await ws.create("out/new/x.ts", "file", ALICE)).toEqual({ ok: false, code: "INVALID" });
    expect(await stat(join(outside, "new")).catch(() => null)).toBeNull();
  });

  it("refuses inside a folder someone else holds, but not your own", async () => {
    ws.acquire("src/routes/", "dir", BOB);
    expect(await ws.create("src/routes/new.ts", "file", ALICE)).toEqual({ ok: false, code: "LOCKED" });
    expect(await ws.create("src/routes/new.ts", "file", BOB)).toMatchObject({ ok: true });
  });

  it("a re-created path continues the old version, so old snapshots go stale", async () => {
    ws.acquire("README.md", "file", ALICE);
    await ws.applyOps("README.md", ALICE, 1, [{ offset: 0, length: 0, text: "x" }]);
    await rm(join(ws.root, "README.md")); // deleted outside the editor; the server still knows v2
    expect(await ws.create("README.md", "file", ALICE)).toMatchObject({ ok: true });
    expect(await ws.read("README.md")).toEqual({ content: "", version: 3 });
  });
});
