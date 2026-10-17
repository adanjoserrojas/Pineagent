import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClientToServerEvents, ServerToClientEvents } from "@pineagent/core/contracts";
import { auth0Verifier, GitRepo, MemoryStore, tokenEnv, type Store } from "@pineagent/core/server";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { GitHubBroker, type Fetch } from "../src/github";

const run = promisify(execFile);
const DOMAIN = "tenant.example.auth0.com";
const AUDIENCE = "https://api.pineagent";
const M2M_ID = "m2m-client";
const FIXTURE = fileURLToPath(new URL("../../../apps/web/mock/fixtures/demo-repo", import.meta.url));

// The outside world, faked: Auth0's signing key, the server's own M2M key, users and their GitHub tokens.
type Person = { sub: string; login: string; token: string; push: boolean };
const ALICE: Person = { sub: "github|1001", login: "alice", token: "gho_FAKE_alice_token", push: true };
const BOB: Person = { sub: "github|1002", login: "bob", token: "gho_FAKE_bob_token", push: false };
const people = [ALICE, BOB];

let tenantKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
let m2mPublic: CryptoKey;
let m2mPem: string;
let calls: string[];

async function accessToken(p: Person, overrides: { aud?: string; exp?: string; alg?: "HS256" } = {}) {
  if (overrides.alg === "HS256") {
    return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(p.sub).setIssuer(`https://${DOMAIN}/`).setAudience(AUDIENCE).setExpirationTime("1h").sign(new TextEncoder().encode("x".repeat(32)));
  }
  return new SignJWT({ scope: "openid profile" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(p.sub)
    .setIssuer(`https://${DOMAIN}/`)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "1h")
    .sign(tenantKey);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Auth0's token and users endpoints, and GitHub's repos endpoint.
const fakeFetch: Fetch = async (input, init) => {
  const url = String(input);
  calls.push(url.replace(/\?.*/, ""));
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  if (url === `https://${DOMAIN}/oauth/token`) {
    const body = JSON.parse(String(init?.body));
    // The assertion must be signed by the key whose public half was registered in Auth0.
    const { payload } = await jwtVerify(body.client_assertion, m2mPublic, { issuer: M2M_ID, subject: M2M_ID, audience: `https://${DOMAIN}/oauth/token` });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
    expect(body).toMatchObject({ grant_type: "client_credentials", audience: `https://${DOMAIN}/api/v2/` });
    expect(body.client_secret).toBeUndefined();
    return json({ access_token: "mgmt-token", expires_in: 86400 });
  }
  const user = url.match(/\/api\/v2\/users\/([^?]+)/);
  if (user) {
    if (auth !== "Bearer mgmt-token") return json({}, 401);
    const p = people.find((x) => x.sub === decodeURIComponent(user[1]));
    return p ? json({ identities: [{ provider: "github", access_token: p.token }] }) : json({}, 404);
  }
  const repo = url.match(/^https:\/\/api\.github\.test\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const p = people.find((x) => auth === `Bearer ${x.token}`);
    if (!p) return json({}, 401);
    if (repo[2] === "secret") return json({}, 404);
    return json({ full_name: `${repo[1]}/${repo[2]}`, size: 120, permissions: { push: p.push } });
  }
  return json({ message: "unexpected" }, 500);
};

let ghRoot: string;
let wsRoot: string;
let app: ReturnType<typeof createApp>;
let port: number;
let boot: (opts: { workspacesRoot: string; store: Store }) => Promise<{ app: ReturnType<typeof createApp>; port: number }>;
const sockets: Socket[] = [];

beforeAll(async () => {
  const tenant = await generateKeyPair("RS256");
  tenantKey = tenant.privateKey;
  const jwk: JWK = { ...(await exportJWK(tenant.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [jwk] });
  const m2m = await generateKeyPair("RS256", { extractable: true });
  m2mPublic = m2m.publicKey;
  m2mPem = await exportPKCS8(m2m.privateKey);

  // "GitHub": a bare repo with the fixture's contents at <ghRoot>/acme/demo.git.
  ghRoot = await mkdtemp(join(tmpdir(), "pineagent-gh-"));
  const seed = await mkdtemp(join(tmpdir(), "pineagent-seed-"));
  await cp(FIXTURE, seed, { recursive: true });
  await mkdir(join(ghRoot, "acme", "demo.git"), { recursive: true });
  await GitRepo.init(seed, join(ghRoot, "acme", "demo.git"));
  wsRoot = await mkdtemp(join(tmpdir(), "pineagent-ws-"));

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    sha: "test-sha",
    workspacesRoot: wsRoot,
    allowedOrigins: ["http://localhost:5173"],
    allowedRepos: new Set(["acme/demo", "acme/secret"]),
    auth0: { domain: DOMAIN, audience: AUDIENCE },
    m2m: { clientId: M2M_ID, keyFile: "unused" },
    githubApi: "https://api.github.test",
    githubClone: `file://${ghRoot}`,
    dynamo: null,
  };
  const github = new GitHubBroker({ domain: DOMAIN, clientId: M2M_ID, privateKeyPem: async () => m2mPem, githubApi: config.githubApi, fetch: fakeFetch });
  const profiles: Record<string, string> = Object.fromEntries(people.map((p) => [p.sub, p.login]));
  const authenticate = auth0Verifier({
    domain: DOMAIN,
    audience: AUDIENCE,
    jwks,
    userinfo: async (token) => {
      const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub as string;
      return { nickname: profiles[sub] };
    },
    warn: () => {},
  });
  const logs: unknown[] = [];
  app = createApp({ config, authenticate, github, log: (e, f) => logs.push({ e, ...f }) });
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", resolve));
  port = (app.http.address() as { port: number }).port;
  boot = async ({ workspacesRoot, store }) => {
    const a = createApp({ config: { ...config, workspacesRoot }, authenticate, github, store, log: () => {} });
    await new Promise<void>((resolve) => a.http.listen(0, "127.0.0.1", resolve));
    return { app: a, port: (a.http.address() as { port: number }).port };
  };
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await app?.close();
});

beforeAll(() => {
  calls = [];
});

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
function client(token: string, at = port): Client {
  const s: Client = connect(`http://127.0.0.1:${at}`, { auth: { token }, reconnection: false, forceNew: true, transports: ["websocket"] });
  sockets.push(s);
  return s;
}
const connected = (s: Client) =>
  new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });

describe("Auth0 tokens", () => {
  it("accepts a valid access token and names the user from their profile", async () => {
    const verify = auth0Verifier({ domain: DOMAIN, audience: AUDIENCE, jwks, userinfo: async () => ({ nickname: "alice" }), warn: () => {} });
    expect(await verify(await accessToken(ALICE))).toEqual({ id: ALICE.sub, name: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1001?s=64" });
  });

  it("rejects the wrong audience, an expired token, a symmetric-key token and dev tokens", async () => {
    const verify = auth0Verifier({ domain: DOMAIN, audience: AUDIENCE, jwks, userinfo: async () => ({}), warn: () => {} });
    expect(await verify(await accessToken(ALICE, { aud: "https://someone-else" }))).toBeNull();
    expect(await verify(await accessToken(ALICE, { exp: "1s ago" }))).toBeNull();
    expect(await verify(await accessToken(ALICE, { alg: "HS256" }))).toBeNull();
    expect(await verify("dev:alice")).toBeNull();
    expect(await verify(undefined)).toBeNull();
  });

  it("refuses a dev token at the socket handshake", async () => {
    const err = await connected(client("dev:alice")).catch((e) => e);
    expect(err?.data?.code).toBe("UNAUTHENTICATED");
  });
});

describe("GitHub broker", () => {
  it("gets the Management API token with a signed assertion (no secret), once, and caches users' tokens", async () => {
    calls = [];
    const broker = new GitHubBroker({ domain: DOMAIN, clientId: M2M_ID, privateKeyPem: async () => m2mPem, githubApi: "https://api.github.test", fetch: fakeFetch });
    expect(await broker.githubToken(ALICE.sub)).toBe(ALICE.token);
    expect(await broker.githubToken(ALICE.sub)).toBe(ALICE.token);
    expect(await broker.githubToken(BOB.sub)).toBe(BOB.token);
    expect(calls.filter((c) => c.endsWith("/oauth/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/api/v2/users/"))).toHaveLength(2);
  });

  it("asks GitHub with the user's own token whether they can push", async () => {
    const broker = new GitHubBroker({ domain: DOMAIN, clientId: M2M_ID, privateKeyPem: async () => m2mPem, githubApi: "https://api.github.test", fetch: fakeFetch });
    expect(await broker.access(ALICE.sub, "acme", "demo")).toMatchObject({ ok: true, fullName: "acme/demo" });
    expect(await broker.access(BOB.sub, "acme", "demo")).toMatchObject({ ok: false, code: "NOT_COLLABORATOR" });
    expect(await broker.access(ALICE.sub, "acme", "secret")).toMatchObject({ ok: false, code: "NOT_COLLABORATOR" });
    expect(await broker.access("google-oauth2|5", "acme", "demo")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });

  it("hands git the token through GIT_ASKPASS only", async () => {
    const env = tokenEnv("gho_FAKE_x");
    const user = await run(env.GIT_ASKPASS, ["Username for 'https://github.com': "], { env: { ...process.env, ...env } });
    const pass = await run(env.GIT_ASKPASS, ["Password for 'https://x-access-token@github.com': "], { env: { ...process.env, ...env } });
    expect(user.stdout.trim()).toBe("x-access-token");
    expect(pass.stdout.trim()).toBe("gho_FAKE_x");
    expect(await readFile(env.GIT_ASKPASS, "utf8")).not.toContain("gho_");
  });
});

describe("joining a repository", () => {
  it("clones an allowlisted repo the user can push to, with no token left on disk", async () => {
    const alice = client(await accessToken(ALICE));
    await connected(alice);
    const res = await alice.emitWithAck("room:join", { wsId: "acme/demo", branch: "main" });
    expect(res).toMatchObject({ ok: true, self: { userId: ALICE.sub, name: "alice" } });
    expect(res.ok && res.tree).toContain("src/auth.ts");

    const dir = join(wsRoot, "acme", "demo", "main");
    const config = await readFile(join(dir, ".git", "config"), "utf8");
    expect(config).toContain(`url = file://${ghRoot}/acme/demo.git`);
    for (const p of people) expect(await grepDir(join(dir, ".git"), p.token)).toBe(false);
  });

  it("refuses users without push access, repos off the allowlist, and non-GitHub workspace ids", async () => {
    const bob = client(await accessToken(BOB));
    await connected(bob);
    expect(await bob.emitWithAck("room:join", { wsId: "acme/demo", branch: "main" })).toEqual({ ok: false, code: "NOT_COLLABORATOR" });
    const alice = client(await accessToken(ALICE));
    await connected(alice);
    expect(await alice.emitWithAck("room:join", { wsId: "acme/other", branch: "main" })).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await alice.emitWithAck("room:join", { wsId: "demo", branch: "main" })).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await alice.emitWithAck("room:join", { wsId: "acme/demo", branch: "no-such-branch" })).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("says agent runs aren't available, instead of leaving run:start unanswered", async () => {
    const alice = client(await accessToken(ALICE));
    await connected(alice);
    await alice.emitWithAck("room:join", { wsId: "acme/demo", branch: "main" });
    expect(await alice.emitWithAck("run:list", {})).toEqual({ ok: true, runs: [] });
    expect(await alice.emitWithAck("run:start", { task: "add a test" })).toEqual({ ok: false, code: "NOT_AVAILABLE" });
  });

  it("commits as the user, with their GitHub noreply address", async () => {
    const alice = client(await accessToken(ALICE));
    await connected(alice);
    await alice.emitWithAck("room:join", { wsId: "acme/demo", branch: "main" });
    await alice.emitWithAck("lock:acquire", { path: "src/db.ts", kind: "file" });
    const snap = await alice.emitWithAck("file:snapshot", { path: "src/db.ts" });
    expect(snap.ok).toBe(true);
    const v = snap.ok ? snap.version : 0;
    expect(await alice.emitWithAck("file:ops", { path: "src/db.ts", baseVersion: v, ops: [{ offset: 0, length: 0, text: "// hi\n" }] })).toMatchObject({ ok: true });
    await alice.emitWithAck("lock:release", { path: "src/db.ts" });
    const result = new Promise<unknown>((resolve) => alice.once("git:result", resolve));
    expect(await alice.emitWithAck("git:commit", { paths: ["src/db.ts"], message: "Say hi", push: false })).toMatchObject({ ok: true });
    expect(await result).toMatchObject({ ok: true, paths: ["src/db.ts"] });
    const { stdout } = await run("git", ["log", "-1", "--format=%an <%ae>|%s"], { cwd: join(wsRoot, "acme", "demo", "main") });
    expect(stdout.trim()).toBe("alice <1001+alice@users.noreply.github.com>|Say hi");
  });

  it("serves /health with the deployed commit", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toMatchObject({ ok: true, sha: "test-sha", github: true });
  });
});

describe("restarting the server", () => {
  it("keeps locks, file versions and who edited what (store written before each ack)", async () => {
    const store = new MemoryStore();
    const root = await mkdtemp(join(tmpdir(), "pineagent-ws-restart-"));
    const join_ = { wsId: "acme/demo", branch: "main" };

    // First run: Alice locks and edits a file.
    const first = await boot({ workspacesRoot: root, store });
    const alice = client(await accessToken(ALICE), first.port);
    await connected(alice);
    await alice.emitWithAck("room:join", join_);
    expect(await alice.emitWithAck("lock:acquire", { path: "src/auth.ts", kind: "file" })).toMatchObject({ ok: true });
    const snap = await alice.emitWithAck("file:snapshot", { path: "src/auth.ts" });
    const v1 = snap.ok ? snap.version : 0;
    expect(await alice.emitWithAck("file:ops", { path: "src/auth.ts", baseVersion: v1, ops: [{ offset: 0, length: 0, text: "// a\n" }] })).toMatchObject({ ok: true, version: v1 + 1 });
    expect(await alice.emitWithAck("file:ops", { path: "src/auth.ts", baseVersion: v1 + 1, ops: [{ offset: 0, length: 0, text: "// b\n" }] })).toMatchObject({ ok: true, version: v1 + 2 });
    // Nothing more to wait for: each ack above came after its store write.
    alice.close();
    await first.app.close();

    // Second run, same disk and store.
    const second = await boot({ workspacesRoot: root, store });
    try {
      const alice2 = client(await accessToken(ALICE), second.port);
      await connected(alice2);
      const joined = await alice2.emitWithAck("room:join", join_);
      expect(joined.ok && joined.locks).toMatchObject([{ path: "src/auth.ts", holder: ALICE.sub, holderType: "user" }]);
      // The version carries on, so Alice's editor (at v1+2) keeps typing without a resync.
      const after = await alice2.emitWithAck("file:snapshot", { path: "src/auth.ts" });
      expect(after).toMatchObject({ ok: true, version: v1 + 2 });
      expect(after.ok && after.content.startsWith("// b\n// a\n")).toBe(true);
      expect(await alice2.emitWithAck("file:ops", { path: "src/auth.ts", baseVersion: v1 + 2, ops: [{ offset: 0, length: 0, text: "// c\n" }] })).toMatchObject({ ok: true, version: v1 + 3 });
      // The change is still Alice's to commit.
      const status = await alice2.emitWithAck("git:status", {});
      expect(status.changes.find((c) => c.path === "src/auth.ts")).toMatchObject({ editors: [ALICE.sub], committable: true });

      // Releasing writes through too: a third start would find no lock.
      await alice2.emitWithAck("lock:release", { path: "src/auth.ts" });
      expect((await store.room("ws:acme/demo:main").load()).locks).toEqual([]);
    } finally {
      await second.app.close();
    }
  });
});

async function grepDir(dir: string, needle: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const text = await readFile(join(e.parentPath, e.name)).catch(() => Buffer.alloc(0));
    if (text.includes(needle)) return true;
  }
  return false;
}
