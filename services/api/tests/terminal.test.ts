import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createGateway, GitRepo } from "@pineagent/core/server";
import { roomName, type ClientToServerEvents, type ServerToClientEvents } from "@pineagent/core/contracts";
import { SandboxHost } from "../src/sandbox/host";
import { RoomSandbox } from "../src/sandbox/room";
import { LiveHarness } from "../src/harness/controller";

it.runIf(Boolean(process.env.PINEAGENT_SANDBOX_IMAGE))("connects terminal to real Rust CLI, frozen harness, versioned edits and Docker tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-terminal-"));
  const repoRoot = join(root, "repo");
  for (const dir of ["src", "test"]) await mkdir(join(repoRoot, dir), { recursive: true });
  await writeFile(join(repoRoot, "package.json"), "{}");
  await writeFile(join(repoRoot, "src/value.mjs"), "export function value() { return 1; }");
  await writeFile(join(repoRoot, "test/value.test.mjs"), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value(),2);");
  await mkdir(join(root, "remote.git"));
  const repo = await GitRepo.init(repoRoot, join(root, "remote.git"));
  const host = new SandboxHost({ workspaceRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE! });
  const http = createServer();
  let sandbox!: RoomSandbox;
  const gateway = createGateway({ http, allowedOrigins: [],
    authenticate: async token => token === "alice" || token === "bob" ? { id: token, name: token, avatarUrl: null } : null,
    prepare: async () => repo, protect: async ws => { sandbox = new RoomSandbox(ws, host); },
    terminal: (_ws, owner, line) => sandbox.parseCommand(owner, line),
    harness: context => new LiveHarness({ context,
      model: () => ({ plan: async () => ({ allowedWrites: ["src/value.mjs"], visibleTestPath: "test/value.test.mjs" }),
        patch: async () => ({ files: [{ path: "src/value.mjs", content: "export function value() { return 2; }" }] }) }),
      router: () => ({ route: async ({ candidates }) => ({ status: "selected", candidateId: candidates.find(c => c.routeLabel === "targeted_symbol_search")!.id, routerMode: "openai" }) }),
      runTests: (owner, id, path) => sandbox.runTests(owner, id, path),
    }),
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`http://127.0.0.1:${address.port}`, { auth: { token: "alice" }, reconnection: false });
  const call = (line: string) => socket.timeout(20_000).emitWithAck("terminal:command", { line });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    expect(await socket.emitWithAck("room:join", { wsId: "demo", branch: "main" })).toMatchObject({ ok: true });
    expect(await call("touch outside.txt")).toEqual({ ok: false, code: "REFUSED" });
    expect(await call("read src/value.mjs")).toMatchObject({ ok: true, result: { ok: true, version: 1 } });
    expect(await call("run Fix value().")).toMatchObject({ ok: true, result: { ok: true } });
    const room = await gateway.room(roomName("demo", "main"));
    await expect.poll(() => room.harness.list()[0].state, { timeout: 20_000 }).toBe("done");
    expect(room.harness.list()[0].ownerId).toBe("alice");
    expect(await call("read src/value.mjs")).toMatchObject({ ok: true, result: { ok: true, version: 2, content: "export function value() { return 2; }" } });
  } finally { socket.disconnect(); await gateway.close(); await host.close(); }
}, 60_000);
