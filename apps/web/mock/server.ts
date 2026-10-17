// The dev and e2e stand-in for services/api: the same gateway (@pineagent/core), plus what only
// development needs. NOT the real server: it accepts `dev:<name>` tokens, every user may join every
// room, each branch is a temp copy of fixtures/demo-repo with a local bare repo standing in for
// GitHub, and agent runs come from the scripted MockHarness.
import { cp, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auth0Verifier, createGateway, GitRepo, type User } from "@pineagent/core/server";
import { MockHarness } from "./harness";

const FIXTURE = fileURLToPath(new URL("./fixtures/demo-repo", import.meta.url));
const ALLOWED_ORIGINS = [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];

export type MockOptions = {
  port?: number;
  snapshotDelayMs?: number; // simulates a slow server for the browser's loading states
  heartbeatMs?: number; // contract: 10 s
  leaseMs?: number; // contract: 30 s without a heartbeat
  idleMs?: number; // contract: 10 min without edits
  sweepMs?: number;
  runStepMs?: number; // how long each mock agent step takes
};

// `dev:<name>` tokens and, when VITE_AUTH0_DOMAIN is set, real Auth0 JWTs. Dev names are treated as
// GitHub logins (?as=octocat shows octocat's picture); MOCK_AVATARS=0 turns that off.
function devAuthenticate(): (token: unknown) => Promise<User | null> {
  const domain = process.env.VITE_AUTH0_DOMAIN;
  const audience = process.env.VITE_AUTH0_AUDIENCE || process.env.VITE_AUTH0_CLIENT_ID;
  const auth0 = domain && audience ? auth0Verifier({ domain, audience, warn: (m) => console.warn(`[mock] ${m}`) }) : null;
  return async (token) => {
    if (typeof token !== "string") return null;
    const m = token.match(/^dev:([a-z0-9_-]{1,39})$/i);
    if (m) {
      const avatarUrl = process.env.MOCK_AVATARS === "0" ? null : `https://github.com/${m[1]}.png?size=64`;
      return { id: `dev|${m[1].toLowerCase()}`, name: m[1], avatarUrl };
    }
    return auth0 ? auth0(token) : null;
  };
}

export async function startMock({
  port = 3001,
  snapshotDelayMs = 0,
  heartbeatMs = 10_000,
  leaseMs = 30_000,
  idleMs = 600_000,
  sweepMs = 1_000,
  runStepMs = 900,
}: MockOptions = {}) {
  const http = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "text/plain" });
    res.end(req.url === "/health" ? "ok (mock)\n" : "not found\n");
  });
  const remotes = new Map<string, string>(); // room → the bare repo standing in for GitHub

  const gateway = createGateway({
    http,
    allowedOrigins: ALLOWED_ORIGINS,
    authenticate: devAuthenticate(),
    // Tests never touch the source tree, and branches never share files, locks or Git queues.
    prepare: async ({ roomId }) => {
      const root = await mkdtemp(join(tmpdir(), "pineagent-mock-"));
      await cp(FIXTURE, root, { recursive: true });
      const remoteDir = await mkdtemp(join(tmpdir(), "pineagent-remote-"));
      remotes.set(roomId, remoteDir);
      return GitRepo.init(root, remoteDir);
    },
    harness: ({ ws, roomId, files, events }) => new MockHarness(ws, roomId, files, events, runStepMs),
    timing: { heartbeatMs, leaseMs, idleMs, sweepMs },
    snapshotDelayMs,
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const bound = (http.address() as AddressInfo).port;
  console.log(`[mock] listening on :${bound}`);
  const room = async (id: string) => ({ ...(await gateway.room(id)), remoteDir: remotes.get(id)! });
  return {
    port: bound,
    // Exposed for tests that check what reached disk and Git.
    room,
    workspace: async (id: string) => (await room(id)).ws,
    close: () => {
      const closed = gateway.close();
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
