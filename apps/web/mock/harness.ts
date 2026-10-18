// A scripted stand-in for Software Engineer 1's agent harness (LLD sections 1, 2, 9), so the run
// panel and the plant can be built and tested before the real planner, router and executor exist.
//
// It follows the real pipeline's shape: plan → lock the whole writeSet (or wait, blocked) → route
// → maybe ask for approval → execute steps → done/error. Words in the task pick the demo path:
//   "unsure"   low confidence: wait for the owner to pick one of 3 plans (or "none of these")
//   "backup"   OpenAI Decisions can't score: Jev scores instead (router mode jev)
//   "fallback" no scorer at all: router mode llm (step-by-step LLM routing)
//   "recover"  the second step fails verification; a warm coding agent continues (codingRecovery)
//   "fail"     the second step fails
//   same task twice → router mode cache
// The run really locks its file and edits it, so the explorer, the editor and the commit dialog
// all see the agent.
import type { RouterMode, RunActionAck, RunCandidate, RunStartAck, RunState, RunStep, RunView } from "@pineagent/core/contracts";
import type { Harness, HarnessEvents, Workspace } from "@pineagent/core/server";

type Owner = { id: string; name: string };

type Run = {
  view: RunView;
  paused: boolean; // pause requested; takes effect at the next step boundary
  resume: (() => void) | null;
  decide: ((choice: { candidateId: string } | { none: true; hint: string }) => void) | null;
};

const CONFIDENCE_THRESHOLD = 0.6; // LLD 2: placeholder, tune on real scores
const MAX_TASK = 500;

export class MockHarness implements Harness {
  private readonly runs = new Map<string, Run>();
  private readonly routedBefore = new Set<string>(); // the router's score cache
  private seq = 0;
  private closed = false;

  constructor(
    private readonly ws: Workspace,
    private readonly workspaceId: string,
    private readonly files: () => Promise<string[]>,
    private readonly events: HarnessEvents,
    private readonly stepMs = 900,
  ) {}

  list(): RunView[] {
    return [...this.runs.values()].map((r) => r.view);
  }

  start(owner: Owner, task: unknown, mode: unknown = "code"): RunStartAck {
    if (mode !== "ask" && mode !== "code") return { ok: false, code: "BAD_REQUEST" };
    if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK) return { ok: false, code: "BAD_REQUEST" };
    const runId = `run-${++this.seq}`;
    const run: Run = {
      view: {
        mode,
        runId,
        ownerId: owner.id,
        ownerName: owner.name,
        task: task.trim(),
        state: "planning",
        routerMode: null,
        codingRecovery: "none",
        nodeIndex: -1,
        seq: 0,
        steps: [],
        writeSet: [],
        startedAt: Date.now(),
      },
      paused: false,
      resume: null,
      decide: null,
    };
    this.runs.set(runId, run);
    void this.drive(run).catch((err) => this.fail(run, -1, String(err)));
    return { ok: true, runId };
  }

  approve(runId: string, userId: string, choice: { candidateId?: unknown; none?: unknown; hint?: unknown }): RunActionAck {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, code: "NOT_FOUND" };
    if (run.view.ownerId !== userId) return { ok: false, code: "NOT_OWNER" };
    if (run.view.state !== "awaiting_approval" || !run.decide) return { ok: false, code: "NOT_WAITING" };
    if (choice.none === true) {
      run.decide({ none: true, hint: typeof choice.hint === "string" ? choice.hint.slice(0, 300) : "" });
    } else if (typeof choice.candidateId === "string" && run.view.candidates?.some((c) => c.id === choice.candidateId)) {
      run.decide({ candidateId: choice.candidateId });
    } else {
      return { ok: false, code: "NOT_WAITING" };
    }
    run.decide = null;
    return { ok: true };
  }

  pause(runId: string, userId: string): RunActionAck {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, code: "NOT_FOUND" };
    if (run.view.ownerId !== userId) return { ok: false, code: "NOT_OWNER" };
    if (run.view.mode === "ask" || run.view.state === "done" || run.view.state === "error") return { ok: false, code: "NOT_WAITING" };
    run.paused = true;
    return { ok: true };
  }

  resume(runId: string, userId: string): RunActionAck {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, code: "NOT_FOUND" };
    if (run.view.ownerId !== userId) return { ok: false, code: "NOT_OWNER" };
    run.paused = false;
    run.resume?.();
    run.resume = null;
    return { ok: true };
  }

  close() {
    this.closed = true;
  }

  // --- The scripted pipeline ----------------------------------------------------------------

  private async drive(run: Run) {
    if (run.view.mode === "ask") {
      this.update(run, { state: "executing" });
      await this.sleep();
      if (!this.closed) this.update(run, { state: "done", endedAt: Date.now(), answer: "Mock read-only answer: this fixture is a collaborative workspace. No files were changed.", evidencePaths: [] });
      return;
    }
    const task = run.view.task.toLowerCase();
    const target = await this.pickFile(task);

    // 1 PLAN: goal + writeSet.
    this.update(run, { state: "planning", writeSet: [target] });
    await this.sleep();

    // 2 ACQUIRE the whole writeSet atomically, or wait as blocked.
    if (!(await this.acquire(run))) return;

    // 3-4 SELECT + ROUTE.
    // OpenAI Decisions is the primary scorer; Jev only covers for it (contracts/RUN_EVENTS.md).
    const mode: RouterMode = task.includes("fallback")
      ? "llm"
      : this.routedBefore.has(task)
        ? "cache"
        : task.includes("backup")
          ? "jev"
          : "openai";
    this.routedBefore.add(task);
    this.update(run, { state: "routing", routerMode: mode });
    await this.sleep();

    let steps: RunStep[];
    if (mode === "llm") {
      steps = plans(target)[0]; // the LLM picks step by step; no candidate scores
    } else {
      const scores = task.includes("unsure") ? [0.48, 0.41, 0.33] : [0.86, 0.62, 0.4];
      const candidates: RunCandidate[] = plans(target).map((s, i) => ({ id: `dag-${i + 1}`, score: scores[i], steps: s }));
      steps = candidates[0].steps;
      if (candidates[0].score < CONFIDENCE_THRESHOLD) {
        // Low confidence: never auto-write. The owner picks, or asks for a replan.
        this.update(run, { state: "awaiting_approval", candidates, confidence: candidates[0].score });
        const choice = await new Promise<{ candidateId: string } | { none: true; hint: string }>((r) => (run.decide = r));
        if (this.closed) return;
        if ("none" in choice) {
          // LLM replans with the hint, then the router re-scores.
          this.update(run, { state: "routing", candidates: undefined });
          await this.sleep();
          steps = [{ tool: "plan_with_hint", detail: choice.hint || "owner asked for another approach", writes: [] }, ...plans(target)[1]];
          this.update(run, { confidence: 0.71 });
        } else {
          steps = candidates.find((c) => c.id === choice.candidateId)!.steps;
        }
      }
      this.update(run, { candidates: undefined, confidence: run.view.confidence ?? candidates[0].score });
    }
    this.update(run, { steps });

    // 5 EXECUTE in order.
    for (let i = 0; i < steps.length; i++) {
      if (run.paused && !(await this.pauseHere(run, i))) return;
      this.update(run, { state: "executing", nodeIndex: i });
      await this.sleep();
      if (this.closed) return;
      if (task.includes("fail") && i === 1) {
        return this.fail(run, i, `${steps[i].tool} failed twice (replanned once from this step)`);
      }
      if (task.includes("recover") && i === 1 && run.view.codingRecovery === "none") {
        // The DAG's step failed verification: a coding agent picks up the same working tree.
        // This changes codingRecovery only; the router mode stays what scoring chose.
        this.update(run, { codingRecovery: "warm_agent" });
        await this.sleep();
      }
      for (const path of steps[i].writes) await this.edit(run, path, i);
    }

    this.finish(run, { state: "done" });
  }

  // Pause at a step boundary: hand the files back to the owner until they resume.
  private async pauseHere(run: Run, nodeIndex: number): Promise<boolean> {
    this.releaseLocks(run);
    this.update(run, { state: "paused", nodeIndex });
    await new Promise<void>((r) => (run.resume = r));
    if (this.closed) return false;
    return this.acquire(run);
  }

  private async acquire(run: Run): Promise<boolean> {
    for (;;) {
      if (this.closed) return false;
      const res = this.ws.acquireForRun(run.view.writeSet, run.view.ownerId, run.view.runId);
      if (res.ok) {
        res.locks.forEach((l) => this.events.lockChanged(l.path, l, "acquired"));
        if (run.view.blockedOn) this.update(run, { blockedOn: undefined });
        return true;
      }
      if (run.view.state !== "blocked" || run.view.blockedOn?.path !== res.lock.path) {
        this.update(run, { state: "blocked", blockedOn: { path: res.lock.path, holder: res.lock.holder } });
      }
      await this.sleep(this.stepMs / 2);
    }
  }

  private async edit(run: Run, path: string, nodeIndex: number) {
    const file = await this.ws.read(path);
    if (!file) return this.fail(run, nodeIndex, `${path} no longer exists`);
    const ops = [{ offset: 0, length: 0, text: `// ${run.view.ownerName}'s agent: ${run.view.task}\n` }];
    const res = await this.ws.applyOps(path, run.view.ownerId, file.version, ops, run.view.runId);
    if (res.ok) this.events.fileChanged(path, res.version, ops, `agent-run/${run.view.runId}`);
  }

  private fail(run: Run, nodeIndex: number, message: string) {
    this.finish(run, { state: "error", error: { nodeIndex, message } });
  }

  private finish(run: Run, patch: Partial<RunView>) {
    this.releaseLocks(run);
    this.update(run, { ...patch, endedAt: Date.now() });
  }

  private releaseLocks(run: Run) {
    this.ws.releaseRun(run.view.runId).forEach((l) => this.events.lockChanged(l.path, null, "released"));
  }

  private update(run: Run, patch: Partial<RunView> & { state?: RunState }) {
    run.view = { ...run.view, ...patch, seq: run.view.seq + 1 };
    const v = run.view;
    this.events.run({
      runId: v.runId,
      ownerId: v.ownerId,
      workspaceId: this.workspaceId,
      seq: v.seq,
      state: v.state,
      routerMode: v.routerMode,
      codingRecovery: v.codingRecovery,
      nodeIndex: v.nodeIndex,
      ts: Date.now(),
      run: v,
    });
  }

  // The file the task names (by file name), else src/auth.ts.
  private async pickFile(task: string): Promise<string> {
    const files = (await this.files()).filter((p) => !p.endsWith(".json") && !p.endsWith(".md"));
    return files.find((p) => task.includes(p.split("/").pop()!.toLowerCase())) ?? files.find((p) => p === "src/auth.ts") ?? files[0];
  }

  private sleep(ms = this.stepMs) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }
}

// Three candidate DAGs for a one-file change, in the router's usual preference order.
function plans(path: string): RunStep[][] {
  return [
    [
      { tool: "read_file", detail: path, writes: [] },
      { tool: "edit_file", detail: path, writes: [path] },
      { tool: "run_tests", detail: "npm test", writes: [] },
    ],
    [
      { tool: "grep", detail: "callers", writes: [] },
      { tool: "edit_file", detail: path, writes: [path] },
      { tool: "format", detail: path, writes: [] },
      { tool: "run_tests", detail: "npm test", writes: [] },
    ],
    [
      { tool: "read_file", detail: path, writes: [] },
      { tool: "write_tests", detail: "new test", writes: [] },
      { tool: "edit_file", detail: path, writes: [path] },
    ],
  ];
}
