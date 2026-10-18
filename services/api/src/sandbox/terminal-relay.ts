import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import type { JoinContext, PtySession } from "@pineagent/core/server";
import type { TerminalBackend } from "./terminal-host";
import type { SessionTokens } from "./session-tokens";

// Private relay directory is outside all repositories. Its only credential is
// an expiring, room-bound application capability, never an Auth0/provider token.
export async function openTerminalRelay(options: {
  root: string; backend: TerminalBackend; sessions: SessionTokens;
  context: JoinContext; port: number; cols: number; rows: number;
}): Promise<PtySession> {
  const { context, sessions, backend } = options;
  if (context.user.session || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid terminal owner");
  const relayId = randomUUID();
  const dir = join(resolve(options.root), relayId);
  const grant = sessions.issue(context.user, context.roomId, 15 * 60_000);
  const peers = new Set<Socket>();
  let id: string | undefined, closed = false;
  const server = createServer(peer => {
    if (closed || peers.size >= 32 || !sessions.active({ ...context.user, session: { id: grant.id, roomId: context.roomId, expiresAt: grant.expiresAt } })) { peer.destroy(); return; }
    const upstream = createConnection({ host: "127.0.0.1", port: options.port });
    peers.add(peer); peers.add(upstream);
    const cleanup = () => { peer.destroy(); upstream.destroy(); peers.delete(peer); peers.delete(upstream); };
    peer.on("error", cleanup); upstream.on("error", cleanup);
    peer.on("close", cleanup); upstream.on("close", cleanup);
    peer.setTimeout(60_000, cleanup); upstream.setTimeout(60_000, cleanup);
    peer.pipe(upstream); upstream.pipe(peer);
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true; sessions.revoke(grant.id);
    for (const peer of peers) peer.destroy();
    server.close();
    if (id) await backend.close(id);
    // This is a freshly generated UUID child, never a caller-supplied directory.
    await rm(dir, { recursive: true, force: true });
  })();
  try {
    await mkdir(dir, { recursive: false, mode: 0o700 });
    await writeFile(join(dir, "token"), grant.token, { mode: 0o600, flag: "wx" });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(join(dir, "relay.sock"), done); });
    await chmod(join(dir, "relay.sock"), 0o600);
    id = await backend.open({ relayId, wsId: context.wsId, branch: context.branch, cols: options.cols, rows: options.rows });
    return { id, expiresAt: grant.expiresAt,
      read: after => backend.read(id!, after), input: data => backend.input(id!, data),
      resize: (cols, rows) => backend.resize(id!, cols, rows), close };
  } catch (error) { await close(); throw error; }
}
