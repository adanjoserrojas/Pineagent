import type { ServerToClientEvents } from "../contracts/socket";
import type { WorkspaceSocket } from "../net/socket";
import type { WorkspaceStore } from "../state/workspace";
import { coveringDirLock, lockOn } from "../tree/model";
import { FileSession, type SessionPort } from "./FileSession";

const FLUSH_MS = 100; // contract: the writer sends at most every 100 ms
const ACK_TIMEOUT_MS = 5000;

// Owns every FileSession and feeds them from the socket and the store: the flush timer, the
// lease heartbeat, file:changed broadcasts, lock-table changes and reconnects. Sessions outlive
// the editor tab that showed them and act as the snapshot cache.
export class SessionManager {
  private readonly sessions = new Map<string, FileSession>();
  private readonly port: SessionPort;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly socket: WorkspaceSocket,
    private readonly store: WorkspaceStore,
  ) {
    this.port = {
      connected: () => store.get().connection === "connected",
      selfId: () => store.get().self?.userId ?? null,
      lockFor: (p) => {
        const locks = store.get().locks;
        return lockOn(p, locks) ?? coveringDirLock(p, locks);
      },
      acquire: (p) => socket.timeout(ACK_TIMEOUT_MS).emitWithAck("lock:acquire", { path: p, kind: "file" }),
      sendOps: (p, baseVersion, ops) => socket.timeout(ACK_TIMEOUT_MS).emitWithAck("file:ops", { path: p, baseVersion, ops }),
      snapshot: (p) => socket.timeout(ACK_TIMEOUT_MS).emitWithAck("file:snapshot", { path: p }),
      release: (p) => {
        socket.emit("lock:release", { path: p }, () => {});
      },
    };

    this.flushTimer = setInterval(() => this.sessions.forEach((s) => s.tick()), FLUSH_MS);

    const onChanged: ServerToClientEvents["file:changed"] = (m) => this.sessions.get(m.path)?.remoteChanged(m);
    socket.on("file:changed", onChanged);
    this.cleanups.push(() => socket.off("file:changed", onChanged));

    let { locks, connection, timing } = store.get();
    this.cleanups.push(
      store.subscribe(() => {
        const next = store.get();
        if (next.connection !== connection) {
          connection = next.connection;
          // A (re)join replaces the lock table too; reconnected() reads the fresh one.
          if (connection === "connected") this.sessions.forEach((s) => s.reconnected());
          locks = next.locks;
        } else if (next.locks !== locks) {
          locks = next.locks;
          this.sessions.forEach((s) => s.lockChanged());
        }
        if (next.timing !== timing) {
          timing = next.timing;
          this.startHeartbeat();
        }
      }),
    );
    this.startHeartbeat();
  }

  get(path: string): FileSession {
    let s = this.sessions.get(path);
    if (!s) {
      s = new FileSession(path, this.port);
      this.sessions.set(path, s);
    }
    return s;
  }

  open(path: string): FileSession {
    const s = this.get(path);
    s.open();
    return s;
  }

  leave(path: string) {
    this.sessions.get(path)?.leave();
  }

  dispose() {
    clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.cleanups.forEach((c) => c());
  }

  // Renews every lease this user holds, at the rate the server asked for in room:join.
  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const timing = this.store.get().timing;
    if (!timing) return;
    this.heartbeatTimer = setInterval(async () => {
      if (!this.port.connected()) return;
      try {
        const { expired } = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck("session:heartbeat", {});
        if (expired.length) this.sessions.forEach((s) => s.leaseExpired(expired));
      } catch {
        // A missed beat is fine; the lease covers three of them.
      }
    }, timing.heartbeatMs);
  }
}
