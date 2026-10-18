// Privileged supervisor component, NOT an import for the public API entrypoint.
// Only a trusted room authority supplies grants. Never expose Docker or this
// interface to browser/CLI requests without the backend's lock/version checks.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export type CommandResult = { stdout: string; stderr: string; code: number };
export type DockerCommand = (args: string[], timeoutMs?: number) => Promise<CommandResult>;
export type SandboxSession = { workspace: string; owner: string; grants: string[] };
type Running = { workspace: string; name: string; grants: string; touched: number };

export const dockerCommand: DockerCommand = (args, timeoutMs = 15_000) => new Promise((done, reject) => {
  execFile("docker", args, { timeout: timeoutMs, maxBuffer: 128_000, windowsHide: true }, (error, stdout, stderr) => {
    // Numeric exit codes are command outcomes; timeouts/transport/output limit
    // failures are errors. The caller must remove a timed-out exec's container.
    if (error && (error.killed || typeof error.code !== "number")) return reject(new Error("Sandbox command interrupted"));
    done({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
  });
});

export class SandboxHost {
  private readonly sessions = new Map<string, Running>();
  private tail: Promise<void> = Promise.resolve();
  private readonly command: DockerCommand;
  private readonly uid: number;
  private readonly scope: string;
  private recovered = false;
  constructor(private readonly config: { workspaceRoot: string; image: string; uid?: number; command?: DockerCommand }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error("Pin the sandbox image to its local immutable image ID");
    this.uid = config.uid ?? 1000;
    if (!Number.isSafeInteger(this.uid) || this.uid < 1000 || this.uid > 60_000) throw new Error("Sandbox must use a non-root UID");
    this.command = config.command ?? dockerCommand;
    this.scope = createHash("sha256").update(resolve(config.workspaceRoot)).digest("hex");
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (!this.recovered) {
        const result = await this.command(["ps", "--all", "--quiet", "--filter", `label=pineagent.scope=${this.scope}`]);
        if (result.code !== 0) throw new Error("Cannot reconcile previous sandbox processes");
        for (const id of result.stdout.split(/\s+/).filter(Boolean)) {
          if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid Docker reconciliation result");
          await this.checked(["rm", "--force", id]);
        }
        this.recovered = true;
      }
      return op();
    });
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private async checked(args: string[]): Promise<void> {
    if ((await this.command(args)).code !== 0) throw new Error(`Sandbox ${args[0]} failed`);
  }

  private key(session: Pick<SandboxSession, "workspace" | "owner">): string {
    return createHash("sha256").update(JSON.stringify([resolve(session.workspace), session.owner])).digest("hex").slice(0, 32);
  }

  private async workspace(input: string): Promise<string> {
    const [root, target] = await Promise.all([realpath(this.config.workspaceRoot), realpath(input)]);
    if (!target.startsWith(root + sep) || target !== resolve(input) || /[,\r\n]/.test(target)) throw new Error("Invalid sandbox workspace");
    // Clones are ordinary directories, never worktree pointers to host .git.
    const git = await lstat(join(target, ".git"));
    if (!git.isDirectory() || git.isSymbolicLink()) throw new Error("Sandbox requires a clone with a local .git directory");
    return target;
  }

  private async grants(root: string, paths: string[]): Promise<string[]> {
    if (paths.length > 128) throw new Error("Too many writable grants");
    const unique = [...new Set(paths)].sort();
    let inspected = 0;
    const validateTree = async (full: string): Promise<void> => {
      if (++inspected > 10_000) throw new Error("Writable tree exceeds safety inspection limit");
      const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error("Aliased or special writable grant");
      if (info.isDirectory()) for (const child of await readdir(full)) {
        if (child.toLowerCase() === ".git") throw new Error("Nested Git metadata in writable grant");
        await validateTree(join(full, child));
      }
    };
    for (const path of unique) {
      const clean = path.endsWith("/") ? path.slice(0, -1) : path;
      const parts = clean.split("/");
      if (!clean || /[\\,:\x00-\x1f\x7f]/.test(clean) || parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[. ]$/.test(p))) throw new Error("Invalid writable grant");
      let cursor = root;
      for (const part of parts) {
        if (!(await readdir(cursor)).includes(part)) throw new Error("Noncanonical grant");
        cursor = join(cursor, part);
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error("Aliased or special writable grant");
      }
      const info = await lstat(cursor);
      if (info.isDirectory() !== path.endsWith("/")) throw new Error("Grant kind mismatch");
      if (info.isDirectory()) await validateTree(cursor);
    }
    // A directory mount already covers its children. Avoid ambiguous overmounts.
    return unique.filter((path) => !unique.some((parent) => parent !== path && parent.endsWith("/") && path.startsWith(parent)));
  }

  private async remove(key: string, running: Running): Promise<void> {
    // rm -f terminates the container and its processes before removing mounts.
    // Retain the record on daemon failure so no replacement can be launched.
    await this.checked(["rm", "--force", running.name]);
    this.sessions.delete(key);
  }

  // Must be called inside Workspace.freeze('all') by the room authority. The
  // freeze drains backend writes and quiesces old grants before a launch.
  ensure(session: SandboxSession): Promise<string> {
    return this.serialize(async () => {
      if (!session.owner || session.owner.length > 200) throw new Error("Invalid sandbox owner");
      const workspace = await this.workspace(session.workspace);
      const key = this.key(session);
      const old = this.sessions.get(key);
      // Stop before inspecting new grants: old writable processes must not race
      // filesystem validation. The public room authority also freezes API edits.
      if (old) await this.remove(key, old);
      const grants = await this.grants(workspace, session.grants);
      const signature = JSON.stringify(grants);
      if (this.sessions.size >= 16) throw new Error("Sandbox session capacity reached");
      const name = `pineagent-sandbox-${key}`;
      const mountRoot = workspace.replaceAll("\\", "/");
      const args = ["create", "--name", name, "--label", "pineagent.sandbox=1", "--label", `pineagent.scope=${this.scope}`, "--init",
        "--user", `${this.uid}:${this.uid}`, "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cpus", "1",
        "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
        "--ulimit", "nofile=1024:1024", "--workdir", "/workspace",
        "--env", "HOME=/tmp/home", "--env", "npm_config_cache=/tmp/npm-cache",
        "--mount", `type=bind,source=${mountRoot},target=/workspace,readonly,bind-recursive=disabled`,
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
        "--tmpfs", "/workspace/.git:ro,nosuid,nodev,noexec,size=1m,mode=0555"];
      for (const path of grants) {
        const clean = path.replace(/\/$/, "");
        args.push("--mount", `type=bind,source=${mountRoot}/${clean},target=/workspace/${clean},bind-recursive=disabled`);
      }
      args.push("--entrypoint", "sleep", this.config.image, "1800");
      await this.checked(args);
      const running = { workspace, name, grants: signature, touched: Date.now() };
      this.sessions.set(key, running);
      try { await this.checked(["start", name]); }
      catch (error) { await this.remove(key, running); throw error; }
      return name;
    });
  }

  async execute(session: SandboxSession, argv: string[], timeoutMs = 120_000): Promise<CommandResult> {
    if (!argv.length || argv.length > 128 || argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)) throw new Error("Invalid sandbox command");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid sandbox deadline");
    const key = this.key(session);
    const running = this.sessions.get(key);
    if (!running) throw new Error("Sandbox must be opened by the room authority");
    running.touched = Date.now();
    try { return await this.command(["exec", running.name, ...argv], timeoutMs); }
    catch (error) { await this.quiesce(session.workspace); throw error; }
  }

  quiesce(workspace: string): Promise<void> {
    return this.serialize(async () => {
      for (const [key, running] of this.sessions) {
        if (relative(resolve(workspace), running.workspace) === "") await this.remove(key, running);
      }
    });
  }

  reap(now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      for (const [key, running] of this.sessions) if (now - running.touched >= 30 * 60_000) await this.remove(key, running);
    });
  }

  close(): Promise<void> {
    return this.serialize(async () => { for (const [key, running] of this.sessions) await this.remove(key, running); });
  }
}
