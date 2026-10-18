import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createGateway, GitRepo } from "@pineagent/core/server";
import { roomName, type ClientToServerEvents, type ServerToClientEvents } from "@pineagent/core/contracts";

it("shares case-alias authority and rejects an edit whose socket switches rooms during authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-authority-"));
  const repos = new Map<string, GitRepo>();
  for (const name of ["a", "b"]) {
    const dir = join(root, name), remote = join(root, `${name}-remote`);
    await mkdir(dir); await mkdir(remote); await writeFile(join(dir, "value.txt"), "old");
    repos.set(`acme/${name}`, await GitRepo.init(dir, remote));
  }
  let delay = false;
  let entered!: () => void, release!: () => void;
  const authorizing = new Promise<void>(r => { entered = r; });
  const permission = new Promise<void>(r => { release = r; });
  const http = createServer();
  const gateway = createGateway({ http, allowedOrigins: [],
    authenticate: async token => ({ id: String(token), name: String(token), avatarUrl: null }),
    authorize: async ctx => { if (delay && ctx.wsId === "acme/a") { entered(); await permission; } return "ok"; },
    prepare: async ctx => repos.get(ctx.wsId)!,
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("port");
  const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
  const connect = async (token: string) => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`http://127.0.0.1:${address.port}`, { auth: { token }, reconnection: false });
    clients.push(socket); await new Promise<void>(resolve => socket.once("connect", resolve)); return socket;
  };
  try {
    const alice = await connect("alice"), bob = await connect("bob");
    expect(await alice.emitWithAck("room:join", { wsId: "acme/a", branch: "main" })).toMatchObject({ ok: true });
    expect(await bob.emitWithAck("room:join", { wsId: "Acme/A", branch: "main" })).toMatchObject({ ok: true });
    expect(await alice.emitWithAck("lock:acquire", { path: "value.txt", kind: "file" })).toMatchObject({ ok: true });
    expect(await bob.emitWithAck("lock:acquire", { path: "value.txt", kind: "file" })).toMatchObject({ ok: false });
    delay = true;
    const edit = alice.emitWithAck("file:ops", { path: "value.txt", baseVersion: 1, ops: [{ offset: 0, length: 3, text: "changed" }] });
    await authorizing;
    expect(await alice.emitWithAck("room:join", { wsId: "acme/b", branch: "main" })).toMatchObject({ ok: true });
    release();
    expect(await edit).toMatchObject({ ok: false });
    expect(await (await gateway.room(roomName("acme/a", "main"))).ws.read("value.txt")).toEqual({ content: "old", version: 1 });
  } finally { release(); clients.forEach(client => client.disconnect()); await gateway.close(); }
});
