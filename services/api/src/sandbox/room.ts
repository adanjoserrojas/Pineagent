import type { Workspace } from "@pineagent/core/server";
import type { TestResult } from "@pineagent/harness";
import type { SandboxService } from "./broker";

/** The production harness never runs repository code on the API host. */
export class RoomSandbox {
  constructor(private readonly ws: Workspace, private readonly service: SandboxService) {
    ws.setLeaseFence(() => service.quiesce(ws.root));
    ws.setWriteFence(() => service.quiesce(ws.root));
  }

  async parseCommand(ownerId: string, line: string): Promise<{ event: string; body: Record<string, unknown> }> {
    if (!ownerId || typeof line !== "string" || Buffer.byteLength(line) > 8000) throw new Error("Invalid terminal command");
    const session = { workspace: this.ws.root, owner: `${ownerId}/terminal`, grants: [] };
    const release = await this.ws.freeze("all");
    try {
      const generation = await this.service.ensure(session);
      const result = await this.service.execute({ ...session, generation }, ["/usr/local/bin/pineagent", "--browser-command", line], 10_000);
      if (result.code !== 0) throw new Error("Unsupported CLI command");
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== "object" || !("event" in parsed) || typeof parsed.event !== "string"
        || !("body" in parsed) || !parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) throw new Error("Invalid CLI response");
      return { event: parsed.event, body: parsed.body as Record<string, unknown> };
    } finally {
      try { await this.service.quiesce(this.ws.root); } finally { release(); }
    }
  }

  async runTests(ownerId: string, runId: string, testPath: string | null = null, validator: "node" | "python" = "node", signal?: AbortSignal): Promise<TestResult> {
    signal?.throwIfAborted();
    if (!ownerId || !runId || (testPath && !this.ws.resolvePath(testPath))) throw new Error("Invalid verification scope");
    if (!["node", "python"].includes(validator) || (testPath && !(validator === "python" ? /\.py$/ : /\.[cm]?js$/).test(testPath))) throw new Error("Unsupported verification language");
    const argv = validator === "python"
      ? ["/opt/python/bin/python", "-I", "-B", "/opt/python/bin/pytest", "-q", "-p", "no:cacheprovider", "--basetemp=/tmp/pytest", testPath ? `/workspace/${testPath}` : "/workspace"]
      : ["node", "--test", ...(testPath ? [`/workspace/${testPath}`] : [])];
    // Verification must not modify the implementation or its tests. Patch
    // writes go through Workspace.applyOps, never a writable test container.
    const session = { workspace: this.ws.root, owner: `${ownerId}/run/${runId}`, grants: [] };
    const release = await this.ws.freeze("all");
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { void this.service.quiesce(this.ws.root).then(() => reject(new Error("Verification cancelled")), reject); };
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      signal?.throwIfAborted();
      return await Promise.race([(async () => {
        const generation = await this.service.ensure(session);
        signal?.throwIfAborted();
        const result = await this.service.execute({ ...session, generation }, argv, 120_000);
        signal?.throwIfAborted();
        return { exitCode: result.code, output: `${result.stdout}\n${result.stderr}`.slice(-48_000) };
      })(), cancelled]);
    } finally {
      signal?.removeEventListener("abort", abort);
      try { await this.service.quiesce(this.ws.root); }
      finally { release(); }
    }
  }
}
