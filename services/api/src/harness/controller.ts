import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Harness, HarnessContext } from "@pineagent/core/server";
import type { RunActionAck, RunStartAck, RunView } from "@pineagent/core/contracts";
import { executeV8Dag, selectCandidateDags, prototypeTools, FROZEN_HISTORY,
  type Router, type RouteDecision, type Patch, type TestResult, type DagCandidate } from "@pineagent/harness";
import { BackendTools, type EvidenceVersions } from "./tools";
import { languageForPlan } from "./python";
import { ModelFailure, type ModelReceipt } from "../models/bedrock";

type Model = {
  receipts?(): ModelReceipt[];
  plan(task: string, files: string[], signal?: AbortSignal): Promise<{ allowedWrites: string[]; visibleTestPath: string }>;
  patch(input: { task: string; evidence: string; allowedWrites: string[] }, signal?: AbortSignal, recovery?: boolean): Promise<Patch>;
};
type Run = { view: RunView; abort: AbortController; work: Promise<void>; pause: boolean;
  choice?: string; hint?: string; rejected: number; candidates: DagCandidate[] };
type Options = { context: HarnessContext; model(ownerId: string, runId: string): Model; router(ownerId: string, runId: string): Router;
  runTests(ownerId: string, runId: string, path?: string | null, validator?: "node" | "python"): Promise<TestResult>;
  receipt?(runId: string, result: Record<string, unknown>): void };
const terminal = (run: Run) => run.view.state === "done" || run.view.state === "error";
function failure(error: unknown, phase: string, aborted: boolean) {
  if (error instanceof ModelFailure) return { code: error.code, phase, message: error.message };
  const known: Record<string, [string, string]> = {
    "Unsupported verification language": ["UNSUPPORTED_LANGUAGE", "Code mode currently verifies JavaScript/Node or Python/pytest projects. This test language is not supported."],
    "Unsupported Python write/test scope": ["UNSUPPORTED_SCOPE", "The plan must name existing Python source files and a separate pytest test file; test changes are not authorized."],
    "Evidence changed; a fresh run is required": ["STALE_EVIDENCE", "A file changed after it was read. Start a fresh run to use the current version."],
    "Repository permission revoked": ["ACCESS_DENIED", "Repository access was lost. Check your GitHub access and reconnect."],
    "Verification failed": ["TESTS_FAILED", "The patch did not pass verification within the recovery budget. Review the changes before retrying."],
    "Invalid plan": ["INVALID_PLAN", "No valid coding plan was produced. Use Ask for questions or specify the source change and expected behavior."],
  };
  const item = error instanceof Error ? known[error.message] : undefined;
  return { code: aborted ? "RUN_CANCELLED" : item?.[0] ?? "RUN_FAILED", phase,
    message: aborted ? "Run cancelled or its time budget expired. Review any changes before retrying."
      : item?.[1] ?? `Could not complete ${phase}. No further writes were authorized. Review any changes and retry; give the operator this run ID if it repeats.` };
}
const steps = (candidate: DagCandidate) => candidate.order.map(tool => ({ tool,
  detail: candidate.nodes.find(n => n.name === tool)?.description ?? tool,
  writes: candidate.nodes.find(n => n.name === tool)?.writes ?? [] }));

/** Room-owned lifecycle around the sealed V8 policy, not a second routing policy. */
export class LiveHarness implements Harness {
  private readonly runs = new Map<string, Run>();
  private closed = false;
  constructor(private readonly options: Options) {}

  list(): RunView[] { return [...this.runs.values()].map(run => structuredClone(run.view)); }

  start(owner: { id: string; name: string }, task: unknown): RunStartAck {
    if (typeof task !== "string" || !task.trim() || task.length > 8000) return { ok: false, code: "BAD_REQUEST" };
    if (this.closed || [...this.runs.values()].filter(run => !terminal(run)).length >= 4) return { ok: false, code: "NOT_AVAILABLE" };
    if (this.runs.size >= 100) {
      const oldest = [...this.runs].find(([, run]) => terminal(run));
      if (oldest) this.runs.delete(oldest[0]);
    }
    const runId = randomUUID();
    const run: Run = { view: { runId, ownerId: owner.id, ownerName: owner.name, task: task.trim(), state: "planning",
      routerMode: null, codingRecovery: "none", nodeIndex: -1, seq: 0, steps: [], writeSet: [], startedAt: Date.now() },
      abort: new AbortController(), pause: false, rejected: 0, candidates: [], work: Promise.resolve() };
    this.runs.set(runId, run);
    this.emit(run);
    run.work = this.execute(run);
    return { ok: true, runId };
  }

  private emit(run: Run, update: Partial<RunView> = {}): void {
    Object.assign(run.view, update);
    run.view.seq++;
    const view = structuredClone(run.view);
    this.options.context.events.run({ runId: view.runId, ownerId: view.ownerId, workspaceId: this.options.context.roomId,
      seq: view.seq, state: view.state, routerMode: view.routerMode, codingRecovery: view.codingRecovery,
      nodeIndex: view.nodeIndex, ts: Date.now(), run: view });
  }

  private action(id: string, owner: string, apply: (run: Run) => boolean): RunActionAck {
    const run = this.runs.get(id);
    if (!run) return { ok: false, code: "NOT_FOUND" };
    if (run.view.ownerId !== owner) return { ok: false, code: "NOT_OWNER" };
    return apply(run) ? { ok: true } : { ok: false, code: "NOT_WAITING" };
  }
  pause(id: string, owner: string): RunActionAck {
    return this.action(id, owner, run => {
      if (terminal(run) || run.view.state === "awaiting_approval" || run.pause) return false;
      run.pause = true; return true;
    });
  }
  resume(id: string, owner: string): RunActionAck {
    return this.action(id, owner, run => {
      if (run.view.state !== "paused" || !run.pause) return false;
      run.pause = false; return true;
    });
  }
  approve(id: string, owner: string, choice: { candidateId?: unknown; none?: unknown; hint?: unknown }): RunActionAck {
    return this.action(id, owner, run => {
      if (run.view.state !== "awaiting_approval" || run.choice || run.hint) return false;
      if (choice.none === true) {
        if (typeof choice.hint !== "string" || !choice.hint.trim() || choice.hint.length > 2000) return false;
        run.hint = choice.hint.trim(); return true;
      }
      if (typeof choice.candidateId !== "string" || !run.view.candidates?.some(c => c.id === choice.candidateId)) return false;
      run.choice = choice.candidateId; return true;
    });
  }

  private async release(run: Run): Promise<void> {
    for (const lock of await this.options.context.ws.releaseRunSafely(run.view.runId))
      this.options.context.events.lockChanged(lock.path, null, "released");
  }
  private async acquire(run: Run): Promise<void> {
    while (true) {
      run.abort.signal.throwIfAborted();
      if (run.pause) {
        await this.release(run);
        this.emit(run, { state: "paused" });
        while (run.pause) await delay(100, undefined, { signal: run.abort.signal });
      }
      if (this.options.context.canWrite && !await this.options.context.canWrite(run.view.ownerId)) throw new Error("Repository permission revoked");
      const result = await this.options.context.ws.acquireRunSafely(run.view.writeSet, run.view.ownerId, run.view.runId);
      if (result.ok) {
        for (const lock of result.locks) this.options.context.events.lockChanged(lock.path, lock, "acquired");
        delete run.view.blockedOn;
        return;
      }
      this.emit(run, { state: "blocked", blockedOn: { path: result.lock.path, holder: result.lock.holder } });
      await delay(250, undefined, { signal: run.abort.signal });
    }
  }

  private async execute(run: Run): Promise<void> {
    const { context } = this.options;
    const { ownerId, runId } = run.view;
    const timeout = setTimeout(() => run.abort.abort(), 15 * 60_000);
    let providerAttempts = 0;
    let executorModelCalls = 0;
    let phase = "setup";
    let failed: ReturnType<typeof failure> | undefined;
    let model: Model | undefined;
    let observations: EvidenceVersions = new Map();
    let validator: "node" | "python" = "node";
    const boundary = async () => {
      run.abort.signal.throwIfAborted();
      if (context.canWrite && !await context.canWrite(ownerId)) throw new Error("Repository permission revoked");
      if (run.pause) {
        await this.release(run);
        this.emit(run, { state: "paused" });
        while (run.pause) await delay(100, undefined, { signal: run.abort.signal });
        await this.acquire(run);
        this.emit(run, { state: "executing" });
      }
      run.abort.signal.throwIfAborted();
    };
    const runtime = (allowedWrites: string[], outputLimit = 48_000) => new BackendTools({ ws: context.ws, ownerId, runId,
      allowedWrites, outputLimit, observations, validator, files: context.files, boundary,
      changed: context.events.fileChanged, runTests: path => {
        phase = "verification";
        const i = run.view.steps.findIndex(step => step.tool === (path ? "run_targeted_tests" : "run_full_tests"));
        this.emit(run, { nodeIndex: i >= 0 ? i : run.view.nodeIndex });
        return this.options.runTests(ownerId, runId, path, validator);
      },
      progress: event => {
        const name = event.name === "read_files" ? "read_target_files" : event.name === "write_files" ? "edit_code" : event.name;
        const i = run.view.steps.findIndex(step => step.tool === name);
        this.emit(run, { nodeIndex: i >= 0 ? i : run.view.nodeIndex });
      } });
    try {
      const activeModel = this.options.model(ownerId, runId);
      model = activeModel;
      const scorer = this.options.router(ownerId, runId);
      planning: while (true) {
        await boundary();
        this.emit(run, { state: "planning" });
        phase = "discovery";
        const files = await runtime([]).listFiles();
        phase = "planning";
        providerAttempts++;
        const plan = await activeModel.plan(run.view.task, files, run.abort.signal);
        if (!plan.allowedWrites.length || plan.allowedWrites.length > 12 || plan.allowedWrites.some(p => !files.includes(p))
          || !files.includes(plan.visibleTestPath) || plan.allowedWrites.includes(plan.visibleTestPath)) throw new Error("Invalid plan");
        const language = languageForPlan(plan);
        validator = language ? "python" : "node";
        run.view.writeSet = [...new Set(plan.allowedWrites)];
        run.candidates = selectCandidateDags({ goalCapability: "verified_change", tools: prototypeTools });
        await this.acquire(run);
        while (true) {
          await boundary();
          this.emit(run, { state: "routing", candidates: undefined });
          const router: Router = { route: async input => {
            phase = "routing";
            await boundary();
            const decision: RouteDecision = run.choice
              ? { status: "selected", candidateId: run.choice, reasonCode: "owner_approved", routerMode: run.view.routerMode ?? undefined }
              : await scorer.route(input);
            run.choice = undefined;
            run.abort.signal.throwIfAborted();
            const selected = run.candidates.find(c => c.id === decision.candidateId);
            const mode = decision.routerMode;
            this.emit(run, { routerMode: mode && mode !== "oracle" ? mode : run.view.routerMode,
              confidence: decision.confidence, steps: selected ? steps(selected) : [], state: "executing" });
            phase = "evidence gathering";
            return decision;
          } };
          const result = await executeV8Dag({ trialRoot: context.ws.root,
            language,
            task: { id: runId, prompt: run.view.task, ...plan }, candidates: run.candidates, router, history: FROZEN_HISTORY,
            runtimeFactory: ({ allowedWrites, outputLimit }) => runtime(allowedWrites, outputLimit),
            synthesize: async input => { await boundary(); await runtime([]).assertFresh();
              phase = "synthesis";
              this.emit(run, { nodeIndex: run.view.steps.findIndex(step => step.tool === "edit_code") });
              providerAttempts++;
              executorModelCalls++;
              return activeModel.patch({ ...input, allowedWrites: plan.allowedWrites }, run.abort.signal); },
            fallbackAgent: async input => {
              await boundary(); this.emit(run, { codingRecovery: "warm_agent" });
              const tools = runtime(plan.allowedWrites);
              await tools.assertFresh();
              phase = "recovery";
              this.emit(run, { nodeIndex: run.view.steps.findIndex(step => step.tool === "edit_code") });
              providerAttempts++;
              executorModelCalls++;
              const patch = await activeModel.patch({ task: run.view.task, evidence: input.evidencePacket, allowedWrites: plan.allowedWrites }, run.abort.signal, true);
              await tools.writeFiles(patch.files);
              return { status: "patched", modelCalls: 1, usage: patch.usage };
            },
          });
          if (result.execution.status === "awaiting_approval") {
            phase = "approval";
            await this.release(run);
            const candidates = run.candidates.map(c => ({ id: c.id, score: result.route.probabilities?.[c.id] ?? 0, steps: steps(c) }))
              .sort((a, b) => b.score - a.score).slice(0, 3);
            this.emit(run, { state: "awaiting_approval", candidates });
            const until = Date.now() + 10 * 60_000;
            while (!run.choice && !run.hint) {
              if (Date.now() >= until) throw new Error("Approval expired");
              await delay(100, undefined, { signal: run.abort.signal });
            }
            if (run.hint) {
              if (run.rejected++ >= 1) throw new Error("Replanning budget exhausted");
              run.view.task += `\nOwner clarification: ${run.hint}`;
              run.hint = undefined; observations = new Map();
              continue planning;
            }
            await runtime([]).assertFresh();
            await this.acquire(run);
            continue;
          }
          if (!result.execution.status.startsWith("completed")) throw new Error("Verification failed");
          await this.release(run);
          this.emit(run, { state: "done", endedAt: Date.now() });
          return;
        }
      }
    } catch (error) {
      failed = failure(error, phase, run.abort.signal.aborted);
      this.emit(run, { state: "error", endedAt: Date.now(), error: { nodeIndex: run.view.nodeIndex,
        ...failed } });
    } finally {
      clearTimeout(timeout);
      try { await this.release(run); }
      catch { this.emit(run, { state: "error", error: { nodeIndex: run.view.nodeIndex, message: "Sandbox revocation failed; locks retained. Operator intervention required." } }); }
      const ledger = model?.receipts?.();
      this.options.receipt?.(runId, { status: run.view.state, modelCalls: ledger?.length ?? providerAttempts, modelAttempts: providerAttempts, executorModelCalls,
        modelReceipts: ledger,
        ...(failed ? { failureCode: failed.code, failurePhase: failed.phase } : {}),
        routerMode: run.view.routerMode, codingRecovery: run.view.codingRecovery, wallMs: Date.now() - run.view.startedAt });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) run.abort.abort();
    await Promise.all([...this.runs.values()].map(run => run.work));
  }
}
