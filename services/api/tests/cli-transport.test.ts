import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway, GitRepo } from "@pineagent/core/server";
import type { RunView } from "@pineagent/core/contracts";

const cli = process.env.PINEAGENT_CLI_BIN;
const exec = promisify(execFile);

describe.skipIf(!cli)("Rust CLI against the real Socket.IO gateway", () => {
  let gateway: ReturnType<typeof createGateway>;
  let endpoint: string;
  let tokenFile: string;
  const fixtures: string[] = [];
  const runs: RunView[] = [];
  let slowReplies = false;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "pineagent-cli-integration-"));
    const remote = await mkdtemp(join(tmpdir(), "pineagent-cli-remote-"));
    fixtures.push(root, remote);
    await writeFile(join(root, "hello.txt"), "hello");
    const repo = await GitRepo.init(root, remote);
    const http = createServer();
    gateway = createGateway({
      http, allowedOrigins: [],
      authenticate: async (token) => {
        // Real authentication is asynchronous. Joining before its connect ack
        // drops the event; the Rust client must wait, not add a fixed sleep.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return token === "integration-session" ? { id: "alice", name: "Alice", avatarUrl: null } : null;
      },
      prepare: async () => repo,
      timing: { heartbeatMs: 100, leaseMs: 800, idleMs: 60_000, sweepMs: 50 },
      harness: () => ({
        start: (owner, task) => {
          if (typeof task !== "string") return { ok: false, code: "BAD_REQUEST" };
          runs.push({ runId: "run-cli", ownerId: owner.id, ownerName: owner.name, task, state: "routing", routerMode: "openai", nodeIndex: -1, seq: 1, steps: [], writeSet: [], startedAt: Date.now() });
          return { ok: true, runId: "run-cli" };
        },
        list: () => runs,
        approve: () => ({ ok: false, code: "NOT_OWNER" }),
        pause: () => ({ ok: false, code: "NOT_WAITING" }),
        resume: () => ({ ok: false, code: "NOT_WAITING" }),
        close: () => {},
      }),
    });
    gateway.io.on("connection", (socket) => socket.use(([event], next) => {
      if (slowReplies && (event === "run:list" || event === "file:snapshot")) setTimeout(next, 1200);
      else next();
    }));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    endpoint = `http://127.0.0.1:${address.port}`;
    const tokens = await mkdtemp(join(tmpdir(), "pineagent-cli-token-"));
    fixtures.push(tokens);
    tokenFile = join(tokens, "session");
    await writeFile(tokenFile, "integration-session", { mode: 0o600 });
  });

  afterAll(async () => {
    await gateway?.close();
    await Promise.all(fixtures.map((path) => rm(path, { recursive: true, force: true })));
  });

  const environment = () => ({ ...process.env, TERM: "xterm-256color", PINEAGENT_URL: endpoint, PINEAGENT_WORKSPACE: "demo", PINEAGENT_BRANCH: "main", PINEAGENT_TOKEN_FILE: tokenFile });
  const invoke = (args: string[]) => exec(cli!, args, {
    env: environment(),
    timeout: 20_000, maxBuffer: 100_000,
  });

  it("joins, starts a task as the authenticated owner, and fetches the real snapshot", async () => {
    const started = await invoke(["--command", "run implement sum()"]);
    expect(JSON.parse(started.stdout)).toEqual({ ok: true, runId: "run-cli" });
    const listed = await invoke(["--check"]);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, runs: [{ ownerId: "alice", task: "implement sum()", routerMode: "openai" }] });
  }, 45_000);

  it("does not execute an arbitrary shell command", async () => {
    await expect(invoke(["--command", "touch stolen.txt"])).rejects.toMatchObject({ code: 1 });
  });

  it("reads workspace content through the authenticated gateway", async () => {
    const result = await invoke(["--command", "read hello.txt"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, path: "hello.txt", content: "hello", version: 1 });
  });

  it("fails closed on invalid authentication without printing the token", async () => {
    await writeFile(tokenFile, "invalid-integration-session", { mode: 0o600 });
    try {
      await expect(invoke(["--check"])).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining("invalid-integration-session") });
    } finally {
      await writeFile(tokenFile, "integration-session", { mode: 0o600 });
    }
  });

  it("preserves an ownership denial from the backend", async () => {
    await expect(invoke(["--command", "approve other-owner candidate-1"]))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("NOT_OWNER") });
  });

  it.skipIf(process.platform !== "linux")("keeps interactive locks alive while ordinary replies are slow, and restores the terminal on exit", async () => {
    slowReplies = true;
    // util-linux script supplies a real PTY without a native Node addon.
    const quotedBinary = `'${cli!.replaceAll("'", "'\\''")}'`;
    const child = spawn("script", ["-q", "-e", "-c", `stty cols 100 rows 30; exec ${quotedBinary}`, "/dev/null"], { env: environment() });
    let screen = "";
    child.stdout.on("data", (data) => { screen = (screen + data).slice(-200_000); });
    child.stderr.on("data", (data) => { screen = (screen + data).slice(-200_000); });
    const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    try {
      await expect.poll(() => screen, { timeout: 5000 }).toContain("Pineagent");
      child.stdin.write("lock hello.txt\r");
      const room = await gateway.room("ws:demo:main");
      await expect.poll(() => room.ws.allLocks().some((lock) => lock.path === "hello.txt"), { timeout: 5000 }).toBe(true);
      child.stdin.write("read hello.txt\r");
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(room.ws.allLocks().some((lock) => lock.path === "hello.txt")).toBe(true);
      child.stdin.write("\x1b");
      expect(await exited).toBe(0);
      expect(screen).toContain("\x1b[?1049l"); // leaves the alternate screen
    } finally {
      slowReplies = false;
      child.kill();
    }
  }, 20_000);
});
