import { mkdtemp, writeFile, mkdir, chmod, readFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SandboxHost, type DockerCommand } from "../src/sandbox/host";

it("accepts the dedicated system account but never root as a sandbox identity", () => {
  const config = { workspaceRoot: tmpdir(), image: `sha256:${"a".repeat(64)}` };
  expect(() => new SandboxHost({ ...config, uid: 993 })).not.toThrow();
  for (const uid of [0, -1, 1.5, 60001]) expect(() => new SandboxHost({ ...config, uid })).toThrow("non-root");
});

it("does not launch an abandoned queued open and rejects stale generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-admission-"));
  const workspace = join(root, "repo");
  await mkdir(join(workspace, ".git"), { recursive: true });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  const host = new SandboxHost({ workspaceRoot: root, image: `sha256:${"a".repeat(64)}`,
    command: async args => { if (args[0] === "ps") await held; if (args[0] === "start") starts++;
      return { stdout: "", stderr: "", code: 0 }; } });
  const session = { workspace, owner: "alice", grants: [] };
  const abort = new AbortController();
  const pending = host.ensure(session, { deadline: Date.now() + 1000, signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow("admission expired");
  abort.abort(); release(); await rejected;
  expect(starts).toBe(0);
  const old = await host.ensure(session);
  const current = await host.ensure(session);
  expect(current).not.toBe(old);
  await expect(host.execute({ ...session, generation: old }, ["node", "--version"])).rejects.toThrow("generation expired");
  expect((await host.execute({ ...session, generation: current }, ["node", "--version"])).code).toBe(0);
  await host.close();
});

it("stops the old container before replacing grants, and retains it on stop failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-sandbox-"));
  const calls: string[][] = [];
  let fail = false;
  const command: DockerCommand = async (args) => {
    calls.push(args);
    if (args[0] === "rm" && fail) throw new Error("daemon unavailable");
    return { stdout: "", stderr: "", code: 0 };
  };
  const host = new SandboxHost({ workspaceRoot: root, image: `sha256:${"a".repeat(64)}`, command });
  const workspace = join(root, "room");
  await mkdir(workspace);
  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, "owned.ts"), "old");
  const session = { workspace, owner: "alice", grants: ["owned.ts"] };
  await host.ensure(session);
  fail = true;
  await expect(host.ensure({ ...session, grants: [] })).rejects.toThrow("daemon unavailable");
  expect(calls.filter((args) => args[0] === "create")).toHaveLength(1);
  fail = false;
  await host.ensure({ ...session, grants: [] });
  expect(calls.filter((args) => args[0] === "create")).toHaveLength(2);
  await host.close();
});

it.runIf(Boolean(process.env.PINEAGENT_SANDBOX_IMAGE))("enforces real Docker mounts, denies Git/network/other files, and revokes an open descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-docker-"));
  const workspace = join(root, "repo");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "config"), "private git metadata");
  for (const path of ["mine.txt", "other.txt"]) {
    await writeFile(join(workspace, path), "original");
    await chmod(join(workspace, path), 0o666);
  }
  const host = new SandboxHost({ workspaceRoot: root, image: process.env.PINEAGENT_SANDBOX_IMAGE! });
  const session = { workspace, owner: "alice", grants: ["mine.txt"] };
  try {
    const generation = await host.ensure(session);
    const probe = await host.execute({ ...session, generation }, ["node", "-e", `
      const fs=require('fs'), os=require('os');
      if(process.getuid()===0) throw Error('root');
      fs.writeFileSync('/workspace/mine.txt','owned');
      for(const path of ['/workspace/other.txt','/workspace/.git/config','/etc/probe']) {
        let denied=false; try { fs.writeFileSync(path,'attack'); } catch { denied=true; }
        if(!denied) throw Error('write escaped: '+path);
      }
      if(fs.existsSync('/var/run/docker.sock')) throw Error('docker exposed');
      if(fs.existsSync('/workspace/.git/config')) throw Error('git exposed');
      if(Object.keys(os.networkInterfaces()).some(n=>n!=='lo')) throw Error('network exposed');
      if(Object.keys(process.env).some(n=>/^(AWS_|OPENAI_|ANTHROPIC_|JEV_|GITHUB_TOKEN)/.test(n))) throw Error('credentials exposed');
      const fd=fs.openSync('/workspace/mine.txt','w');
      const child=require('child_process').spawn('node',['-e',
        'setInterval(()=>require("fs").writeSync(3,"stale"),10)'], {detached:true,stdio:['ignore','ignore','ignore',fd]});
      child.unref(); fs.closeSync(fd);
      console.log('isolated');
    `]);
    expect(probe.code, probe.stderr).toBe(0);
    expect(probe.stdout).toContain("isolated");
    const replacement = await host.ensure({ ...session, grants: [] });
    await writeFile(join(workspace, "mine.txt"), "revoked");
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(join(workspace, "mine.txt"), "utf8")).toBe("revoked");
    await expect(host.execute({ ...session, generation }, ["node", "-e", "throw Error('stale')"])).rejects.toThrow("generation expired");
    expect((await host.execute({ ...session, generation: replacement }, ["node", "-e", "require('fs').writeFileSync('/workspace/mine.txt','attack')"])).code).not.toBe(0);
    expect(await readFile(join(workspace, "other.txt"), "utf8")).toBe("original");
  } finally { await host.close(); }
}, 60_000);

it("rejects directory grants containing hardlinks to an ungranted file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-grant-"));
  const workspace = join(root, "repo");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "other.txt"), "original");
  await link(join(workspace, "other.txt"), join(workspace, "src", "alias.txt"));
  const host = new SandboxHost({ workspaceRoot: root, image: `sha256:${"a".repeat(64)}`, command: async () => ({ stdout: "", stderr: "", code: 0 }) });
  await expect(host.ensure({ workspace, owner: "alice", grants: ["src/"] })).rejects.toThrow("Aliased");
});

it("revokes orphaned containers on supervisor restart before accepting new sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pineagent-restart-"));
  const calls: string[][] = [];
  const host = new SandboxHost({ workspaceRoot: root, image: `sha256:${"a".repeat(64)}`,
    command: async (args) => { calls.push(args); return { stdout: args[0] === "ps" ? "abcdef123456\n" : "", stderr: "", code: 0 }; } });
  await host.quiesce(root);
  expect(calls[0][0]).toBe("ps");
  expect(calls[1]).toEqual(["rm", "--force", "abcdef123456"]);
});
