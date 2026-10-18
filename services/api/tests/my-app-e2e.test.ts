import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createGateway, GitRepo } from "@pineagent/core/server";
import type { ClientToServerEvents, ServerToClientEvents } from "@pineagent/core/contracts";
import { LiveHarness } from "../src/harness/controller";
import { RoomSandbox } from "../src/sandbox/room";
import { SandboxHost } from "../src/sandbox/host";
import { TerminalHost } from "../src/sandbox/terminal-host";
import { SessionTokens } from "../src/sandbox/session-tokens";
import { openTerminalRelay } from "../src/sandbox/terminal-relay";

// Run only in the Linux integration runner with a Docker-host-visible named volume.
// MY_APP_SOURCE is a read-only checkout of f67daea40938c2219a6419afed6b6615f1287d1f.
it.runIf(Boolean(process.env.MY_APP_SOURCE && process.env.PINEAGENT_PTY_ROOT && process.env.PINEAGENT_SANDBOX_IMAGE))(
  "repairs a real My_App regression via authenticated Ratatui, V8 warm recovery, versioned writes and Docker pytest", async () => {
    const root = await mkdtemp(join(process.env.PINEAGENT_PTY_ROOT!, "myapp-"));
    const workspace = join(root, "repo"), remote = join(root, "remote");
    await mkdir(workspace); await mkdir(remote);
    for (const file of ["app.py", "storage.py", "config.py", "test_app.py", "requirements.txt"]) {
      await writeFile(join(workspace, file), await readFile(join(process.env.MY_APP_SOURCE!, file)));
    }
    const original = await readFile(join(workspace, "app.py"), "utf8");
    expect(original).toContain('str(data.get("title", "")).strip()');
    const regression = original.replace('str(data.get("title", "")).strip()', 'str(data.get("title", ""))');
    await writeFile(join(workspace, "app.py"), regression);
    const repo = await GitRepo.init(workspace, remote);
    const sandboxHost = new SandboxHost({ workspaceRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE!, uid: process.getuid!() });
    const terminalHost = new TerminalHost({ relayRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE!, uid: process.getuid!() });
    const sessions = new SessionTokens(), http = createServer();
    const checks: { exitCode: number | null; output: string }[] = [];
    const patches: boolean[] = [];
    const receipts: Record<string, unknown>[] = [];
    let harness: LiveHarness | undefined, room: RoomSandbox | undefined;
    const gateway = createGateway({ http, allowedOrigins: [], prepare: async () => repo,
      authenticate: async token => sessions.authenticate(token) ?? (token === "test-owner" ? { id: "alice", name: "Alice", avatarUrl: null } : null),
      sessionActive: user => sessions.active(user),
      protect: async ws => { room = new RoomSandbox(ws, sandboxHost); },
      harness: context => {
        harness = new LiveHarness({ context,
          model: () => ({ answer: async input => {
              expect(input.evidence).toContain("app.py");
              return "This is a Flask task app. No files changed.";
            }, plan: async () => ({ allowedWrites: ["app.py"], visibleTestPath: "test_app.py" }),
            patch: async (input, _signal, recovery) => {
              patches.push(Boolean(recovery));
              expect(input.evidence).toContain("FILE app.py\n");
              expect(input.evidence).toContain("FILE storage.py\n");
              if (recovery) expect(input.evidence).toContain("Visible verification failed:");
              return { files: [{ path: "app.py", content: recovery ? original : regression + "\n# first attempt\n" }] };
            } }),
          router: () => ({ route: async ({ candidates }) => ({ status: "selected", routerMode: "openai", candidateId: candidates.find(c => c.routeLabel === "failure_first_diagnosis")!.id }) }),
          runTests: async (owner, run, path, validator) => { const result = await room!.runTests(owner, run, path, validator); checks.push(result); return result; },
          receipt: (_run, result) => { receipts.push(result); },
        });
        return harness;
      },
      pty: (context, size, port) => openTerminalRelay({ context, ...size, port, root, backend: terminalHost, sessions }),
    });
    await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
    const port = (http.address() as { port: number }).port;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`http://127.0.0.1:${port}`, { auth: { token: "test-owner" }, reconnection: false });
    let screen = "";
    socket.on("terminal:output", (message, ack) => { screen += Buffer.from(message.data, "base64").toString(); ack(); });
    try {
      await new Promise<void>((done, reject) => { socket.once("connect", done); socket.once("connect_error", reject); });
      expect(await socket.emitWithAck("room:join", { wsId: "my-app", branch: "main" })).toMatchObject({ ok: true });
      const opened = await socket.timeout(30_000).emitWithAck("terminal:open", { cols: 140, rows: 35 });
      expect(opened.ok).toBe(true); if (!opened.ok) throw Error("Terminal failed");
      await expect.poll(() => screen, { timeout: 15000 }).toContain("Connected.");
      expect(await socket.emitWithAck("terminal:input", { id: opened.id, data: "ask What does this app do?\r" })).toEqual({ ok: true });
      await expect.poll(() => harness?.list()[0]?.state, { timeout: 15000 }).toBe("done");
      expect(harness!.list()[0]).toMatchObject({ mode: "ask", writeSet: [], routerMode: null, answer: "This is a Flask task app. No files changed." });
      // Ratatui advances the cursor between words instead of emitting spaces.
      await expect.poll(() => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, " "), { timeout: 10000 }).toContain("Flask task app");
      expect(patches).toEqual([]);
      expect(checks).toEqual([]);
      expect(await readFile(join(workspace, "app.py"), "utf8")).toBe(regression);
      expect(await socket.emitWithAck("terminal:input", { id: opened.id, data: "run Fix create_task() to reject whitespace-only titles.\r" })).toEqual({ ok: true });
      await expect.poll(() => harness?.list()[1]?.state, { timeout: 90_000 }).toBe("done");
      expect(patches).toEqual([false, true]);
      expect(checks.map(check => check.exitCode)).toEqual([1, 1, 0]);
      expect(checks.at(-1)!.output).toContain("5 passed");
      expect(receipts).toMatchObject([{ mode: "ask", modelCalls: 1, executorModelCalls: 0, status: "done" },
        { mode: "code", modelCalls: 3, executorModelCalls: 2, codingRecovery: "warm_agent", status: "done" }]);
      const active = await gateway.room("ws:my-app:main");
      expect(await active.ws.read("app.py")).toMatchObject({ version: 3, content: original });
      expect(active.ws.allLocks()).toEqual([]);
      expect(await readFile(join(workspace, "test_app.py"), "utf8")).toBe(await readFile(join(process.env.MY_APP_SOURCE!, "test_app.py"), "utf8"));
      expect(await socket.emitWithAck("terminal:resize", { id: opened.id, cols: 100, rows: 25 })).toEqual({ ok: true });
      expect(await socket.emitWithAck("terminal:close", { id: opened.id })).toEqual({ ok: true });
    } finally {
      socket.disconnect(); await gateway.close(); await terminalHost.shutdown(); await sandboxHost.close();
    }
  }, 120_000);
