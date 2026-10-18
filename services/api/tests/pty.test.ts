import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createGateway, GitRepo, type PtySession } from "@pineagent/core/server";
import type { ClientToServerEvents, ServerToClientEvents } from "@pineagent/core/contracts";
import { TerminalHost } from "../src/sandbox/terminal-host";
import { dockerCommand } from "../src/sandbox/host";
import { openTerminalRelay } from "../src/sandbox/terminal-relay";
import { SessionTokens } from "../src/sandbox/session-tokens";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
async function fixture(pty: Parameters<typeof createGateway>[0]["pty"], sessions = new SessionTokens()) {
  const root = await mkdtemp(join(tmpdir(), "pineagent-pty-gateway-"));
  const remote = await mkdtemp(join(tmpdir(), "pineagent-pty-remote-"));
  await writeFile(join(root, "value.txt"), "read through backend");
  const repo = await GitRepo.init(root, remote);
  const http = createServer();
  const gateway = createGateway({ http, allowedOrigins: [], prepare: async () => repo, pty,
    authenticate: async token => sessions.authenticate(token) ?? (token === "alice" || token === "bob" ? { id: token, name: token, avatarUrl: null } : null),
    sessionActive: user => sessions.active(user) });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  const port = (http.address() as { port: number }).port;
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const socket: Client = io(`http://127.0.0.1:${port}`, { auth: { token }, reconnection: false }); clients.push(socket);
    await new Promise<void>((done, reject) => { socket.once("connect", done); socket.once("connect_error", reject); });
    expect(await socket.emitWithAck("room:join", { wsId: "demo", branch: "main" })).toMatchObject({ ok: true });
    return socket;
  };
  return { connect, gateway, close: async () => { for (const c of clients) c.disconnect(); await gateway.close(); } };
}

it("binds terminal input/resize/close to the authenticated socket and invalidates on room change", async () => {
  const received: string[] = [];
  let closes = 0;
  const session: PtySession = { id: "test-generation", expiresAt: Date.now() + 60_000,
    read: async () => ({ data: "", offset: 0, exited: false }),
    input: async data => { received.push(data); }, resize: async (cols, rows) => { received.push(`${cols}x${rows}`); }, close: async () => { closes++; } };
  const f = await fixture(async () => session);
  try {
    const alice = await f.connect("alice"), bob = await f.connect("bob");
    expect(await alice.emitWithAck("terminal:open", { cols: 80, rows: 24 })).toEqual({ ok: true, id: session.id });
    expect(await bob.emitWithAck("terminal:input", { id: session.id, data: "run stolen" })).toEqual({ ok: false });
    expect(await bob.emitWithAck("terminal:close", { id: session.id })).toEqual({ ok: false });
    expect(await alice.emitWithAck("terminal:resize", { id: session.id, cols: -1, rows: 24 })).toEqual({ ok: false });
    expect(await alice.emitWithAck("terminal:input", { id: session.id, data: "runs\r" })).toEqual({ ok: true });
    expect(await alice.emitWithAck("terminal:resize", { id: session.id, cols: 100, rows: 30 })).toEqual({ ok: true });
    await alice.emitWithAck("room:join", { wsId: "other", branch: "main" });
    expect(await alice.emitWithAck("terminal:input", { id: session.id, data: "old" })).toEqual({ ok: false });
    expect(received).toEqual(["runs\r", "100x30"]); expect(closes).toBe(1);
  } finally { await f.close(); }
});

it("waits for delayed terminal admission and cleanup before gateway shutdown finishes", async () => {
  let admit!: (session: PtySession) => void, entered = false, closed = false, finished = false;
  const pending = new Promise<PtySession>(done => { admit = done; });
  const f = await fixture(async () => { entered = true; return pending; });
  const alice = await f.connect("alice");
  alice.emit("terminal:open", { cols: 80, rows: 24 }, () => {});
  await expect.poll(() => entered).toBe(true);
  const shutdown = f.close().then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 30)); expect(finished).toBe(false);
  admit({ id: "late", expiresAt: Date.now() + 60_000,
    read: async () => ({ data: "", offset: 0, exited: false }), input: async () => {}, resize: async () => {}, close: async () => { closed = true; } });
  await shutdown; expect(closed).toBe(true);
});

it("does not let a delayed input failure close a replacement terminal", async () => {
  let rejectInput!: () => void, generation = 0;
  const closed: string[] = [];
  const f = await fixture(async () => {
    const id = String(++generation);
    return { id, expiresAt: Date.now() + 60_000, read: async () => ({ data: "", offset: 0, exited: false }),
      resize: async () => {}, close: async () => { closed.push(id); },
      input: async () => new Promise<void>((_done, reject) => { rejectInput = () => reject(new Error("late failure")); }) };
  });
  try {
    const alice = await f.connect("alice");
    await alice.emitWithAck("terminal:open", { cols: 80, rows: 24 });
    const input = alice.emitWithAck("terminal:input", { id: "1", data: "x" });
    await expect.poll(() => Boolean(rejectInput)).toBe(true);
    await alice.emitWithAck("terminal:close", { id: "1" });
    expect(await alice.emitWithAck("terminal:open", { cols: 80, rows: 24 })).toMatchObject({ ok: true, id: "2" });
    rejectInput(); expect(await input).toEqual({ ok: false });
    expect(closed).toEqual(["1"]);
    expect(await alice.emitWithAck("terminal:resize", { id: "2", cols: 80, rows: 24 })).toEqual({ ok: true });
  } finally { await f.close(); }
});

it.runIf(Boolean(process.env.PINEAGENT_PTY_ROOT && process.env.PINEAGENT_SANDBOX_IMAGE))("renders the real Ratatui UI through Docker PTY, private authenticated relay, input and resize", async () => {
  const root = await mkdtemp(join(process.env.PINEAGENT_PTY_ROOT!, "relay-"));
  const sessions = new SessionTokens();
  const host = new TerminalHost({ relayRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE!, uid: process.getuid!(),
    command: async args => { const result = await dockerCommand(args); if (result.code) throw new Error(`${args[0]}: ${result.stderr}`); return result; } });
  let launchError: unknown;
  const f = await fixture(async (context, size, port) => {
    try { return await openTerminalRelay({ context, ...size, port, root, backend: host, sessions }); }
    catch (error) { launchError = error; throw error; }
  }, sessions);
  try {
    const alice = await f.connect("alice");
    let screen = "";
    alice.on("terminal:output", (msg, ack) => { screen += Buffer.from(msg.data, "base64").toString(); ack(); });
    const opened = await alice.timeout(30_000).emitWithAck("terminal:open", { cols: 100, rows: 30 });
    expect(launchError).toBeUndefined();
    expect(opened.ok).toBe(true); if (!opened.ok) throw new Error("PTY refused");
    const plain = () => screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ").replace(/\s+/g, " ");
    await expect.poll(plain, { timeout: 15_000 }).toContain("No runs.");
    expect(screen).toContain("Pineagent"); expect(screen).toContain("connected");
    await alice.emitWithAck("terminal:input", { id: opened.id, data: "read value.txt\r" });
    await expect.poll(plain, { timeout: 10_000 }).toContain("read through backend");
    screen = "";
    expect(await alice.emitWithAck("terminal:resize", { id: opened.id, cols: 20, rows: 8 })).toEqual({ ok: true });
    await expect.poll(plain, { timeout: 10_000 }).toContain("Enlarge terminal");
    const exit = new Promise<void>(done => alice.once("terminal:exit", () => done()));
    await alice.emitWithAck("terminal:input", { id: opened.id, data: "\u001b" });
    await exit;
  } finally { await f.close(); await host.shutdown(); }
}, 60_000);
