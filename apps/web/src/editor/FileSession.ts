import type { Lock, LockAcquireAck, Op, OpsAck, ServerToClientEvents, SnapshotAck } from "../contracts/socket";
import { applyOps } from "../shared/ops";

// One open file's editing state, following contracts/SOCKET_LOCKS_AND_FILES.md.
// Pure TypeScript: no React, no Monaco, no socket. The SessionManager supplies the server side
// (SessionPort) and the editor binds an EditorSink to receive text changes.

export type SessionStatus =
  | "loading" // waiting for a fresh snapshot; cached text may be shown read-only
  | "viewing" // up to date, nobody holds the file; the first keystroke takes the lock
  | "acquiring" // typed optimistically, lock request in flight (D1)
  | "writing" // this user holds the lock; edits flush every 100 ms
  | "readonly" // someone else (or this user's agent) holds the lock
  | "missing" // the server doesn't have the file
  | "unsupported" // binary or too large to edit here (see `unsupported`)
  | "error"; // the snapshot request failed; retry with open()

export type SessionState = {
  path: string;
  status: SessionStatus;
  text: string; // what the editor shows, including unsent keystrokes
  version: number; // server version `text` is built on; 0 = never loaded
  holder: Lock | null; // the lock that makes this file read-only for us
  lostText: string | null; // D2: the user's unsaved text, offered via "Copy my version"
  heldNotice: Lock | null; // D1: set when we lost the race for the lock
  inFlight: boolean; // a batch is waiting for its ack
  unsupported: "binary" | "too_large" | null;
};

export interface SessionPort {
  connected(): boolean; // joined the room, not just socket-connected
  selfId(): string | null;
  lockFor(path: string): Lock | undefined; // lock on the file or a folder above it
  acquire(path: string): Promise<LockAcquireAck>;
  sendOps(path: string, baseVersion: number, ops: Op[]): Promise<OpsAck>;
  snapshot(path: string): Promise<SnapshotAck>;
  release(path: string): void;
}

// How a session changes the editor's text for anything that isn't the user's own typing.
export interface EditorSink {
  replace(text: string): void;
  apply(ops: Op[]): void;
}

type Changed = Parameters<ServerToClientEvents["file:changed"]>[0];

export class FileSession {
  private state: SessionState;
  private base: string; // text at state.version as the server has it
  private pending: Op[] = []; // typed, not yet sent
  private inflight: { baseVersion: number; ops: Op[] } | null = null;
  private gen = 0; // bumped to ignore async results that belong to an older situation
  private newestSeen = 0; // highest version announced while a snapshot was loading
  private leaving = false; // release the lock once everything is flushed
  private releaseRequested = false; // "Release lock" while staying on the file
  private opened = false; // shown in the editor; closed sessions stay as a cache and don't fetch
  // While recovery compares our version with the server's, sending would race it and could apply
  // a batch twice, so tick() waits.
  private recovering = false;
  private sink: EditorSink | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly path: string,
    private readonly port: SessionPort,
  ) {
    this.base = "";
    this.state = { path, status: "loading", text: "", version: 0, holder: null, lostText: null, heldNotice: null, inFlight: false, unsupported: null };
  }

  // --- React / editor plumbing -------------------------------------------------------------

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  bind(sink: EditorSink | null) {
    this.sink = sink;
  }

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch, inFlight: Boolean(this.inflight) };
    this.listeners.forEach((l) => l());
  }

  private showText(text: string) {
    if (text !== this.state.text) this.sink?.replace(text);
    this.set({ text });
  }

  // --- Lifecycle --------------------------------------------------------------------------

  open() {
    this.opened = true;
    this.leaving = false;
    // Reopening while still writing (e.g. a quick switch back) just carries on.
    if (this.state.status === "writing" || this.state.status === "acquiring") return;
    void this.load();
  }

  // Leaving the file releases its lock once every typed edit has been acknowledged.
  leave() {
    this.opened = false;
    this.leaving = true;
    this.releaseIfDone();
  }

  // Typed edits the server hasn't acknowledged yet (queued, in flight, or waiting for the lock).
  hasUnsent(): boolean {
    return this.pending.length > 0 || this.inflight !== null;
  }

  // Give the lock back but keep the file open; typing again re-acquires it.
  release() {
    this.releaseRequested = true;
    this.releaseIfDone();
  }

  dismissLost() {
    this.set({ lostText: null });
  }

  clearHeldNotice() {
    this.set({ heldNotice: null });
  }

  // --- Inputs -----------------------------------------------------------------------------

  // The user typed; the editor has already applied `ops` to its buffer.
  localEdit(ops: Op[]) {
    this.releaseRequested = false;
    const text = applyOps(this.state.text, ops);
    if (text === null) return void this.load(); // editor and session disagree: resync
    switch (this.state.status) {
      case "viewing": {
        const { other } = this.lockState();
        if (other) {
          // The lock map already shows a holder: no optimistic edit (contract, D1).
          this.sink?.replace(this.state.text);
          this.set({ status: "readonly", holder: other });
          return;
        }
        this.pending.push(...ops);
        this.set({ status: "acquiring", text });
        void this.acquire();
        return;
      }
      case "acquiring":
      case "writing":
        this.pending.push(...ops);
        this.set({ text });
        return;
      default:
        // The editor should have been read-only; undo the keystroke.
        this.sink?.replace(this.state.text);
    }
  }

  // Called every 100 ms by the manager: send at most one batch, built on the last acked version.
  tick() {
    if (this.state.status !== "writing" || this.inflight || this.recovering || this.pending.length === 0) return;
    if (!this.port.connected()) return;
    const batch = { baseVersion: this.state.version, ops: this.pending };
    this.pending = [];
    this.inflight = batch;
    this.set({});
    const g = this.gen;
    this.port.sendOps(this.path, batch.baseVersion, batch.ops).then(
      (res) => {
        if (g !== this.gen) return;
        if (!res.ok) return this.loseEdits();
        this.base = applyOps(this.base, batch.ops) ?? this.base;
        this.inflight = null;
        this.set({ version: res.version });
        this.releaseIfDone();
      },
      // No ack in time: we can't know whether the server applied it. Work it out from a snapshot.
      () => g === this.gen && void this.recover(),
    );
  }

  // Branch-wide broadcast for this path (D3).
  remoteChanged(m: Changed) {
    if (m.version <= this.state.version) return; // duplicate or old
    if (this.state.status === "loading") {
      this.newestSeen = Math.max(this.newestSeen, m.version);
      return;
    }
    // Someone else changed a file we have unsent edits for (e.g. a formatter): ours can't apply.
    if (this.pending.length || this.inflight) return this.loseEdits();
    if (m.version !== this.state.version + 1) {
      // Gap: we missed something. Open files resync now; cached ones on their next open().
      if (this.opened) return void this.load();
      this.gen++;
      return this.set({ status: "loading" });
    }
    const next = applyOps(this.state.text, m.ops);
    if (next === null) return void this.load();
    this.base = next;
    this.sink?.apply(m.ops);
    this.set({ text: next, version: m.version });
  }

  // The lock map changed (any path). Re-evaluate what this file's lock means for us.
  lockChanged() {
    const { mine, other } = this.lockState();
    switch (this.state.status) {
      case "writing":
        if (mine) return;
        if (this.pending.length || this.inflight) return this.loseEdits();
        return this.set({ status: other ? "readonly" : "viewing", holder: other });
      case "viewing":
      case "readonly":
        return this.set({ status: other ? "readonly" : mine ? "writing" : "viewing", holder: other });
      default:
        // acquiring waits for its ack; loading settles from the lock map when the snapshot lands.
        return;
    }
  }

  // The heartbeat ack listed paths whose lease ran out.
  leaseExpired(paths: string[]) {
    if (!paths.includes(this.path)) return;
    if ((this.state.status === "writing" || this.state.status === "acquiring") && (this.pending.length || this.inflight)) {
      return this.loseEdits();
    }
    this.lockChanged();
  }

  // After a reconnect and a fresh room:join (new lock map). Closed sessions with nothing unsent
  // just go stale and reload on their next open().
  reconnected() {
    if (this.opened || this.pending.length || this.inflight) return void this.recover();
    this.gen++;
    this.set({ status: "loading" });
  }

  // --- Internals ---------------------------------------------------------------------------

  private lockState(): { mine: boolean; other: Lock | null } {
    const lock = this.port.lockFor(this.path);
    if (!lock) return { mine: false, other: null };
    const mine = lock.holder === this.port.selfId() && lock.holderType === "user";
    return { mine, other: mine ? null : lock };
  }

  private settled(): Pick<SessionState, "status" | "holder"> {
    const { mine, other } = this.lockState();
    return { status: other ? "readonly" : mine ? "writing" : "viewing", holder: other };
  }

  private async load() {
    const g = ++this.gen;
    this.pending = [];
    this.inflight = null;
    this.newestSeen = 0;
    this.set({ status: "loading" });
    if (!this.port.connected()) return; // reconnected() will load
    let res: SnapshotAck;
    try {
      res = await this.port.snapshot(this.path);
    } catch {
      if (g === this.gen) this.set({ status: "error" });
      return;
    }
    if (g !== this.gen) return;
    if (!res.ok) return this.set(notEditable(res));
    this.base = res.content;
    this.showText(res.content);
    this.set({ ...this.settled(), version: res.version, unsupported: null });
    // A change was announced while the snapshot was in flight and the snapshot predates it.
    if (this.newestSeen > res.version) void this.load();
    this.releaseIfDone();
  }

  private async acquire() {
    const g = this.gen;
    let res: LockAcquireAck;
    try {
      res = await this.port.acquire(this.path);
    } catch {
      if (g === this.gen) void this.recover();
      return;
    }
    if (g !== this.gen || this.state.status !== "acquiring") return;
    if (res.ok) return this.set({ status: "writing", holder: null });
    this.acquireLost(res.lock);
  }

  // D2: keep a copy of what the user had, then reload the server's version.
  private loseEdits() {
    const lostText = this.state.text;
    this.set({ lostText });
    void this.load();
  }

  // Work out where we stand after a reconnect or an unanswered request.
  private async recover() {
    if (!this.port.connected()) return; // reconnected() calls back here once rejoined
    const unsent = [...(this.inflight?.ops ?? []), ...this.pending];
    const typing = this.state.status === "writing" || this.state.status === "acquiring";
    if (!typing || unsent.length === 0) return void this.load();

    const { mine, other } = this.lockState();
    if (other && this.state.status === "acquiring") {
      // The lock went to someone else while we were away: same as losing the race.
      return void this.acquireLost(other);
    }
    if (!mine) {
      if (this.state.status === "acquiring" && !other) return void this.acquire(); // still free: ask again
      return this.loseEdits();
    }

    const g = ++this.gen;
    let res: SnapshotAck;
    this.recovering = true;
    try {
      res = await this.port.snapshot(this.path);
    } catch {
      return;
    } finally {
      this.recovering = false;
    }
    if (g !== this.gen) return;
    if (!res.ok) return this.set(notEditable(res));
    const inflight = this.inflight;
    if (res.version === this.state.version) {
      // The server never got the in-flight batch: send it again, followed by the rest.
      this.pending = unsent;
      this.inflight = null;
      this.set({ status: "writing" });
    } else if (inflight && res.version === this.state.version + 1 && applyOps(this.base, inflight.ops) === res.content) {
      // It did get it; only the ack was lost.
      this.base = res.content;
      this.inflight = null;
      this.set({ status: "writing", version: res.version });
    } else {
      this.loseEdits();
    }
  }

  // D1: someone else got the lock first. Put back the last saved text and go read-only.
  private acquireLost(lock: Lock) {
    this.gen++;
    this.pending = [];
    this.inflight = null;
    this.showText(this.base);
    this.set({ status: "readonly", holder: lock, heldNotice: lock });
  }

  private releaseIfDone() {
    if (!(this.leaving || this.releaseRequested) || this.pending.length || this.inflight) return;
    this.releaseRequested = false;
    if (this.lockState().mine && this.port.connected()) this.port.release(this.path);
  }
}

function notEditable(res: Extract<SnapshotAck, { ok: false }>): Partial<SessionState> {
  return res.code === "UNSUPPORTED"
    ? { status: "unsupported", unsupported: res.reason, holder: null }
    : { status: "missing", holder: null };
}
