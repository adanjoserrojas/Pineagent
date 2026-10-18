// Local-only browser integration fixture. Never bundled into production.
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, GitRepo } from "@pineagent/core/server";
import { SessionTokens } from "../src/sandbox/session-tokens";
import { TerminalHost } from "../src/sandbox/terminal-host";
import { openTerminalRelay } from "../src/sandbox/terminal-relay";

if (!process.env.PINEAGENT_PTY_ROOT || !process.env.PINEAGENT_SANDBOX_IMAGE) throw new Error("Local Docker fixture configuration missing");
const root = await mkdtemp(join(tmpdir(), "pty-preview-"));
const remote = await mkdtemp(join(tmpdir(), "pty-preview-remote-"));
await writeFile(join(root, "value.txt"), "Ratatui reads through the authenticated backend.");
const repo = await GitRepo.init(root, remote);
const sessions = new SessionTokens();
const host = new TerminalHost({ relayRoot: process.env.PINEAGENT_PTY_ROOT, image: process.env.PINEAGENT_SANDBOX_IMAGE, uid: process.getuid!() });
const http = createServer();
const gateway = createGateway({ http, allowedOrigins: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/], prepare: async () => repo,
  authenticate: async token => sessions.authenticate(token) ?? (token === "dev:alice" ? { id: "dev|alice", name: "Alice", avatarUrl: null } : null),
  sessionActive: user => sessions.active(user),
  pty: (context, size, port) => openTerminalRelay({ context, ...size, port, root: process.env.PINEAGENT_PTY_ROOT!, backend: host, sessions }) });
http.listen(3311, "0.0.0.0", () => console.log("Local real-Ratatui fixture ready on 3311"));
process.on("SIGTERM", () => { void gateway.close().then(() => host.shutdown()).then(() => process.exit(0)); });
