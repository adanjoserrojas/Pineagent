// One branch's shared state: its files, their versions, and the lock table.
// No sockets here, so the rules can be unit-tested with a fake clock.
import { readFile, realpath, stat, lstat, readdir, open as openFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { resolve, sep, relative, join } from "node:path";
import type { Lock, LockChangeReason, Op } from "../contracts";
import { applyOps } from "../ops";
import type { RoomStore } from "./store";

export type Timing = { leaseMs: number; idleMs: number };
type HeldLock = Lock & { lastEditAt: number };
type FileState = { content: string; version: number };
export type ReadResult = FileState | { unsupported: "binary" | "too_large" } | null;

// Bigger files aren't opened in the editor: every viewer holds the whole text.
export const MAX_FILE_BYTES = 1_000_000;

export type AcquireResult = { ok: true; lock: Lock; created: boolean } | { ok: false; code: "HELD"; lock: Lock };
export type OpsResult = { ok: true; version: number } | { ok: false; code: "NOT_HOLDER" | "STALE"; currentVersion: number };

// Where lock and version changes are written for restart recovery, and who hears when a write
// fails. A failed write never blocks editing; it only weakens what a restart can restore.
export type Persistence = { store: RoomStore; failed(op: string, err: unknown): void };

export const publicLock = ({ lastEditAt: _lastEditAt, ...lock }: HeldLock): Lock => lock;

export class Workspace {
  private readonly locks = new Map<string, HeldLock>();
  private readonly files = new Map<string, FileState>();
  // Paths whose lease ran out, per user, reported on that user's next heartbeat.
  private readonly expiredFor = new Map<string, string[]>();
  // Disk writes per path run in order even though acks are async.
  private readonly writes = new Map<string, Promise<void>>();
  // Who edited each path since its last commit; decides whose commit a change belongs to.
  private readonly editors = new Map<string, Set<string>>();
  // While Git works on the tree, edits to the affected paths wait here instead of landing mid-commit.
  private gate: { paths: ReadonlySet<string> | "all"; open: Promise<void> } | null = null;
  private realRoot: Promise<string> | undefined;
  // Store writes per key ("lock:<path>", "file:<path>") run in order; acks wait for them.
  private readonly saves = new Map<string, Promise<void>>();
  // Versions from before a restart, used when a file is next loaded.
  private readonly restoredVersions = new Map<string, number>();
  private writeFence: ((path: string) => Promise<void>) | undefined;
  private leaseFence: (() => Promise<void>) | undefined;
  private changingLease = false;
  private freezeTail: Promise<void> = Promise.resolve();

  // The sandbox host stops overlapping kernel writers before a backend edit.
  setWriteFence(fence: (path: string) => Promise<void>): void { this.writeFence = fence; }

  // Must stop and verify all writable containers for this room. A failed stop
  // leaves the old ownership intact; no new owner may inherit live file handles.
  setLeaseFence(fence: () => Promise<void>): void { this.leaseFence = fence; }

  private assertFenced(): void {
    if (this.leaseFence && !this.changingLease) throw new Error("Use fenced lock transitions with sandbox protection");
  }

  private async changeLease<T>(change: () => T): Promise<T> {
    const release = await this.freeze("all");
    try {
      this.changingLease = true;
      return change();
    } finally { this.changingLease = false; release(); }
  }

  async acquireSafely(path: string, kind: Lock["kind"], userId: string, authorized?: () => boolean): Promise<AcquireResult> {
    if (authorized && !authorized()) throw new Error("Lock authorization expired");
    const held = this.conflict(path, kind, userId);
    if (held) return { ok: false, code: "HELD", lock: publicLock(held) };
    const existing = this.locks.get(path);
    if (existing && !this.expiryReason(existing)) {
      existing.expiresAt = this.now() + this.timing.leaseMs;
      return { ok: true, lock: publicLock(existing), created: false };
    }
    return this.changeLease(() => {
      if (authorized && !authorized()) throw new Error("Lock authorization expired");
      return this.acquire(path, kind, userId);
    });
  }

  releaseSafely(path: string, userId: string, authorized?: () => boolean): Promise<Lock | null> {
    const lock = this.locks.get(path);
    if (!lock || lock.holder !== userId || lock.holderType !== "user") return Promise.resolve(null);
    return this.changeLease(() => {
      if (authorized && !authorized()) throw new Error("Lock authorization expired");
      return this.release(path, userId);
    });
  }

  async sweepSafely(): Promise<{ lock: Lock; reason: LockChangeReason }[]> {
    if (![...this.locks.values()].some((l) => this.expiryReason(l))) return [];
    return this.changeLease(() => this.sweep());
  }

  acquireRunSafely(paths: string[], ownerId: string, runId: string) {
    for (const path of paths) {
      const held = [...this.locks.values()].find((l) => !(l.runId === runId && l.holder === ownerId)
        && (l.path === path || (l.kind === "dir" && path.startsWith(l.path))));
      if (held) return Promise.resolve({ ok: false as const, lock: publicLock(held) });
    }
    return this.changeLease(() => this.acquireForRun(paths, ownerId, runId));
  }

  releaseRunSafely(runId: string): Promise<Lock[]> {
    if (![...this.locks.values()].some((l) => l.runId === runId)) return Promise.resolve([]);
    return this.changeLease(() => this.releaseRun(runId));
  }

  private expiryReason(l: HeldLock): "expired" | "idle" | null {
    return l.expiresAt <= this.now() ? "expired" : l.holderType === "user" && this.now() - l.lastEditAt >= this.timing.idleMs ? "idle" : null;
  }

  constructor(
    readonly root: string,
    private readonly timing: Timing,
    private readonly now: () => number = Date.now,
    private readonly persistence: Persistence | null = null,
  ) {}

  // --- Restart recovery ---------------------------------------------------------------------

  // Load what the store kept from the last run. Restored locks get a fresh lease, so their holders
  // have time to reconnect; anyone who doesn't come back loses theirs through the usual sweep.
  async restore(): Promise<{ locks: number; files: number }> {
    if (!this.persistence) return { locks: 0, files: 0 };
    const { locks, files } = await this.persistence.store.load();
    const now = this.now();
    for (const l of locks) {
      if (this.locks.has(l.path)) continue;
      this.locks.set(l.path, { path: l.path, kind: l.kind, holder: l.holder, holderType: "user", expiresAt: now + this.timing.leaseMs, lastEditAt: now });
    }
    for (const f of files) {
      this.restoredVersions.set(f.path, f.version);
      if (f.editors.length) this.editors.set(f.path, new Set(f.editors));
    }
    return { locks: locks.length, files: files.length };
  }

  // Resolves once the store has the latest change to this path's lock (or failed to take it).
  lockSaved(path: string): Promise<void> {
    return this.saves.get(`lock:${path}`) ?? Promise.resolve();
  }

  // Every store write started so far has finished (for tests and shutdown).
  async saved(): Promise<void> {
    await Promise.all(this.saves.values());
  }

  private save(key: string, op: string, write: (store: RoomStore) => Promise<void>): Promise<void> {
    const p = this.persistence;
    if (!p) return Promise.resolve();
    const next = (this.saves.get(key) ?? Promise.resolve()).then(() => write(p.store)).catch((err) => p.failed(op, err));
    this.saves.set(key, next);
    void next.then(() => this.saves.get(key) === next && this.saves.delete(key));
    return next;
  }

  // Repo-relative path → absolute path inside root, or null if it escapes the workspace.
  resolvePath(path: unknown): string | null {
    // Wire paths have exactly one spelling on every host. In particular, do not
    // resolve aliases and then key locks/versions by the unnormalized input.
    if (typeof path !== "string" || /[\\:\x00-\x1f\x7f]/.test(path)) return null;
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p) || p.toLowerCase() === ".git" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return null;
    const full = resolve(this.root, path);
    return full.startsWith(this.root + sep) ? full : null;
  }

  allLocks(): Lock[] {
    return [...this.locks.values()].map(publicLock);
  }

  // A user's lock request conflicts with anyone else's lock on the same path, a folder above it,
  // or (for folder claims) anything inside it. The user's own agent run counts as someone else:
  // while a run edits a file, its owner's editor is read-only.
  conflict(path: string, kind: Lock["kind"], userId: string): HeldLock | undefined {
    for (const l of this.locks.values()) {
      if (l.holder === userId && l.holderType === "user") continue;
      const above = l.kind === "dir" && path.startsWith(l.path);
      const same = l.path === path;
      const inside = kind === "dir" && l.path.startsWith(path);
      if (same || above || inside) return l;
    }
    return undefined;
  }

  acquire(path: string, kind: Lock["kind"], userId: string): AcquireResult {
    this.assertFenced();
    const target = kind === "dir" && path.endsWith("/") ? path.slice(0, -1) : path;
    if (!this.resolvePath(target) || (kind === "dir" && !path.endsWith("/"))) throw new Error("Noncanonical workspace path");
    const held = this.conflict(path, kind, userId);
    if (held) return { ok: false, code: "HELD", lock: publicLock(held) };
    const now = this.now();
    const existing = this.locks.get(path);
    if (existing) {
      existing.expiresAt = now + this.timing.leaseMs;
      return { ok: true, lock: publicLock(existing), created: false };
    }
    const lock: HeldLock = { path, kind, holder: userId, holderType: "user", expiresAt: now + this.timing.leaseMs, lastEditAt: now };
    this.locks.set(path, lock);
    void this.save(`lock:${path}`, "putLock", (s) => s.putLock({ path, kind, holder: userId }));
    return { ok: true, lock: publicLock(lock), created: true };
  }

  release(path: string, userId: string): Lock | null {
    this.assertFenced();
    const lock = this.locks.get(path);
    if (!lock || lock.holder !== userId || lock.holderType !== "user") return null;
    this.locks.delete(path);
    void this.save(`lock:${path}`, "deleteLock", (s) => s.deleteLock(path));
    return publicLock(lock);
  }

  // Renews every lease the user holds and reports the ones that expired since the last beat.
  heartbeat(userId: string): string[] {
    const expiresAt = this.now() + this.timing.leaseMs;
    for (const l of this.locks.values()) if (l.holder === userId && l.holderType === "user" && !this.expiryReason(l)) l.expiresAt = expiresAt;
    const expired = this.expiredFor.get(userId) ?? [];
    this.expiredFor.delete(userId);
    return expired;
  }

  // Drops leases past expiry (no heartbeat) or idle too long (no edits). Agent run leases are
  // kept alive by the harness, which the mock doesn't have, so they only expire.
  sweep(): { lock: Lock; reason: LockChangeReason }[] {
    this.assertFenced();
    const dropped: { lock: Lock; reason: LockChangeReason }[] = [];
    for (const [path, l] of this.locks) {
      const reason = this.expiryReason(l);
      if (!reason) continue;
      this.locks.delete(path);
      if (l.holderType === "user") void this.save(`lock:${path}`, "deleteLock", (s) => s.deleteLock(path));
      this.expiredFor.set(l.holder, [...(this.expiredFor.get(l.holder) ?? []), path]);
      dropped.push({ lock: publicLock(l), reason });
    }
    return dropped;
  }

  // The user's own lock that covers a file: on the file itself or on a folder above it.
  coveringLock(path: string, userId: string): HeldLock | undefined {
    for (const l of this.locks.values()) {
      if (l.holder !== userId || l.holderType !== "user") continue;
      if (l.path === path || (l.kind === "dir" && path.startsWith(l.path))) return l;
    }
    return undefined;
  }

  // A path can look inside the workspace and still be a symlink to somewhere else (a real repo
  // can contain `secrets -> /etc`), so check where it actually lands before touching it.
  private async inside(full: string, writing = false): Promise<boolean> {
    this.realRoot ??= realpath(this.root);
    try {
      const [root, real] = await Promise.all([this.realRoot, realpath(full)]);
      if (!real.startsWith(root + sep) || relative(root, real).split(sep).some((p) => p.toLowerCase() === ".git")) return false;
      if (!writing) return true; // Internal aliases remain browseable, never independent writers.
      let cursor = root;
      for (const part of relative(this.root, full).split(sep)) {
        // Reject symlink/junction and case aliases rather than giving them
        // independent locks. A physical file must have exactly one directory entry.
        if (!(await readdir(cursor)).includes(part)) return false;
        cursor = join(cursor, part);
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // The text editors see, or why it can't be edited here. null = no such file.
  async open(path: string): Promise<ReadResult> {
    const cached = this.files.get(path);
    if (cached) return cached;
    const full = this.resolvePath(path);
    if (!full || !(await this.inside(full))) return null;
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
      if (info.size > MAX_FILE_BYTES) return { unsupported: "too_large" };
      const content = await readFile(full, "utf8");
      if (content.includes("\0")) return { unsupported: "binary" };
      // Another read may have loaded it while this one awaited the disk.
      const state = this.files.get(path) ?? { content, version: this.restoredVersions.get(path) ?? 1 };
      this.files.set(path, state);
      return state;
    } catch {
      return null;
    }
  }

  // Accepted only from the lock holder, built on the current version, with ops that fit the text.
  // With `runId`, the edit is that agent run's and must hold the run's own lock; it still counts
  // as the owner's edit for commit ownership.
  // Only editable text files; see open() for why one isn't.
  async read(path: string): Promise<FileState | null> {
    const file = await this.open(path);
    return file && "content" in file ? file : null;
  }

  async applyOps(path: string, userId: string, baseVersion: number, ops: Op[], runId?: string, authorized?: () => boolean): Promise<OpsResult> {
    while (this.gate && (this.gate.paths === "all" || this.gate.paths.has(path))) await this.gate.open;
    return this.applyOpsInside(path, userId, baseVersion, ops, runId, authorized);
  }

  private async applyOpsInside(path: string, userId: string, baseVersion: number, ops: Op[], runId?: string, authorized?: () => boolean): Promise<OpsResult> {
    const write = (this.writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<OpsResult> => {
      if (authorized && !authorized()) throw new Error("Write authorization expired");
      const file = await this.read(path);
      const full = this.resolvePath(path);
      if (!file || !full || !(await this.inside(full, true))) return { ok: false, code: "NOT_HOLDER", currentVersion: file?.version ?? 0 };
      const before = runId ? this.runLock(path, runId) : this.coveringLock(path, userId);
      if (!before || before.holder !== userId || before.expiresAt <= this.now()) return { ok: false, code: "NOT_HOLDER", currentVersion: file.version };
      if (baseVersion !== file.version || !Array.isArray(ops) || applyOps(file.content, ops) === null) return { ok: false, code: "STALE", currentVersion: file.version };
      // Registered in writes before any await: a container launch under freeze
      // must drain this operation. Unauthorized attempts never reach the fence.
      await this.writeFence?.(path);
      if (!(await this.inside(full, true))) return { ok: false, code: "NOT_HOLDER", currentVersion: file.version };
      const handle = await openFile(full, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) return { ok: false, code: "NOT_HOLDER", currentVersion: file.version };
        const lock = runId ? this.runLock(path, runId) : this.coveringLock(path, userId);
        if (!lock || lock.holder !== userId || lock.expiresAt <= this.now()) return { ok: false, code: "NOT_HOLDER", currentVersion: file.version };
        if (baseVersion !== file.version || !Array.isArray(ops)) return { ok: false, code: "STALE", currentVersion: file.version };
        const next = applyOps(file.content, ops);
        if (next === null || Buffer.byteLength(next) > MAX_FILE_BYTES) return { ok: false, code: "STALE", currentVersion: file.version };
        const temporary = `${full}.pineagent-${randomUUID()}`;
        try {
          const staged = await openFile(temporary, "wx", 0o600);
          try { await staged.writeFile(next, "utf8"); await staged.sync(); await staged.chmod(info.mode & 0o777); }
          finally { await staged.close(); }
          // Preserve the existing restart fence: reserve the next persisted
          // version first. In-memory state changes only after the disk succeeds.
          await this.save(`file:${path}`, "saveFile", (s) => s.saveFile(path, file.version + 1, userId));
          await handle.close(); // Windows refuses replacement while this handle is open.
          if (authorized && !authorized()) throw new Error("Write authorization expired");
          await rename(temporary, full);
        } finally { await rm(temporary, { force: true }); }
        // A successful disk write, not a proposed edit, advances shared memory.
        file.content = next;
        file.version += 1;
        lock.lastEditAt = this.now();
        this.editors.set(path, new Set([...(this.editors.get(path) ?? []), userId]));
        return { ok: true, version: file.version };
      } finally { await handle.close(); }
    });
    const completion = write.then(() => {}, () => {});
    this.writes.set(path, completion);
    try { return await write; }
    finally { if (this.writes.get(path) === completion) this.writes.delete(path); }
  }

  // One authority barrier spans evidence validation and every file in a model
  // patch. Unrelated collaborators cannot change an observed dependency midway.
  // Disk failures can still leave a partial patch; successful files are reported
  // immediately and are never silently rolled back over another user's work.
  async applyRunPatch(ownerId: string, runId: string, observed: ReadonlyMap<string, FileState>,
    files: { path: string; content: string }[], applied: (path: string, version: number, ops: Op[]) => void): Promise<void> {
    const release = await this.freeze("all");
    try {
      for (const [path, expected] of observed) {
        const actual = await this.read(path);
        if (!actual || expected.version !== actual.version || expected.content !== actual.content) throw new Error("Evidence changed; a fresh run is required");
      }
      for (const file of files) {
        const lock = this.runLock(file.path, runId);
        if (!observed.has(file.path) || !lock || lock.holder !== ownerId) throw new Error("Run no longer owns its write set");
      }
      for (const file of files) {
        const expected = observed.get(file.path)!;
        const ops = [{ offset: 0, length: expected.content.length, text: file.content }];
        const result = await this.applyOpsInside(file.path, ownerId, expected.version, ops, runId);
        if (!result.ok) throw new Error(`Workspace rejected patch: ${result.code}`);
        applied(file.path, result.version, ops);
      }
    } finally { release(); }
  }

  // --- Agent run locks (the harness keeps them alive, so they never expire) -------------------

  // All-or-nothing, like the real harness's DynamoDB transaction: either every path is locked for
  // the run or none is, and the first conflicting lock is returned. The owner's own editor lock
  // conflicts too; their agent waits until they let go of the file.
  acquireForRun(paths: string[], ownerId: string, runId: string): { ok: true; locks: Lock[] } | { ok: false; lock: Lock } {
    this.assertFenced();
    if (!paths.every((p) => this.resolvePath(p))) throw new Error("Noncanonical workspace path");
    for (const path of paths) {
      for (const l of this.locks.values()) {
        if (l.runId === runId && l.holder === ownerId) continue;
        const above = l.kind === "dir" && path.startsWith(l.path);
        if (l.path === path || above) return { ok: false, lock: publicLock(l) };
      }
    }
    const now = this.now();
    const created = paths.map((path) => {
      const lock: HeldLock = { path, kind: "file", holder: ownerId, holderType: "run", runId, expiresAt: Number.MAX_SAFE_INTEGER, lastEditAt: now };
      this.locks.set(path, lock);
      return publicLock(lock);
    });
    return { ok: true, locks: created };
  }

  releaseRun(runId: string): Lock[] {
    this.assertFenced();
    const released: Lock[] = [];
    for (const [path, l] of this.locks) {
      if (l.runId !== runId) continue;
      this.locks.delete(path);
      released.push(publicLock(l));
    }
    return released;
  }

  private runLock(path: string, runId: string): HeldLock | undefined {
    const l = this.locks.get(path);
    return l?.holderType === "run" && l.runId === runId ? l : undefined;
  }

  // --- Support for the Git queue ------------------------------------------------------------

  editorsOf(path: string): string[] {
    return [...(this.editors.get(path) ?? [])];
  }

  clearEditors(paths: string[]) {
    for (const p of paths) {
      this.editors.delete(p);
      // Same queue as the path's edits, so a later edit's editor can't be wiped by this clear.
      void this.save(`file:${p}`, "clearEditors", (s) => s.clearEditors([p]));
    }
  }

  // Someone other than this user (or this user's agent run) holds a lock covering the path.
  lockedByOther(path: string, userId: string): Lock | undefined {
    const l = this.conflict(path, "file", userId);
    return l ? publicLock(l) : undefined;
  }

  // Hold edits to `paths` (or everything) until the returned function is called, then wait for
  // writes already past the gate to reach disk.
  async freeze(paths: string[] | "all"): Promise<() => void> {
    // Reserve our turn before yielding. Independent Git/lease freezes must not
    // overwrite each other's barrier or leave waiting edits stranded forever.
    const previous = this.freezeTail;
    let finish!: () => void;
    this.freezeTail = new Promise<void>((r) => { finish = r; });
    await previous;
    let open!: () => void;
    this.gate = { paths: paths === "all" ? "all" : new Set(paths), open: new Promise<void>((r) => (open = r)) };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.gate = null;
      open();
      finish();
    };
    try {
      const pending = paths === "all" ? [...this.writes.values()] : paths.map((p) => this.writes.get(p));
      await Promise.all(pending);
      await this.leaseFence?.();
      return release;
    } catch (error) { release(); throw error; }
  }

  // After Git changed a file on disk: load it, bump the version, and return the old text so the
  // caller can broadcast the change. null when the file no longer exists.
  async reloadFromDisk(path: string): Promise<{ before: string; after: string; version: number } | null> {
    const full = this.resolvePath(path);
    const state = this.files.get(path);
    let after: string;
    try {
      // Pulled-in symlinks that leave the workspace are treated like deleted files.
      if (!full || !(await this.inside(full))) throw new Error("outside the workspace");
      after = await readFile(full, "utf8");
    } catch {
      this.files.delete(path);
      return null;
    }
    if (!state) {
      // Never loaded since a restart: anyone who saw the old text holds the restored version.
      const restored = this.restoredVersions.get(path);
      const version = restored === undefined ? 1 : restored + 1;
      this.files.set(path, { content: after, version });
      if (restored !== undefined) await this.save(`file:${path}`, "saveFile", (s) => s.saveFile(path, version));
      return { before: "", after, version };
    }
    const before = state.content;
    if (before !== after) {
      state.content = after;
      state.version += 1;
      await this.save(`file:${path}`, "saveFile", (s) => s.saveFile(path, state.version));
    }
    return { before, after, version: state.version };
  }
}
