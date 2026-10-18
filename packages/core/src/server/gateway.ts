// The Socket.IO gateway: rooms, presence, locks, live edits, Git and runs (contracts/*.md).
// One implementation for the dev mock and the real server; what differs is passed in: how users
// authenticate, who may join a repository, how a branch's worktree is prepared, whose credentials
// reach GitHub, and which agent harness runs.
import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  UNAUTHENTICATED,
  roomName,
  type ClientToServerEvents,
  type Member,
  type ServerToClientEvents,
} from "../contracts";
import type { User } from "./auth0";
import { ChangeFeed } from "./gitChanges";
import type { GitRepo } from "./git";
import { GitQueue, type Author } from "./gitQueue";
import { noHarness, type Harness, type HarnessFactory } from "./harness";
import type { Store } from "./store";
import { Workspace } from "./workspace";

export type Room = { id: string; ws: Workspace; repo: GitRepo; queue: GitQueue; harness: Harness; changes: ChangeFeed };

export type JoinContext = { roomId: string; wsId: string; branch: string; user: User };

export type GatewayOptions = {
  http: HttpServer;
  allowedOrigins: (string | RegExp)[];
  authenticate(token: unknown): Promise<User | null>;
  // Required for backend-issued scoped sessions; missing validation fails closed.
  sessionActive?(user: User): boolean;
  // May this user open this repository? (The server asks GitHub; the mock says yes.)
  authorize?(ctx: JoinContext): Promise<"ok" | "NOT_COLLABORATOR" | "UNAVAILABLE">;
  // Make the branch's worktree exist (clone, or a temp copy of a fixture) and return its repo.
  prepare(ctx: JoinContext): Promise<GitRepo>;
  // Environment for git fetch/push as this user (their own GitHub token).
  gitCredentials?(userId: string): Promise<Record<string, string>>;
  author?(user: User): Author;
  harness?: HarnessFactory;
  // Installs sandbox fences before any user or run can mutate room authority.
  protect?(ws: Workspace, ctx: JoinContext): Promise<void>;
  terminal?(ws: Workspace, ownerId: string, line: string): Promise<{ event: string; body: Record<string, unknown> }>;
  // Where locks, versions and editors are kept so a restart can restore them. None = memory only.
  store?: Store;
  timing?: { heartbeatMs: number; leaseMs: number; idleMs: number; sweepMs: number };
  snapshotDelayMs?: number; // simulates a slow server for the browser's loading states
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

type SocketData = { user: User; room?: string; scope?: { wsId: string; branch: string }; openPath: string | null; budget: { tokens: number; at: number } };
type GatewaySocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

// Abuse limits. A person typing produces ~10 events a second; anything far above that is a bug or worse.
const EVENTS_PER_SEC = 50;
const EVENT_BURST = 200;
const MAX_OPS_PER_BATCH = 1000;
const MAX_BATCH_TEXT = 1_000_000;
// wsId is "demo" or "owner/repo" and becomes part of a path on disk, so no "." or ".." segments.
const NAME = /^(?!\.\.?(\/|$))[A-Za-z0-9._-]{1,100}(\/(?!\.\.?$)[A-Za-z0-9._-]{1,100})?$/;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._\/-]{1,200}$/;

const presenceOf = (user: User) => ({ userId: user.id, name: user.name, avatarUrl: user.avatarUrl });

export function createGateway(opts: GatewayOptions) {
  const { heartbeatMs, leaseMs, idleMs, sweepMs } = opts.timing ?? {
    heartbeatMs: 10_000,
    leaseMs: 30_000,
    idleMs: 600_000,
    sweepMs: 1_000,
  };
  const log = opts.log ?? (() => {});
  const active = (user: User) => !user.session || (user.session.expiresAt > Date.now() && opts.sessionActive?.(user) === true);
  const authorOf = opts.author ?? ((u: User) => ({ id: u.id, name: u.name, email: `${u.name}@users.noreply.github.com` }));
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(opts.http, {
    cors: { origin: opts.allowedOrigins },
    maxHttpBufferSize: 2_000_000, // one ops batch or snapshot, with headroom
  });

  // One Room per branch: its worktree, locks, Git queue, change feed and harness. Created on the
  // first join; a failed preparation is forgotten so the next join tries again.
  const rooms = new Map<string, Promise<Room>>();
  const roomFor = (ctx: JoinContext): Promise<Room> => {
    let r = rooms.get(ctx.roomId);
    if (!r) {
      r = openRoom(ctx);
      r.catch((err) => {
        rooms.delete(ctx.roomId);
        log("room.failed", { room: ctx.roomId, error: String(err) });
      });
      rooms.set(ctx.roomId, r);
    }
    return r;
  };

  async function openRoom(ctx: JoinContext): Promise<Room> {
    const room = ctx.roomId;
    const repo = await opts.prepare(ctx);
    const persistence = opts.store && {
      store: opts.store.room(room),
      failed: (op: string, err: unknown) => log("store.failed", { room, op, error: String(err) }),
    };
    const ws = new Workspace(repo.dir, { leaseMs, idleMs }, Date.now, persistence);
    // A store that can't be read leaves the room empty, as if it were the first start.
    const restored = await ws.restore().catch((err) => {
      log("store.failed", { room, op: "load", error: String(err) });
      return null;
    });
    if (restored?.locks || restored?.files) log("room.restored", { room, ...restored });
    await opts.protect?.(ws, ctx);
    const changes = new ChangeFeed(repo, (list) => io.to(room).emit("git:changes", { changes: list }));
    const queue = new GitQueue(
      ws,
      repo,
      {
        queue: (jobs) => io.to(room).emit("git:queue", { jobs }),
        result: (res) => {
          io.to(room).emit("git:result", res);
          changes.poke();
        },
        fileChanged: (path, before, after, version) =>
          io.to(room).emit("file:changed", {
            path,
            version,
            ops: [{ offset: 0, length: before.length, text: after }],
            author: "git",
            source: "shell",
          }),
        treeChanged: (path, change) => {
          io.to(room).emit("tree:changed", { path, change });
          changes.poke();
        },
      },
      opts.gitCredentials,
    );
    const harness = (opts.harness ?? noHarness)({
      ws,
      roomId: room,
      files: () => repo.listFiles(),
      canWrite: async ownerId => !opts.authorize || await opts.authorize({ ...ctx, user: { id: ownerId, name: ownerId, avatarUrl: null } }).catch(() => "UNAVAILABLE") === "ok",
      events: {
        run: (e) => io.to(room).emit("run:event", e),
        lockChanged: (path, lock, reason) => io.to(room).emit("lock:changed", { path, kind: "file", lock, reason }),
        fileChanged: (path, version, ops, author) => {
          io.to(room).emit("file:changed", { path, version, ops, author, source: "agent" });
          changes.poke();
        },
      },
    });
    log("room.opened", { room });
    return { id: room, ws, repo, queue, harness, changes };
  }

  // Rooms that already exist, by id (for tests and the sweeper; never creates one).
  const existing = (roomId: string) => rooms.get(roomId);

  io.use(async (socket, next) => {
    const user = await opts.authenticate(socket.handshake.auth?.token);
    if (!user || !active(user)) {
      const err = new Error("unauthenticated") as Error & { data?: unknown };
      err.data = { code: UNAUTHENTICATED };
      return next(err);
    }
    socket.data.user = user;
    socket.data.openPath = null;
    socket.data.budget = { tokens: EVENT_BURST, at: Date.now() };
    next();
  });

  async function membersOf(room: string): Promise<Member[]> {
    const byUser = new Map<string, Member>();
    for (const s of await io.in(room).fetchSockets()) {
      const { user, openPath } = s.data;
      byUser.set(user.id, { userId: user.id, name: user.name, avatarUrl: user.avatarUrl, openPath });
    }
    return [...byUser.values()];
  }

  // Leases end here, never on disconnect: Wi-Fi blips are common, so only silence or idleness frees a lock.
  let sweeping = false;
  const sweeper = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const socket of io.sockets.sockets.values()) if (!active(socket.data.user)) socket.disconnect(true);
      for (const [room, pending] of rooms) {
        const r = await pending.catch(() => null);
        try {
          for (const { lock, reason } of await r?.ws.sweepSafely() ?? []) {
            io.to(room).emit("lock:changed", { path: lock.path, kind: lock.kind, lock: null, reason });
          }
        } catch { log("sandbox.fence_failed", { room, operation: "sweep" }); }
      }
    } finally { sweeping = false; }
  }, sweepMs);

  io.on("connection", (socket: GatewaySocket) => {
    const { user } = socket.data;
    let terminalBusy = false;
    log("socket.connected", { user: user.id });
    const joined = async (writing = false) => {
      const id = socket.data.room;
      const r = id ? await existing(id)?.catch(() => null) : null;
      if (!active(user) || !socket.connected) return null;
      if (writing && r && opts.authorize) {
        const scope = socket.data.scope;
        if (!scope || await opts.authorize({ ...scope, roomId: r.id, user }).catch(() => "UNAVAILABLE") !== "ok") return null;
      }
      return r ? { room: r.id, ...r } : null;
    };

    // Token bucket per socket: refills EVENTS_PER_SEC, holds EVENT_BURST.
    socket.use((_packet, next) => {
      if (!active(user)) { socket.disconnect(true); return; }
      const b = socket.data.budget;
      const now = Date.now();
      b.tokens = Math.min(EVENT_BURST, b.tokens + ((now - b.at) / 1000) * EVENTS_PER_SEC);
      b.at = now;
      if (b.tokens < 1) {
        log("socket.rate_limited", { user: user.id });
        socket.disconnect(true);
        return;
      }
      b.tokens -= 1;
      next();
    });

    socket.on("room:join", async ({ wsId, branch }, ack) => {
      if (typeof wsId !== "string" || typeof branch !== "string" || !NAME.test(wsId) || !BRANCH.test(branch)) {
        return ack({ ok: false, code: "NOT_COLLABORATOR" });
      }
      const room = roomName(wsId, branch);
      if (user.session && user.session.roomId !== room) return ack({ ok: false, code: "NOT_COLLABORATOR" });
      const ctx = { roomId: room, wsId, branch, user };
      const verdict = opts.authorize ? await opts.authorize(ctx).catch(() => "UNAVAILABLE" as const) : "ok";
      if (verdict !== "ok") {
        log("room.refused", { room, user: user.id, code: verdict });
        return ack({ ok: false, code: verdict });
      }
      let r: Room;
      try {
        r = await roomFor(ctx);
      } catch {
        return ack({ ok: false, code: "UNAVAILABLE" });
      }
      if (socket.data.room && socket.data.room !== room) socket.leave(socket.data.room);
      socket.data.room = room;
      socket.data.scope = { wsId, branch };
      await socket.join(room);
      const self: Member = { userId: user.id, name: user.name, avatarUrl: user.avatarUrl, openPath: socket.data.openPath };
      const files = await r.repo.listFiles();
      ack({
        ok: true,
        self,
        members: await membersOf(room),
        locks: r.ws.allLocks(),
        tree: [...files, ...(await r.repo.listEmptyDirs(files))].sort(),
        timing: { heartbeatMs, leaseMs },
      });
      socket.to(room).emit("presence:changed", { ...presenceOf(user), status: "joined", openPath: self.openPath });
      socket.emit("git:changes", { changes: await r.changes.forJoin() });
    });

    socket.on("file:snapshot", async ({ path }, ack) => {
      const j = await joined();
      const file = j && j.ws.resolvePath(path) ? await j.ws.open(path) : null;
      if (!file) return ack({ ok: false, code: "NOT_FOUND" });
      if ("unsupported" in file) return ack({ ok: false, code: "UNSUPPORTED", reason: file.unsupported });
      if (opts.snapshotDelayMs) await new Promise((r) => setTimeout(r, opts.snapshotDelayMs));
      const hash = createHash("sha256").update(file.content).digest("hex");
      ack({ ok: true, path, version: file.version, content: file.content, hash });
    });

    socket.on("file:image", async ({ path }, ack) => {
      const j = await joined();
      if (!j || typeof path !== "string") return ack({ ok: false, code: "NOT_FOUND" });
      const res = await j.ws.image(path);
      ack(res.ok ? { ...res, path } : res);
    });

    socket.on("lock:acquire", async ({ path, kind }, ack) => {
      const j = await joined(true);
      const target = kind === "dir" && typeof path === "string" && path.endsWith("/") ? path.slice(0, -1) : path;
      // Malformed requests get no ack; the client's timeout handles it.
      if (!j || (kind !== "file" && kind !== "dir") || !j.ws.resolvePath(target) || (kind === "dir" && !path.endsWith("/"))) return;
      let res;
      try { res = await j.ws.acquireSafely(path, kind, user.id, () => active(user) && socket.connected); }
      catch { log("sandbox.fence_failed", { room: j.room, operation: "acquire" }); socket.disconnect(true); return; }
      await j.ws.lockSaved(path); // written through before the ack (contract rule 5)
      if (res.ok) {
        ack({ ok: true, lock: res.lock });
        if (res.created) io.to(j.room).emit("lock:changed", { path, kind, lock: res.lock, reason: "acquired" });
      } else {
        ack(res);
      }
    });

    socket.on("lock:release", async ({ path }, ack) => {
      const j = await joined(true);
      let released;
      try { released = await j?.ws.releaseSafely(path, user.id, () => active(user) && socket.connected); }
      catch { log("sandbox.fence_failed", { room: j?.room, operation: "release" }); socket.disconnect(true); return; }
      if (released) await j!.ws.lockSaved(path);
      ack({ ok: true });
      if (j && released) io.to(j.room).emit("lock:changed", { path, kind: released.kind, lock: null, reason: "released" });
    });

    socket.on("session:heartbeat", async (_msg, ack) => {
      const j = await joined();
      ack({ ok: true, expired: j ? j.ws.heartbeat(user.id) : [] });
    });

    socket.on("file:ops", async ({ path, baseVersion, ops }, ack) => {
      const j = await joined(true);
      const sane =
        Array.isArray(ops) &&
        ops.length <= MAX_OPS_PER_BATCH &&
        ops.reduce((n, o) => n + (typeof o?.text === "string" ? o.text.length : 0), 0) <= MAX_BATCH_TEXT;
      if (!j || !j.ws.resolvePath(path) || !Number.isInteger(baseVersion) || !sane) {
        return ack({ ok: false, code: "STALE", currentVersion: 0 });
      }
      let res;
      try { res = await j.ws.applyOps(path, user.id, baseVersion, ops, undefined, () => active(user) && socket.connected); }
      catch { log("workspace.write_failed", { room: j.room }); socket.disconnect(true); return; }
      ack(res);
      if (res.ok) {
        // Everyone else in the branch, including this user's other tabs (D3: branch-wide).
        socket.to(j.room).emit("file:changed", { path, version: res.version, ops, author: user.id, source: "editor" });
        j.changes.poke();
      }
    });

    socket.on("tree:create", async ({ path, kind }, ack) => {
      const j = await joined(true);
      if (!j || (kind !== "file" && kind !== "dir")) return ack({ ok: false, code: "INVALID" });
      const res = await j.ws.create(path, kind, user.id, () => active(user) && socket.connected)
        .catch(() => ({ ok: false as const, code: "INVALID" as const }));
      ack(res);
      if (!res.ok) return;
      log("tree.created", { room: j.room, user: user.id, kind });
      io.to(j.room).emit("tree:changed", { path: res.path, change: "add" });
      j.changes.poke();
    });

    socket.on("run:start", async ({ task }, ack) => {
      const j = await joined(true);
      ack(j ? j.harness.start({ id: user.id, name: user.name }, task) : { ok: false, code: "BAD_REQUEST" });
    });

    socket.on("run:list", async (_msg, ack) => {
      const j = await joined();
      ack({ ok: true, runs: j ? j.harness.list() : [] });
    });

    socket.on("run:approve", async (msg, ack) => {
      const j = await joined();
      if (!j || typeof msg?.runId !== "string") return ack({ ok: false, code: "NOT_FOUND" });
      ack(j.harness.approve(msg.runId, user.id, msg as { candidateId?: unknown; none?: unknown; hint?: unknown }));
    });

    socket.on("run:pause", async ({ runId }, ack) => {
      const j = await joined();
      ack(j && typeof runId === "string" ? j.harness.pause(runId, user.id) : { ok: false, code: "NOT_FOUND" });
    });

    socket.on("run:resume", async ({ runId }, ack) => {
      const j = await joined();
      ack(j && typeof runId === "string" ? j.harness.resume(runId, user.id) : { ok: false, code: "NOT_FOUND" });
    });

    socket.on("git:status", async (_msg, ack) => {
      const j = await joined();
      if (!j) return ack({ ok: true, branch: "main", ahead: 0, changes: [], queue: [] });
      ack(await j.queue.status(user.id));
    });

    socket.on("git:commit", async ({ paths, message, push }, ack) => {
      const j = await joined(true);
      const jobId = j?.queue.enqueue(authorOf(user), paths, message, push);
      if (jobId) log("git.enqueued", { room: j!.room, user: user.id, push: push === true });
      ack(jobId ? { ok: true, jobId } : { ok: false, code: "BAD_REQUEST" });
    });

    socket.on("presence:update", ({ openPath }) => {
      const room = socket.data.room;
      if (!room || (openPath !== null && typeof openPath !== "string")) return;
      socket.data.openPath = openPath;
      socket.to(room).emit("presence:changed", { ...presenceOf(user), status: "updated", openPath });
    });

    socket.on("disconnect", async () => {
      const room = socket.data.room;
      if (!room) return;
      // Only announce "left" when this was the user's last socket in the room (e.g. two tabs).
      const stillHere = (await io.in(room).fetchSockets()).some((s) => s.data.user.id === user.id);
      if (!stillHere) io.to(room).emit("presence:changed", { ...presenceOf(user), status: "left" });
    });

    socket.on("terminal:command", async ({ line }, ack) => {
      if (!opts.terminal) return ack({ ok: false, code: "NOT_AVAILABLE" });
      if (terminalBusy || typeof line !== "string" || Buffer.byteLength(line) > 8000) return ack({ ok: false, code: "REFUSED" });
      terminalBusy = true;
      const room = socket.data.room;
      try {
        const j = await joined();
        if (!j || !active(user)) return ack({ ok: false, code: "REFUSED" });
        const request = await opts.terminal(j.ws, user.id, line);
        // Reuse authenticated browser handlers; the CLI has no direct write path.
        const allowed = new Set(["run:start", "run:list", "run:pause", "run:resume", "run:approve", "file:snapshot", "lock:acquire", "lock:release", "git:status"]);
        if (!allowed.has(request.event) || socket.data.room !== room || !socket.connected || !active(user)) return ack({ ok: false, code: "REFUSED" });
        const handlers = socket.listeners(request.event as keyof ClientToServerEvents);
        const handler = handlers[0] as unknown as (body: Record<string, unknown>, done: (result: unknown) => void) => Promise<void>;
        if (!handler) return ack({ ok: false, code: "REFUSED" });
        await handler(request.body, result => ack({ ok: true, result }));
      } catch { ack({ ok: false, code: "REFUSED" }); }
      finally { terminalBusy = false; }
    });
  });

  return {
    io,
    // Exposed for tests that check what reached disk and Git.
    room: async (roomId: string) => {
      const r = existing(roomId);
      if (!r) throw new Error(`no room ${roomId}`);
      return r;
    },
    close: async () => {
      clearInterval(sweeper);
      const saving: Promise<void>[] = [];
      for (const r of rooms.values()) {
        saving.push(r.then(
          async (room) => {
            await room.harness.close();
            room.changes.close();
            await room.ws.saved();
          },
          () => {},
        ));
      }
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all(saving); // let the last lock and version writes land before exiting
    },
  };
}
