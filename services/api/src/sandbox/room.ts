import type { Workspace } from "@pineagent/core/server";
import type { TestResult } from "@pineagent/harness";
import type { SandboxService } from "./broker";

/** The production harness never runs repository code on the API host. */
export class RoomSandbox {
  constructor(private readonly ws: Workspace, private readonly service: SandboxService) {
    ws.setLeaseFence(() => service.quiesce(ws.root));
    ws.setWriteFence(() => service.quiesce(ws.root));
  }

  async runTests(ownerId: string, runId: string, testPath: string | null = null): Promise<TestResult> {
    if (!ownerId || !runId || (testPath && !this.ws.resolvePath(testPath))) throw new Error("Invalid verification scope");
    // Verification must not modify the implementation or its tests. Patch
    // writes go through Workspace.applyOps, never a writable test container.
    const session = { workspace: this.ws.root, owner: `${ownerId}/run/${runId}`, grants: [] };
    const release = await this.ws.freeze("all");
    try {
      await this.service.ensure(session);
      const result = await this.service.execute(session, ["node", "--test", ...(testPath ? [`/workspace/${testPath}`] : [])], 120_000);
      return { exitCode: result.code, output: `${result.stdout}\n${result.stderr}`.slice(-48_000) };
    } finally {
      try { await this.service.quiesce(this.ws.root); }
      finally { release(); }
    }
  }
}
