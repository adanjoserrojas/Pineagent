import type { FileSnapshot, HarnessTask, RouteHistory } from "./types.js";
import path from "node:path";

const ROUTE_COST: Record<string, number> = {
  targeted_symbol_search: 1,
  failure_first_diagnosis: 2,
  repository_flow_mapping: 3,
};

export function classifyTaskShape(prompt: string): string {
  const text = String(prompt).toLowerCase();
  if (/failing test|visible test|assertion|reproduced by|demonstrated by|boundary specification/.test(text)) {
    return "failure_driven";
  }
  if (/across\s+[^.]{0,80}\s+and\s+|configuration|startup|cross-file|adapter|pipeline|end-to-end|expose\s+.*\{\s*value\s*\}/.test(text)) {
    return "cross_file_flow";
  }
  return "named_behavior";
}

function unresolvedRelativeImports(files: FileSnapshot[], allFiles: string[]): string[] {
  const read = new Set(files.map((file) => file.path));
  const available = new Set(allFiles);
  const unresolved = [];
  for (const file of files) {
    const matcher = /from\s+["'](\.[^"']+)["']/g;
    for (const match of file.content.matchAll(matcher)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
      const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, path.posix.join(base, "index.mjs")];
      const target = candidates.find((candidate) => available.has(candidate));
      if (target && !read.has(target)) unresolved.push(target);
    }
  }
  return [...new Set(unresolved)].sort();
}

export function evaluateEvidenceCheckpoint({ task, executedRoutes, evidenceFiles, ranked, allFiles }: { task: HarnessTask; executedRoutes: string[]; evidenceFiles: FileSnapshot[]; ranked?: { path: string; score: number }[]; allFiles: string[] }) {
  const shape = classifyTaskShape(task.prompt);
  const reasons = [];
  const proposals: { routeLabel: string; expectedGain: number }[] = [];
  const sourceFiles = evidenceFiles.filter((file) => file.path.startsWith("src/"));
  const unresolvedImports = unresolvedRelativeImports(sourceFiles, allFiles);

  if (shape === "failure_driven" && !executedRoutes.includes("failure_first_diagnosis")) {
    reasons.push("authoritative_failure_not_observed");
    proposals.push({ routeLabel: "failure_first_diagnosis", expectedGain: 0.55 });
  }
  if (shape === "cross_file_flow" && !executedRoutes.includes("repository_flow_mapping")) {
    reasons.push("cross_file_ownership_not_mapped");
    proposals.push({ routeLabel: "repository_flow_mapping", expectedGain: 0.7 });
  }
  if (unresolvedImports.length && !executedRoutes.includes("repository_flow_mapping")) {
    reasons.push("referenced_source_not_read");
    proposals.push({ routeLabel: "repository_flow_mapping", expectedGain: 0.45 });
  }
  if (sourceFiles.length === 0) {
    reasons.push("no_source_evidence");
    proposals.push({ routeLabel: "repository_flow_mapping", expectedGain: 0.8 });
  }

  const scored = proposals
    .filter((proposal) => !executedRoutes.includes(proposal.routeLabel))
    .map((proposal) => ({
      ...proposal,
      incrementalCost: ROUTE_COST[proposal.routeLabel],
      utility: proposal.expectedGain / ROUTE_COST[proposal.routeLabel],
    }))
    .sort((left, right) => right.utility - left.utility || left.routeLabel.localeCompare(right.routeLabel));

  return {
    shape,
    sufficient: reasons.length === 0,
    reasons,
    unresolvedImports,
    nextExpansion: scored[0] ?? null,
    proposals: scored,
  };
}

export function routeHistoryPriors(history: RouteHistory | undefined, prompt: string): Record<string, number> {
  const shape = classifyTaskShape(prompt);
  const fallback = history?.global ?? {};
  const matching = history?.byShape?.[shape] ?? {};
  return Object.fromEntries(Object.keys(ROUTE_COST).map((routeLabel) => [
    routeLabel,
    Number(matching[routeLabel] ?? fallback[routeLabel] ?? 0.5),
  ]));
}
