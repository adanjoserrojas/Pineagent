// One branch's shared state on the mock: its files, their versions, and the lock table.
// No sockets here, so the rules can be unit-tested with a fake clock.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Lock, LockChangeReason, Op } from "../src/contracts/socket";
import { applyOps } from "../src/shared/ops";

export type Timing = { leaseMs: number; idleMs: number };
type HeldLock = Lock & { lastEditAt: number };
type FileState = { content: string; version: number };

export type AcquireResult = { ok: true; lock: Lock; created: boolean } | { ok: false; code: "HELD"; lock: Lock };
export type OpsResult = { ok: true; version: number } | { ok: false; code: "NOT_HOLDER" | "STALE"; currentVersion: number };

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

  constructor(
    readonly root: string,
    private readonly timing: Timing,
    private readonly now: () => number = Date.now,
  ) {}

  // Repo-relative path → absolute path inside root, or null if it escapes the workspace.
  resolvePath(path: unknown): string | null {
    if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\0")) return null;
    // Git's own files are never readable or editable through the workspace.
    if (path.split(/[\\/]/).includes(".git")) return null;
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
    return { ok: true, lock: publicLock(lock), created: true };
  }

  release(path: string, userId: string): Lock | null {
    const lock = this.locks.get(path);
    if (!lock || lock.holder !== userId || lock.holderType !== "user") return null;
    this.locks.delete(path);
    return publicLock(lock);
  }

  // Renews every lease the user holds and reports the ones that expired since the last beat.
  heartbeat(userId: string): string[] {
    const expiresAt = this.now() + this.timing.leaseMs;
    for (const l of this.locks.values()) if (l.holder === userId && l.holderType === "user") l.expiresAt = expiresAt;
    const expired = this.expiredFor.get(userId) ?? [];
    this.expiredFor.delete(userId);
    return expired;
  }

  // Drops leases past expiry (no heartbeat) or idle too long (no edits). Agent run leases are
  // kept alive by the harness, which the mock doesn't have, so they only expire.
  sweep(): { lock: Lock; reason: LockChangeReason }[] {
    const now = this.now();
    const dropped: { lock: Lock; reason: LockChangeReason }[] = [];
    for (const [path, l] of this.locks) {
      const reason = l.expiresAt <= now ? "expired" : l.holderType === "user" && now - l.lastEditAt >= this.timing.idleMs ? "idle" : null;
      if (!reason) continue;
      this.locks.delete(path);
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

  async read(path: string): Promise<FileState | null> {
    const cached = this.files.get(path);
    if (cached) return cached;
    const full = this.resolvePath(path);
    if (!full) return null;
    try {
      const content = await readFile(full, "utf8");
      // Another read may have loaded it while this one awaited the disk.
      const state = this.files.get(path) ?? { content, version: 1 };
      this.files.set(path, state);
      return state;
    } catch {
      return null;
    }
  }

  // Accepted only from the lock holder, built on the current version, with ops that fit the text.
  async applyOps(path: string, userId: string, baseVersion: number, ops: Op[]): Promise<OpsResult> {
    const file = await this.read(path);
    // Checked after the last await before mutating, so a freeze() can't slip in between.
    while (this.gate && (this.gate.paths === "all" || this.gate.paths.has(path))) await this.gate.open;
    if (!file) return { ok: false, code: "NOT_HOLDER", currentVersion: 0 };
    const lock = this.coveringLock(path, userId);
    if (!lock) return { ok: false, code: "NOT_HOLDER", currentVersion: file.version };
    if (baseVersion !== file.version || !Array.isArray(ops)) return { ok: false, code: "STALE", currentVersion: file.version };
    const next = applyOps(file.content, ops);
    if (next === null) return { ok: false, code: "STALE", currentVersion: file.version };

    // Update memory synchronously so the next batch sees this version, then persist before acking.
    file.content = next;
    file.version += 1;
    lock.lastEditAt = this.now();
    this.editors.set(path, new Set([...(this.editors.get(path) ?? []), userId]));
    const full = this.resolvePath(path)!;
    const write = (this.writes.get(path) ?? Promise.resolve()).then(() => writeFile(full, next, "utf8"));
    this.writes.set(path, write);
    await write;
    return { ok: true, version: file.version };
  }

  // --- Support for the Git queue ------------------------------------------------------------

  editorsOf(path: string): string[] {
    return [...(this.editors.get(path) ?? [])];
  }

  clearEditors(paths: string[]) {
    paths.forEach((p) => this.editors.delete(p));
  }

  // Someone other than this user (or this user's agent run) holds a lock covering the path.
  lockedByOther(path: string, userId: string): Lock | undefined {
    const l = this.conflict(path, "file", userId);
    return l ? publicLock(l) : undefined;
  }

  // Hold edits to `paths` (or everything) until the returned function is called, then wait for
  // writes already past the gate to reach disk.
  async freeze(paths: string[] | "all"): Promise<() => void> {
    let open!: () => void;
    this.gate = { paths: paths === "all" ? "all" : new Set(paths), open: new Promise<void>((r) => (open = r)) };
    const pending = paths === "all" ? [...this.writes.values()] : paths.map((p) => this.writes.get(p));
    await Promise.all(pending);
    return () => {
      this.gate = null;
      open();
    };
  }

  // After Git changed a file on disk: load it, bump the version, and return the old text so the
  // caller can broadcast the change. null when the file no longer exists.
  async reloadFromDisk(path: string): Promise<{ before: string; after: string; version: number } | null> {
    const full = this.resolvePath(path);
    const state = this.files.get(path);
    let after: string;
    try {
      after = await readFile(full!, "utf8");
    } catch {
      this.files.delete(path);
      return null;
    }
    if (!state) {
      this.files.set(path, { content: after, version: 1 });
      return { before: "", after, version: 1 };
    }
    const before = state.content;
    if (before !== after) {
      state.content = after;
      state.version += 1;
    }
    return { before, after, version: state.version };
  }
}
