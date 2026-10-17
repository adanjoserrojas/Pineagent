import type { DagExecutionOptions, ExecutionResult, Checkpoint, RouteDecision, ExpansionOption, FileSnapshot, Patch, AgentResult, TestResult } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { SandboxToolRuntime } from "./sandbox-tools.js";
import { classifyTaskShape, routeHistoryPriors } from "./adaptive-checkpoint.js";

function importsOf(file: string, content: string, available: Set<string>): string[] {
  const found = [];
  for (const match of content.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const target = [base, `${base}.mjs`, `${base}.js`, path.posix.join(base, "index.mjs")].find(p => available.has(p));
    if (target) found.push(target);
  }
  return found;
}

export async function executeV7Dag({ trialRoot, task, candidate, synthesize, fallbackAgent, history, adaptive = true, afterPatch = null, chooseExpansion = null }: DagExecutionOptions): Promise<ExecutionResult> {
  const started = performance.now();
  const runtime = new SandboxToolRuntime({ root: trialRoot, allowedWrites: task.allowedWrites, outputLimit: 48000 });
  const allFiles = await runtime.listFiles(), available = new Set(allFiles);
  const ranked = await runtime.searchCode(task.prompt);
  const graph = new Map<string, string[]>();
  const contents = new Map<string, string>();
  for (const file of allFiles.filter(f => /\.[cm]?js$/.test(f))) {
    const content = await fs.readFile(path.join(trialRoot, file), "utf8");
    contents.set(file, content);
    graph.set(file, importsOf(file, content, available));
  }
  const explicitSymbols = [...new Set([...task.prompt.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
  const symbolHits = [...contents].filter(([file]) => file.startsWith("src/"))
    .map(([file, content]) => ({ path:file, score:explicitSymbols.filter(symbol => content.includes(symbol)).length }))
    .filter(hit => hit.score > 0).sort((a,b) => b.score-a.score || a.path.localeCompare(b.path));
  const routes: string[] = [], checkpoints: Checkpoint[] = [], checkpointDecisions: RouteDecision[] = [], files = new Map<string, string>();
  const discoveries: { route: string; exitCode: number | null; output: string }[] = [];
  let modelCalls = 0, patch: Patch | null = null, fallback: AgentResult | null = null, fullTest: TestResult | null = null;
  const priors = routeHistoryPriors(history, task.prompt);
  async function collect(label: string): Promise<void> {
    routes.push(label);
    let seeds = (symbolHits.length ? symbolHits : ranked.filter(r => r.path.startsWith("src/"))).slice(0, label === "targeted_symbol_search" ? 2 : 5).map(r => r.path);
    if (label !== "targeted_symbol_search") seeds = [task.visibleTestPath, ...seeds];
    if (label === "failure_first_diagnosis") {
      const failing = await runtime.runTests(task.visibleTestPath);
      discoveries.push({ route: label, exitCode: failing.exitCode, output: failing.output.slice(-3500) });
    }
    if (label === "repository_flow_mapping") {
      // Dependency closure starts at the public test entrypoint. Then include callers
      // of the relevant sources, bounded independently of repository file count.
      const wanted = new Set([task.visibleTestPath, ...symbolHits.slice(0, 5).map(hit => hit.path)].filter(Boolean));
      for (let pass = 0; pass < 12 && wanted.size < 40; pass += 1) {
        const before = wanted.size;
        for (const file of [...wanted]) for (const target of graph.get(file) ?? []) if (wanted.size < 40) wanted.add(target);
        if (before === wanted.size) break;
      }
      for (const [file, deps] of graph) if (wanted.size < 40 && deps.some(d => wanted.has(d))) wanted.add(file);
      seeds = [...wanted];
    }
    const ordered = [...new Set([task.visibleTestPath, ...seeds, "package.json"])].filter(Boolean);
    // readFiles caps each batch at 12. Explicit batches preserve the 40-file bound.
    for (let i = 0; i < Math.min(ordered.length, 40); i += 12) {
      for (const file of await runtime.readFiles(ordered.slice(i, i + 12))) files.set(file.path, file.content);
    }
  }
  await collect(candidate.routeLabel);
  if (adaptive) {
    for (let index = 0; index < 2; index += 1) {
      const unresolved = [...new Set([...files].flatMap(([file, content]) => importsOf(file, content, available)).filter(f => !files.has(f)))];
      const crossFile = classifyTaskShape(task.prompt) === "cross_file_flow";
      const sufficient = unresolved.length === 0 && (!crossFile || routes.includes("repository_flow_mapping"));
      const options = ["repository_flow_mapping", "failure_first_diagnosis"].filter(r => !routes.includes(r))
        .map(route => ({ route, utility: ((priors[route] ?? 0.5) + (route === "repository_flow_mapping" && unresolved.length ? 0.5 : 0)) / (route === "repository_flow_mapping" ? 3 : 2) }))
        .sort((a,b) => b.utility - a.utility);
      let next: ExpansionOption | undefined = crossFile || unresolved.length ? options.find(p => p.route === "repository_flow_mapping") ?? options[0] : options[0];
      if (!sufficient && chooseExpansion && options.length > 1) {
        const decision = await chooseExpansion({ task, executedRoutes: [...routes], unresolved, options });
        checkpointDecisions.push(decision);
        if (decision.status !== "selected") {
          checkpoints.push({ sufficient, unresolved, next: null, paused: true });
          return { status: "awaiting_approval", wallMs: Math.round(performance.now() - started), modelCalls,
            routeLabel: candidate.routeLabel, executedRoutes: routes, checkpoints, checkpointDecisions,
            evidenceFiles: [...files.keys()], changedPaths: [], nodeEvents: runtime.events };
        }
        next = options.find(option => option.route === decision.routeLabel);
        if (!next) throw new Error("Checkpoint router selected an unavailable route");
      }
      checkpoints.push({ sufficient, unresolved, next: next ?? null });
      if (sufficient || !next) break;
      await collect(next.route);
    }
  }
  const evidence = [
    `Repository: ${allFiles.length} files. Exact-symbol candidates: ${JSON.stringify(symbolHits.slice(0, 8))}`,
    `Executed routes: ${routes.join(", ")}. Checkpoints: ${JSON.stringify(checkpoints)}`,
    ...discoveries.map(d => JSON.stringify(d)),
    ...[...files].map(([file, content]) => `FILE ${file}\n${content}`),
    "Cross-file change contract: trace imports and callers, preserve exports, validate at the correct layer, and propagate the value to every public consumer. Implement all task requirements, including edge cases.",
  ].join("\n\n");
  modelCalls += 1;
  try {
    patch = await synthesize({ task: task.prompt, evidence });
    await runtime.writeFiles(patch.files);
  } catch (error) {
    const recoverable = /Patch contained no files|Patch response did not contain output text|Unexpected token.*JSON/i.test(String((error as Error).message));
    if (!recoverable || !fallbackAgent) throw error;
    const packet = [evidence, `Patch synthesis produced no applicable change: ${(error as Error).message}. Continue from the unchanged working tree.`].join("\n\n");
    fallback = await fallbackAgent({ trialRoot, task, evidencePacket: packet });
    modelCalls += Number(fallback.modelCalls ?? 0);
    fullTest = await runtime.runTests();
    return { status: fullTest.exitCode === 0 ? "completed_via_fallback" : "tests_failed",
      wallMs: Math.round(performance.now() - started), modelCalls, routeLabel: candidate.routeLabel,
      executedRoutes: routes, checkpoints, checkpointDecisions, evidenceChars: evidence.length,
      evidenceFiles: [...files.keys()], repositoryFiles: allFiles.length,
      synthesisError: { name: (error as Error).name, message: (error as Error).message }, fallback, fullTest,
      changedPaths: [], nodeEvents: runtime.events };
  }
  let injected = null;
  if (afterPatch) injected = await afterPatch({ trialRoot, patch, evidence });
  fullTest = await runtime.runTests();
  const initialVerification = fullTest;
  if (fullTest.exitCode !== 0 && fallbackAgent) {
    const current = [];
    for (const changed of patch.files) current.push(`CURRENT FILE ${changed.path}\n${await fs.readFile(path.join(trialRoot, changed.path), "utf8")}`);
    const packet = ["The earlier FILE sections are pre-patch snapshots. Current changed files follow. Continue from the current working tree.", evidence,
      ...current, `Visible verification failed:\n${fullTest.output.slice(-5000)}`].join("\n\n");
    fallback = await fallbackAgent({ trialRoot, task, evidencePacket: packet });
    modelCalls += Number(fallback.modelCalls ?? 0);
    fullTest = await runtime.runTests();
  }
  return { status: fullTest.exitCode === 0 ? fallback ? "completed_via_fallback" : "completed" : "tests_failed",
    wallMs: Math.round(performance.now() - started), modelCalls, routeLabel: candidate.routeLabel, executedRoutes: routes, checkpoints, checkpointDecisions,
    evidenceChars: evidence.length, evidenceFiles: [...files.keys()], repositoryFiles: allFiles.length,
    model: { usage: patch.usage, wallMs: patch.wallMs, model: patch.model },
    fallback, injected, initialVerification, fullTest, changedPaths: patch.files.map(f => f.path), nodeEvents: runtime.events };
}
