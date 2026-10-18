import type { HarnessTask, RecoveryLimits, Recovery, RouteDecision, WriteGate, V8ExecutionOptions, ExecutionResult, FileSnapshot, ToolRuntimeFactory } from "./types.js";
import path from "node:path";
import { SandboxToolRuntime } from "./sandbox-tools.js";
import { routeHistoryPriors } from "./adaptive-checkpoint.js";
import { executeV7Dag } from "./v7-executor.js";

// One recovery per run. These limits bound model context as well as local reads.
export const V8_RECOVERY_LIMITS = Object.freeze({ maxFiles: 12, maxChars: 24000, maxMs: 10000 });

function references(file: string, content: string, available: Set<string>): string[] {
  const found = [];
  const matcher = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*|new\s+URL\s*\(\s*)["'](\.[^"']+)["']/g;
  for (const match of content.matchAll(matcher)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const resolved = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`]
      .find(candidate => available.has(candidate));
    if (resolved) found.push(resolved);
  }
  return [...new Set(found)];
}

export async function collectV8Recovery({ trialRoot, task, limits = V8_RECOVERY_LIMITS, runtimeFactory }: { trialRoot: string; task: HarnessTask; limits?: RecoveryLimits; runtimeFactory?: ToolRuntimeFactory }): Promise<Recovery> {
  for (const name of ["maxFiles", "maxChars", "maxMs"] as const) {
    if (!Number.isInteger(limits[name]) || limits[name] < 1 || limits[name] > V8_RECOVERY_LIMITS[name]) {
      throw new Error(`Invalid recovery limit: ${name}`);
    }
  }
  const started = performance.now();
  const runtime = runtimeFactory?.({ root: trialRoot, allowedWrites: [], outputLimit: limits.maxChars })
    ?? new SandboxToolRuntime({ root: trialRoot, allowedWrites: [], outputLimit: limits.maxChars });
  const allFiles = await runtime.listFiles();
  const available = new Set(allFiles);
  const permitted = (file: string) => file === "package.json" || /^(src|test|tests)\/.+\.(?:[cm]?js|ts|tsx|json)$/.test(file);
  const symbols = [...task.prompt.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1].toLowerCase());
  const named = allFiles.filter(file => file.startsWith("src/") && symbols.includes(path.posix.parse(file).name.toLowerCase()));
  const queue = [...new Set([task.visibleTestPath, ...named, "package.json"].filter(Boolean))]
    .map(file => ({ file, depth: file.startsWith("src/") ? 1 : 0 }));
  const files: FileSnapshot[] = [], complete = new Set<string>(), testImports = new Set<string>();
  let chars = 0, budgetReason: string | null = null;
  while (queue.length) {
    if (performance.now() - started >= limits.maxMs) { budgetReason = "time_limit"; break; }
    if (files.length >= limits.maxFiles) { budgetReason = "file_limit"; break; }
    if (chars >= limits.maxChars) { budgetReason = "text_limit"; break; }
    const { file, depth } = queue.shift()!;
    if (files.some(entry => entry.path === file) || !available.has(file) || !permitted(file)) continue;
    const overhead = `FILE ${file}\n`.length + (files.length ? 2 : 0);
    runtime.outputLimit = limits.maxChars - chars - overhead;
    if (runtime.outputLimit < 1) { budgetReason = "text_limit"; break; }
    const [entry] = await runtime.readFiles([file]);
    if (!entry) continue;
    chars += entry.content.length + overhead;
    files.push(entry);
    // readFiles truncates at outputLimit; equality is conservatively incomplete.
    if (entry.content.length < runtime.outputLimit) complete.add(file);
    const deps = references(file, entry.content, available).filter(permitted);
    if (file === task.visibleTestPath) deps.filter(dep => dep.startsWith("src/")).forEach(dep => testImports.add(dep));
    if (depth < 2) queue.unshift(...deps
      .filter(dep => !files.some(read => read.path === dep) && !queue.some(pending => pending.file === dep))
      .map(file => ({ file, depth: depth + 1 })));
  }
  if (performance.now() - started >= limits.maxMs) budgetReason = "time_limit";
  const reasons = [];
  if (!complete.has(task.visibleTestPath)) reasons.push("visible_test_not_fully_read");
  if (!files.some(file => file.path.startsWith("src/") && complete.has(file.path))) reasons.push("no_complete_source");
  if ([...testImports].some(file => !complete.has(file))) reasons.push("test_entrypoint_not_fully_read");
  if (budgetReason || files.some(file => !complete.has(file.path))) reasons.push("recovery_budget_exhausted");
  const packet = files.map(file => `FILE ${file.path}\n${file.content}`).join("\n\n");
  return { sufficient: reasons.length === 0, reasons, budgetReason, limits: { ...limits },
    files: files.map(file => file.path), fileCount: files.length, chars, packet,
    wallMs: Math.round(performance.now() - started), nodeEvents: runtime.events };
}

// The router itself and its frozen gate are unchanged. An uncertain choice only
// authorizes reads; neither synthesis nor a writing fallback is reachable yet.
export async function executeV8Dag({ trialRoot, task, router, candidates, history, synthesize, fallbackAgent,
  limits = V8_RECOVERY_LIMITS, afterPatch = null, runtimeFactory }: V8ExecutionOptions): Promise<{ route: RouteDecision; execution: ExecutionResult }> {
  const started = performance.now();
  const routingDecisions: RouteDecision[] = [];
  const priors = routeHistoryPriors(history, task.prompt);
  let route = await router.route({ taskId: task.id, task: task.prompt, candidates, historyPriors: priors });
  routingDecisions.push(route);
  let recovery: Recovery | null = null, writeGate: WriteGate | null = null;
  const pause = (reason: string): { route: RouteDecision; execution: ExecutionResult } => ({ route, execution: { status: "awaiting_approval", pauseReason: reason,
    routingDecisions, recovery, writeGate, changedPaths: [], modelCalls: 0,
    wallMs: Math.round(performance.now() - started), nodeEvents: recovery?.nodeEvents ?? [] } });
  if (route.status === "awaiting_approval") {
    recovery = await collectV8Recovery({ trialRoot, task, limits, runtimeFactory });
    if (!recovery.sufficient) return pause("recovery_evidence_insufficient");
    route = await router.route({ taskId: `${task.id}:read-only-reassessment`,
      task: `${task.prompt}\nOne bounded read-only discovery pass has completed. Select the best DAG using the observed evidence below. An ambiguous answer will still pause before any write.\n${recovery.packet}`,
      candidates, historyPriors: priors });
    routingDecisions.push(route);
  }
  if (route.status !== "selected") return pause(route.status === "awaiting_approval" ? "reassessment_below_gate" : "router_unavailable");
  const candidate = candidates.find(item => item.id === route.candidateId);
  if (!candidate) throw new Error("V8 router selected an unknown candidate");
  const gateError = new Error("V8 evidence requires approval before synthesis");
  let execution: ExecutionResult;
  try {
    execution = await executeV7Dag({ trialRoot, task, candidate, history, afterPatch, runtimeFactory,
      fallbackAgent: fallbackAgent ? input => fallbackAgent({ ...input, evidencePacket: recovery
        ? `${input.evidencePacket}\n\nBOUNDED READ-ONLY RECOVERY\n${recovery.packet}` : input.evidencePacket }) : null,
      synthesize: async input => {
        // Avoid paying twice for files already collected by the selected DAG.
        const extra = recovery?.packet.split(/\n\n(?=FILE )/)
          .filter(section => !input.evidence.includes(`${section.split("\n")[0]}\n`)).join("\n\n");
        const evidence = recovery ? `${input.evidence}\n\nBOUNDED READ-ONLY RECOVERY\n${extra}` : input.evidence;
        const hasSource = /^FILE src\/[^\n]+\n[^\n]/m.test(evidence);
        const hasTest = evidence.includes(`FILE ${task.visibleTestPath}\n`);
        writeGate = { routeApproved: route.status === "selected", evidenceSufficient: hasSource && hasTest,
          recoverySufficient: recovery?.sufficient ?? null };
        if (!writeGate.routeApproved || !writeGate.evidenceSufficient || recovery?.sufficient === false) throw gateError;
        return synthesize({ ...input, evidence });
      } });
  } catch (error) {
    if (error !== gateError) throw error;
    return pause("write_evidence_insufficient");
  }
  return { route, execution: { ...execution, routingDecisions, recovery, writeGate,
    wallMs: Math.round(performance.now() - started) } };
}
