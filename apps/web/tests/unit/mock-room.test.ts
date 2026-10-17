import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMock } from "../../mock/server";
import type { ClientToServerEvents, ServerToClientEvents } from "../../src/contracts/socket";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let mock: Awaited<ReturnType<typeof startMock>>;
const clients: Client[] = [];

function client(token: string): Client {
  const c: Client = io(`http://localhost:${mock.port}`, { auth: { token }, reconnection: false, forceNew: true });
  clients.push(c);
  return c;
}

const connected = (c: Client) => new Promise<void>((resolve) => c.once("connect", () => resolve()));

beforeAll(async () => {
  mock = await startMock({ port: 0 });
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await mock.close();
});

describe("mock handshake and room:join", () => {
  it("rejects a missing or non-dev token with UNAUTHENTICATED", async () => {
    const c = client("not-a-token");
    const err = await new Promise<Error & { data?: { code?: string } }>((resolve) => c.once("connect_error", resolve));
    expect(err.data?.code).toBe("UNAUTHENTICATED");
  });

  it("returns self, members, locks and the fixture tree", async () => {
    const c = client("dev:alice");
    await connected(c);
    const res = await c.emitWithAck("room:join", { wsId: "demo", branch: "main" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.self).toEqual({
      userId: "dev|alice",
      name: "alice",
      avatarUrl: "https://github.com/alice.png?size=64",
      openPath: null,
    });
    expect(res.locks).toEqual([]);
    expect(res.tree).toContain("src/auth.ts");
    expect(res.tree).toContain("src/routes/users.ts");
  });

  it("announces joins to the room and lists both members", async () => {
    const a = client("dev:carol");
    const b = client("dev:dave");
    await Promise.all([connected(a), connected(b)]);
    await a.emitWithAck("room:join", { wsId: "w2", branch: "main" });
    const joined = new Promise((resolve) => a.once("presence:changed", resolve));
    const res = await b.emitWithAck("room:join", { wsId: "w2", branch: "main" });
    expect(await joined).toMatchObject({ userId: "dev|dave", status: "joined" });
    expect(res.ok && res.members.map((m) => m.userId).sort()).toEqual(["dev|carol", "dev|dave"]);
  });

  it("broadcasts openPath changes as presence updates", async () => {
    const a = client("dev:gina");
    const b = client("dev:hank");
    await Promise.all([connected(a), connected(b)]);
    await a.emitWithAck("room:join", { wsId: "w4", branch: "main" });
    await b.emitWithAck("room:join", { wsId: "w4", branch: "main" });
    // The "joined" broadcast for hank can still be in flight, so wait for the update specifically.
    const updated = new Promise((resolve) =>
      a.on("presence:changed", (m) => {
        if (m.status === "updated") resolve(m);
      }),
    );
    b.emit("presence:update", { openPath: "src/auth.ts" });
    expect(await updated).toMatchObject({ userId: "dev|hank", status: "updated", openPath: "src/auth.ts" });
  });

  it("serves file snapshots and refuses paths outside the workspace", async () => {
    const c = client("dev:ivy");
    await connected(c);
    expect(await c.emitWithAck("file:snapshot", { path: "src/auth.ts" })).toEqual({ ok: false, code: "NOT_FOUND" }); // not joined
    await c.emitWithAck("room:join", { wsId: "w5", branch: "main" });

    const res = await c.emitWithAck("file:snapshot", { path: "src/auth.ts" });
    expect(res.ok && res.version).toBe(1);
    expect(res.ok && res.content).toContain("export async function currentUser");
    expect(res.ok && res.hash).toMatch(/^[0-9a-f]{64}$/);

    for (const path of ["../package.json", "src/../../x", "/etc/hosts", "nope.ts", ""]) {
      expect(await c.emitWithAck("file:snapshot", { path })).toEqual({ ok: false, code: "NOT_FOUND" });
    }
  });

  it("keeps branches in separate rooms", async () => {
    const a = client("dev:erin");
    const b = client("dev:frank");
    await Promise.all([connected(a), connected(b)]);
    await a.emitWithAck("room:join", { wsId: "w3", branch: "main" });
    const res = await b.emitWithAck("room:join", { wsId: "w3", branch: "feat/x" });
    expect(res.ok && res.members.map((m) => m.userId)).toEqual(["dev|frank"]);
  });
});
