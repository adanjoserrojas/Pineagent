import { expect, it } from "vitest";
import { createSandboxBroker, SandboxClient } from "../src/sandbox/broker";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("exposes only bounded sandbox operations and never a host command endpoint", async () => {
  let calls = 0;
  const broker = createSandboxBroker({
    ensure: async () => { calls++; return "sandbox"; },
    execute: async () => ({ stdout: "ok", stderr: "", code: 0 }),
    quiesce: async () => {},
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    expect((await post("/host/exec", { command: "id" })).status).toBe(404);
    expect((await post("/open", { workspace: "/tmp/repo", owner: "alice", grants: [42] })).status).toBe(400);
    expect(calls).toBe(0);
    const response = await post("/open", { workspace: "/tmp/repo", owner: "alice", grants: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "sandbox" });
    expect(calls).toBe(1);
    expect((await post("/open", { oversized: "x".repeat(65_537) })).status).toBe(413);
  } finally { broker.closeAllConnections(); await new Promise<void>((resolve) => broker.close(() => resolve())); }
});

it("transports operations through a private local socket without leaking supervisor errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-ipc-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pineagent-${randomUUID()}` : join(root, "control.sock");
  const broker = createSandboxBroker({ ensure: async () => "name",
    execute: async () => ({ stdout: "pass", stderr: "", code: 0 }),
    quiesce: async () => { throw new Error("sensitive host error must not cross IPC"); } });
  await new Promise<void>((resolve) => broker.listen(path, resolve));
  const client = new SandboxClient(path);
  const session = { workspace: root, owner: "alice", grants: [] };
  try {
    expect(await client.ensure(session)).toBe("name");
    expect(await client.execute(session, ["node", "--test"])).toEqual({ stdout: "pass", stderr: "", code: 0 });
    await expect(client.quiesce(root)).rejects.toThrow("Sandbox unavailable");
  } finally { broker.closeAllConnections(); await new Promise<void>((resolve) => broker.close(() => resolve())); }
});
