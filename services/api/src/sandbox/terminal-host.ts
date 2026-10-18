import { randomUUID, createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { dockerCommand, type DockerCommand } from "./host";

export type TerminalLaunch = { relayId: string; wsId: string; branch: string; cols: number; rows: number };
export type TerminalChunk = { data: string; offset: number; exited: boolean };
export interface TerminalBackend {
  open(value: TerminalLaunch): Promise<string>;
  read(id: string, after: number): Promise<TerminalChunk>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
}
export const dimensions = (cols: number, rows: number) => Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 2 && rows <= 200;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Running = { name: string; output: Buffer; base: number; stream?: Duplex; exited: boolean; expires: number; created?: boolean; cancelled?: boolean; admission?: Promise<void>; closing?: Promise<void> };

// Separate from writable/test sandboxes. No workspace, network, Docker socket,
// Git credentials or provider keys enter this container. Only the fixed CLI runs.
export class TerminalHost implements TerminalBackend {
  private readonly sessions = new Map<string, Running>();
  private readonly command: DockerCommand;
  private readonly scope: string;
  private stopping = false;
  constructor(private readonly config: { relayRoot: string; image: string; uid: number; dockerSocket?: string; command?: DockerCommand }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(config.image) || !Number.isInteger(config.uid) || config.uid < 1 || config.uid > 60_000) throw new Error("Invalid terminal image/identity");
    this.command = config.command ?? dockerCommand;
    this.scope = createHash("sha256").update(resolve(config.relayRoot)).digest("hex");
  }
  private async checked(args: string[]) { if ((await this.command(args)).code !== 0) throw new Error("Terminal Docker operation failed"); }
  async recover() {
    const result = await this.command(["ps", "-aq", "--filter", `label=pineagent.terminal=${this.scope}`]);
    if (result.code !== 0) throw new Error("Terminal recovery failed");
    for (const id of result.stdout.split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid container ID");
      await this.checked(["rm", "-f", id]);
    }
  }
  private get(id: string) {
    const running = this.sessions.get(id);
    if (!running || Date.now() >= running.expires) throw new Error("Terminal session expired");
    return running;
  }
  async open(value: TerminalLaunch): Promise<string> {
    if (!uuid.test(value.relayId) || !dimensions(value.cols, value.rows)
      || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(value.wsId)
      || !/^[A-Za-z0-9._/-]{1,200}$/.test(value.branch) || this.stopping || this.sessions.size >= 16) throw new Error("Invalid terminal launch");
    const id = randomUUID();
    const running: Running = { name: `pineagent-tui-${id}`, output: Buffer.alloc(0), base: 0, exited: false, expires: Date.now() + 15 * 60_000 };
    let admitted!: () => void;
    running.admission = new Promise<void>(done => { admitted = done; });
    const check = () => { if (running.cancelled || this.stopping) throw new Error("Terminal admission cancelled"); };
    this.sessions.set(id, running); // reserve capacity before asynchronous admission
    try {
      const dir = join(this.config.relayRoot, value.relayId);
      if (await realpath(dir) !== resolve(dir) || /[,\r\n]/.test(dir)) throw new Error("Invalid relay path");
      const [folder, socket, token] = await Promise.all([lstat(dir), lstat(join(dir, "relay.sock")), lstat(join(dir, "token"))]);
      if (!folder.isDirectory() || folder.isSymbolicLink() || !socket.isSocket() || !token.isFile() || token.nlink !== 1
        || token.isSymbolicLink() || folder.uid !== this.config.uid || socket.uid !== this.config.uid || token.uid !== this.config.uid) throw new Error("Invalid relay ownership");
      check();
      await this.checked(["create", "--name", running.name, "--label", `pineagent.terminal=${this.scope}`,
        "--init", "--interactive", "--tty", "--user", `${this.config.uid}:${this.config.uid}`, "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cpus", "1", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "64",
        "--ulimit", "nofile=128:128", "--workdir", "/tmp", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
        "--mount", `type=bind,source=${dir},target=/relay,readonly,bind-recursive=disabled`,
        "--env", "TERM=xterm-256color", "--env", "HOME=/tmp", "--env", "PINEAGENT_RELAY_SOCKET=/relay/relay.sock",
        "--env", "PINEAGENT_TOKEN_FILE=/relay/token", "--env", `PINEAGENT_WORKSPACE=${value.wsId}`, "--env", `PINEAGENT_BRANCH=${value.branch}`,
        "--entrypoint", "/usr/local/bin/pineagent", this.config.image]);
      running.created = true;
      check();
      running.stream = await this.attach(running);
      check();
      await this.checked(["start", running.name]);
      check();
      await this.resize(id, value.cols, value.rows);
      check();
      return id;
    } catch (error) { await this.remove(id, running); throw error; }
    finally { admitted(); }
  }
  private attach(running: Running): Promise<Duplex> {
    return new Promise((done, reject) => {
      const req = request({ socketPath: this.config.dockerSocket ?? "/var/run/docker.sock", method: "POST",
        path: `/containers/${running.name}/attach?stream=1&stdin=1&stdout=1&stderr=1`, headers: { Connection: "Upgrade", Upgrade: "tcp" } });
      const timer = setTimeout(() => req.destroy(new Error("Terminal attach deadline")), 10_000);
      req.once("error", error => { clearTimeout(timer); reject(error); });
      req.once("response", res => { clearTimeout(timer); res.resume(); reject(new Error("Terminal attach refused")); });
      req.once("upgrade", (_res, stream, head) => {
        clearTimeout(timer);
        const append = (chunk: Buffer) => {
          if (running.output.length + chunk.length > 256_000) { running.exited = true; stream.destroy(); return; }
          running.output = Buffer.concat([running.output, chunk]);
        };
        stream.on("data", append);
        stream.on("error", () => { running.exited = true; });
        stream.on("close", () => { running.exited = true; });
        if (head.length) append(head);
        done(stream);
      });
      req.end();
    });
  }
  async read(id: string, after: number): Promise<TerminalChunk> {
    const r = this.get(id);
    if (!Number.isSafeInteger(after) || after < r.base || after > r.base + r.output.length) throw new Error("Invalid output cursor");
    r.output = r.output.subarray(after - r.base); r.base = after;
    const chunk = r.output.subarray(0, 128_000);
    return { data: chunk.toString("base64"), offset: r.base + chunk.length, exited: r.exited && chunk.length === r.output.length };
  }
  async input(id: string, data: string) {
    const r = this.get(id);
    if (typeof data !== "string" || !data.length || Buffer.byteLength(data) > 8192 || r.exited || !r.stream || r.stream.writableLength > 32_768) throw new Error("Invalid terminal input");
    r.stream.write(data);
  }
  async resize(id: string, cols: number, rows: number) {
    if (!dimensions(cols, rows)) throw new Error("Invalid terminal dimensions");
    const r = this.get(id);
    await new Promise<void>((done, reject) => {
      const req = request({ socketPath: this.config.dockerSocket ?? "/var/run/docker.sock", method: "POST",
        path: `/containers/${r.name}/resize?w=${cols}&h=${rows}` }, res => {
        res.resume(); res.once("end", () => res.statusCode === 200 ? done() : reject(new Error("Terminal resize refused")));
      });
      const timer = setTimeout(() => req.destroy(new Error("Terminal resize deadline")), 5000);
      req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end();
    });
  }
  async close(id: string) {
    const r = this.sessions.get(id); if (!r) return;
    r.cancelled = true;
    await r.admission;
    await this.remove(id, r);
  }
  private remove(id: string, r: Running): Promise<void> {
    if (this.sessions.get(id) !== r) return Promise.resolve();
    if (!r.closing) r.closing = (async () => {
      r.stream?.destroy();
      if (r.created) await this.checked(["rm", "--force", r.name]);
      this.sessions.delete(id);
    })().catch(error => { r.closing = undefined; throw error; });
    return r.closing;
  }
  async reap() { for (const [id, r] of this.sessions) if (r.expires <= Date.now() || r.exited) await this.close(id); }
  async shutdown() { this.stopping = true; for (const id of this.sessions.keys()) await this.close(id); }
}
