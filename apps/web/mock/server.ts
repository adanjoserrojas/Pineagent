// Mock of SE1's Socket.IO gateway for browser development and e2e tests.
// Implements docs/contracts/SOCKET_LOCKS_AND_FILES.md in memory. NOT the real server:
// it accepts `dev:<name>` tokens, which the real API must reject.
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Server, type Socket } from "socket.io";
import {
  UNAUTHENTICATED,
  githubAvatarUrl,
  roomName,
  type ClientToServerEvents,
  type Member,
  type ServerToClientEvents,
} from "../src/contracts/socket";
import { GitRepo } from "./git";
import { GitQueue } from "./gitQueue";
import { MockHarness } from "./harness";
import { Workspace } from "./workspace";

type User = { id: string; name: string; avatarUrl: string | null };
type Room = { ws: Workspace; repo: GitRepo; queue: GitQueue; harness: MockHarness; remoteDir: string };
type SocketData = { user: User; room?: string; openPath: string | null };
type MockSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const FIXTURE = fileURLToPath(new URL("./fixtures/demo-repo", import.meta.url));
const ALLOWED_ORIGINS = [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, full)));
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out.sort();
}

// Accepts `dev:<name>` tokens and, when VITE_AUTH0_DOMAIN is set, real Auth0 JWTs. Dev names are
// treated as GitHub logins (?as=octocat shows octocat's picture); MOCK_AVATARS=0 turns that off.
async function authenticate(token: unknown): Promise<User | null> {
  if (typeof token !== "string") return null;
  const m = token.match(/^dev:([a-z0-9_-]{1,39})$/i);
  if (m) {
    const avatarUrl = process.env.MOCK_AVATARS === "0" ? null : `https://github.com/${m[1]}.png?size=64`;
    return { id: `dev|${m[1].toLowerCase()}`, name: m[1], avatarUrl };
  }
  return verifyAuth0(token);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

// Verifies signature, issuer and audience against the tenant's JWKS. The audience is the API when
// one is configured, otherwise the SPA client id (the ID token fallback used before the API exists).
async function verifyAuth0(token: string): Promise<User | null> {
  const domain = process.env.VITE_AUTH0_DOMAIN;
  const audience = process.env.VITE_AUTH0_AUDIENCE || process.env.VITE_AUTH0_CLIENT_ID;
  if (!domain || !audience) return null;
  jwks ??= createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${domain}/`, audience });
    const sub = String(payload.sub);
    const claim = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : undefined);
    return {
      id: sub,
      name: claim("nickname") ?? claim("name") ?? sub,
      avatarUrl: githubAvatarUrl(sub) ?? claim("picture") ?? null,
    };
  } catch (err) {
    console.warn(`[mock] rejected Auth0 token: ${(err as Error).message}`);
    return null;
  }
}

const presenceOf = (user: User) => ({ userId: user.id, name: user.name, avatarUrl: user.avatarUrl });

export type MockOptions = {
  port?: number;
  snapshotDelayMs?: number; // simulates a slow server for the browser's loading states
  heartbeatMs?: number; // contract: 10 s
  leaseMs?: number; // contract: 30 s without a heartbeat
  idleMs?: number; // contract: 10 min without edits
  sweepMs?: number;
  runStepMs?: number; // how long each mock agent step takes
};

export async function startMock({
  port = 3001,
  snapshotDelayMs = 0,
  heartbeatMs = 10_000,
  leaseMs = 30_000,
  idleMs = 600_000,
  sweepMs = 1_000,
  runStepMs = 900,
}: MockOptions = {}) {
  const http = createServer();
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
    cors: { origin: ALLOWED_ORIGINS },
  });

  // One Workspace per branch room, each a real git repo (a temp copy of the fixture) with a local
  // bare repo standing in for GitHub, so tests never touch the source tree and branches never
  // share files, locks or Git queues.
  const rooms = new Map<string, Promise<Room>>();
  const roomFor = (room: string): Promise<Room> => {
    let r = rooms.get(room);
    if (!r) {
      r = (async () => {
        const root = await mkdtemp(join(tmpdir(), "pineagent-mock-"));
        await cp(FIXTURE, root, { recursive: true });
        const remoteDir = await mkdtemp(join(tmpdir(), "pineagent-remote-"));
        const repo = await GitRepo.init(root, remoteDir);
        const ws = new Workspace(root, { leaseMs, idleMs });
        const queue = new GitQueue(ws, repo, {
          queue: (jobs) => io.to(room).emit("git:queue", { jobs }),
          result: (res) => io.to(room).emit("git:result", res),
          fileChanged: (path, before, after, version) =>
            io.to(room).emit("file:changed", {
              path,
              version,
              ops: [{ offset: 0, length: before.length, text: after }],
              author: "git",
              source: "shell",
            }),
          treeChanged: (path, change) => io.to(room).emit("tree:changed", { path, change }),
        });
        const harness = new MockHarness(
          ws,
          room,
          () => listFiles(root),
          {
            run: (e) => io.to(room).emit("run:event", e),
            lockChanged: (path, lock, reason) => io.to(room).emit("lock:changed", { path, kind: "file", lock, reason }),
            fileChanged: (path, version, ops, author) =>
              io.to(room).emit("file:changed", { path, version, ops, author, source: "agent" }),
          },
          runStepMs,
        );
        return { ws, repo, queue, harness, remoteDir };
      })();
      rooms.set(room, r);
    }
    return r;
  };
  const workspaceFor = async (room: string) => (await roomFor(room)).ws;

  io.use(async (socket, next) => {
    const user = await authenticate(socket.handshake.auth?.token);
    if (!user) {
      const err = new Error("unauthenticated") as Error & { data?: unknown };
      err.data = { code: UNAUTHENTICATED };
      return next(err);
    }
    socket.data.user = user;
    socket.data.openPath = null;
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
  const sweeper = setInterval(async () => {
    for (const [room, pending] of rooms) {
      for (const { lock, reason } of (await pending).ws.sweep()) {
        io.to(room).emit("lock:changed", { path: lock.path, kind: lock.kind, lock: null, reason });
      }
    }
  }, sweepMs);

  io.on("connection", (socket: MockSocket) => {
    const { user } = socket.data;
    const joined = async () => (socket.data.room ? { room: socket.data.room, ...(await roomFor(socket.data.room)) } : null);

    socket.on("room:join", async ({ wsId, branch }, ack) => {
      if (typeof wsId !== "string" || typeof branch !== "string") return ack({ ok: false, code: "NOT_COLLABORATOR" });
      const room = roomName(wsId, branch);
      if (socket.data.room && socket.data.room !== room) socket.leave(socket.data.room);
      socket.data.room = room;
      const ws = await workspaceFor(room);
      await socket.join(room);
      const self: Member = { userId: user.id, name: user.name, avatarUrl: user.avatarUrl, openPath: socket.data.openPath };
      ack({
        ok: true,
        self,
        members: await membersOf(room),
        locks: ws.allLocks(),
        tree: await listFiles(ws.root),
        timing: { heartbeatMs, leaseMs },
      });
      socket.to(room).emit("presence:changed", { ...presenceOf(user), status: "joined", openPath: self.openPath });
    });

    socket.on("file:snapshot", async ({ path }, ack) => {
      const j = await joined();
      const file = j && j.ws.resolvePath(path) ? await j.ws.read(path) : null;
      if (!file) return ack({ ok: false, code: "NOT_FOUND" });
      if (snapshotDelayMs) await new Promise((r) => setTimeout(r, snapshotDelayMs));
      const hash = createHash("sha256").update(file.content).digest("hex");
      ack({ ok: true, path, version: file.version, content: file.content, hash });
    });

    socket.on("lock:acquire", async ({ path, kind }, ack) => {
      const j = await joined();
      const target = kind === "dir" && typeof path === "string" && path.endsWith("/") ? path.slice(0, -1) : path;
      // Malformed requests get no ack; the client's timeout handles it.
      if (!j || (kind !== "file" && kind !== "dir") || !j.ws.resolvePath(target)) return;
      const res = j.ws.acquire(path, kind, user.id);
      if (res.ok) {
        ack({ ok: true, lock: res.lock });
        if (res.created) io.to(j.room).emit("lock:changed", { path, kind, lock: res.lock, reason: "acquired" });
      } else {
        ack(res);
      }
    });

    socket.on("lock:release", async ({ path }, ack) => {
      const j = await joined();
      const released = j?.ws.release(path, user.id);
      ack({ ok: true });
      if (j && released) io.to(j.room).emit("lock:changed", { path, kind: released.kind, lock: null, reason: "released" });
    });

    socket.on("session:heartbeat", async (_msg, ack) => {
      const j = await joined();
      ack({ ok: true, expired: j ? j.ws.heartbeat(user.id) : [] });
    });

    socket.on("file:ops", async ({ path, baseVersion, ops }, ack) => {
      const j = await joined();
      if (!j || !j.ws.resolvePath(path) || !Number.isInteger(baseVersion)) {
        return ack({ ok: false, code: "STALE", currentVersion: 0 });
      }
      const res = await j.ws.applyOps(path, user.id, baseVersion, ops);
      ack(res);
      if (res.ok) {
        // Everyone else in the branch, including this user's other tabs (D3: branch-wide).
        socket.to(j.room).emit("file:changed", { path, version: res.version, ops, author: user.id, source: "editor" });
      }
    });

    socket.on("run:start", async ({ task }, ack) => {
      const j = await joined();
      const runId = j?.harness.start({ id: user.id, name: user.name }, task);
      ack(runId ? { ok: true, runId } : { ok: false, code: "BAD_REQUEST" });
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
      const j = await joined();
      // GitHub noreply addresses need the numeric id (SE1); the mock derives one from the name.
      const author = { id: user.id, name: user.name, email: `${user.name}@users.noreply.github.com` };
      const jobId = j?.queue.enqueue(author, paths, message, push);
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
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const bound = (http.address() as AddressInfo).port;
  console.log(`[mock] listening on :${bound}`);
  return {
    port: bound,
    // Exposed for tests that check what reached disk and Git.
    workspace: workspaceFor,
    room: roomFor,
    close: () => {
      clearInterval(sweeper);
      for (const r of rooms.values()) void r.then((room) => room.harness.close());
      const closed = new Promise<void>((resolve) => io.close(() => resolve()));
      // Don't wait for half-open connections (e.g. a client that went offline) to time out.
      http.closeAllConnections();
      return closed;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Share the browser's Auth0 settings; already-set environment variables win.
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
  } catch {
    // No .env.local: dev tokens only.
  }
  const env = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  console.log(`[mock] Auth0 verification ${process.env.VITE_AUTH0_DOMAIN ? "on" : "off"}`);
  startMock({
    port: env("MOCK_PORT") ?? 3001,
    heartbeatMs: env("HEARTBEAT_MS"),
    leaseMs: env("LEASE_MS"),
    idleMs: env("IDLE_MS"),
    sweepMs: env("SWEEP_MS"),
    runStepMs: env("RUN_STEP_MS"),
  });
}
