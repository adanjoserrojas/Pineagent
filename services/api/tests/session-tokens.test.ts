import { expect, it } from "vitest";
import { SessionTokens } from "../src/sandbox/session-tokens";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import { createGateway } from "@pineagent/core/server";
import { roomName } from "@pineagent/core/contracts";

it("issues room-bound short-lived credentials and revokes them without retaining plaintext", () => {
  let now = 100;
  const sessions = new SessionTokens(() => now);
  const alice = { id: "alice", name: "Alice", avatarUrl: null };
  const { token, id } = sessions.issue(alice, "repo:main", 1000);
  expect(sessions.authenticate(token)).toMatchObject({ id: "alice", session: { roomId: "repo:main", expiresAt: 1100 } });
  expect(sessions.authenticate(`${token}x`)).toBeNull();
  expect(JSON.stringify(sessions)).not.toContain(token);
  sessions.revoke(id);
  expect(sessions.authenticate(token)).toBeNull();
  const next = sessions.issue(alice, "repo:main", 1000);
  now = 1100;
  expect(sessions.authenticate(next.token)).toBeNull();
});

it("refuses cross-room use and disconnects a revoked capability before dispatching its next event", async () => {
  const sessions = new SessionTokens();
  const http = createServer();
  let prepared = 0;
  const gateway = createGateway({ http, allowedOrigins: [], authenticate: async (token) => sessions.authenticate(token),
    sessionActive: (user) => sessions.active(user),
    prepare: async () => { prepared++; throw new Error("must not prepare another room"); } });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const issued = sessions.issue({ id: "alice", name: "Alice", avatarUrl: null }, roomName("owner/repo", "main"));
  const socket = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], auth: { token: issued.token }, reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    const reply = await socket.timeout(1000).emitWithAck("room:join", { wsId: "owner/other", branch: "main" });
    expect(reply).toEqual({ ok: false, code: "NOT_COLLABORATOR" });
    expect(prepared).toBe(0);
    sessions.revoke(issued.id);
    const disconnected = new Promise<void>((resolve) => socket.once("disconnect", () => resolve()));
    socket.emit("file:snapshot", { path: "file.ts" }, () => { throw new Error("revoked event dispatched"); });
    await disconnected;
  } finally { socket.disconnect(); await gateway.close(); }
});
