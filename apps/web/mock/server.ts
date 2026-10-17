// Mock of SE1's Socket.IO gateway for browser development and e2e tests.
// Implements docs/contracts/SOCKET_LOCKS_AND_FILES.md in memory. NOT the real server:
// it accepts `dev:<name>` tokens, which the real API must reject.
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

type User = { id: string; name: string; avatarUrl: string | null };
type SocketData = { user: User; room?: string; openPath: string | null };
type MockSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const FIXTURE = fileURLToPath(new URL("./fixtures/demo-repo", import.meta.url));
const ALLOWED_ORIGINS = [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
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

export async function startMock({ port = 3001 }: { port?: number } = {}) {
  // Each mock instance edits its own temp copy of the fixture, so tests never touch the source tree.
  const root = await mkdtemp(join(tmpdir(), "pineagent-mock-"));
  await cp(FIXTURE, root, { recursive: true });

  const http = createServer();
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
    cors: { origin: ALLOWED_ORIGINS },
  });

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

  io.on("connection", (socket: MockSocket) => {
    const { user } = socket.data;

    socket.on("room:join", async ({ wsId, branch }, ack) => {
      if (typeof wsId !== "string" || typeof branch !== "string") return ack({ ok: false, code: "NOT_COLLABORATOR" });
      const room = roomName(wsId, branch);
      if (socket.data.room && socket.data.room !== room) socket.leave(socket.data.room);
      socket.data.room = room;
      await socket.join(room);
      const self: Member = { userId: user.id, name: user.name, avatarUrl: user.avatarUrl, openPath: socket.data.openPath };
      ack({ ok: true, self, members: await membersOf(room), locks: [], tree: await listFiles(root) });
      socket.to(room).emit("presence:changed", { ...presenceOf(user), status: "joined", openPath: self.openPath });
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
  console.log(`[mock] listening on :${bound}, workspace copy at ${root}`);
  return {
    port: bound,
    root,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Share the browser's Auth0 settings; already-set environment variables win.
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
  } catch {
    // No .env.local: dev tokens only.
  }
  console.log(`[mock] Auth0 verification ${process.env.VITE_AUTH0_DOMAIN ? "on" : "off"}`);
  startMock({ port: Number(process.env.MOCK_PORT ?? 3001) });
}
