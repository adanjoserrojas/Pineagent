// Separate privileged process. Never bundle this entry point into server.mjs.
import { chmod, chown, lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { SandboxHost } from "./host";
import { createSandboxBroker } from "./broker";
import { TerminalHost } from "./terminal-host";

if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Supervisor requires the dedicated Linux service");
const workspaceRoot = process.env.WORKSPACES_ROOT;
const image = process.env.SANDBOX_IMAGE;
const uid = Number(process.env.SANDBOX_UID);
if (!workspaceRoot?.startsWith("/") || !image || !Number.isInteger(uid) || uid < 1 || uid > 60_000) throw new Error("Configure workspace root, immutable sandbox image and non-root service UID");
const socketPath = "/run/pineagent-sandbox/control.sock";
process.umask(0o177);

const old = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (old) {
  if (!old.isSocket()) throw new Error("Refusing to replace non-socket supervisor path");
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Supervisor socket is busy")); });
    probe.once("connect", () => { probe.destroy(); reject(new Error("Another supervisor is active")); });
    probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  await unlink(socketPath); // exact fixed socket, verified stale; never a directory
}
const host = new SandboxHost({ workspaceRoot, image, uid });
await host.quiesce(workspaceRoot); // orphan reconciliation before accepting calls
const terminals = new TerminalHost({ relayRoot: process.env.TERMINAL_RELAY_ROOT ?? "/run/pineagent-terminals", image, uid });
await terminals.recover();
const server = createSandboxBroker(host, terminals);
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
await chown(socketPath, uid, uid);
await chmod(socketPath, 0o600);
const reap = setInterval(() => { void Promise.all([host.reap(), terminals.reap()]).catch(() => console.error("sandbox.reap_failed")); }, 60_000);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(reap);
  server.close();
  void Promise.all([host.close(), terminals.shutdown()]).then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 30_000).unref();
});
