import type { FetchLike, RouteHistory, Synthesize } from "./types.js";
import { MasterTool1Router } from "./master-tool-1.js";
import { synthesizePatch } from "./openai-response-client.js";

export const FROZEN_GATE = Object.freeze({ confidenceThreshold: 0, minMargin: 0.3 });
export const FROZEN_CODING = Object.freeze({ model: "gpt-6-sol", effort: "medium" });
/** V4 priors frozen before V8. Never update from evaluation or active runs. */
export const FROZEN_HISTORY: Readonly<RouteHistory> = Object.freeze({
  global: { repository_flow_mapping: 0.95, failure_first_diagnosis: 0.9, targeted_symbol_search: 0.45 },
  byShape: {
    named_behavior: { repository_flow_mapping: 0.875, failure_first_diagnosis: 0.875, targeted_symbol_search: 0.875 },
    failure_driven: { repository_flow_mapping: 0.875, failure_first_diagnosis: 0.875, targeted_symbol_search: 0.125 },
    cross_file_flow: { failure_first_diagnosis: 0.75, repository_flow_mapping: 0.875, targeted_symbol_search: 0.375 },
  },
});

/** Backend injects credentials and metered fetch. Construct one router per run. */
export function createFrozenRouter(options: { decisionsApiKey: string; jevApiKey?: string; fetchImpl?: FetchLike }): MasterTool1Router {
  return new MasterTool1Router({
    mode: "openai", apiKey: options.decisionsApiKey, fetchImpl: options.fetchImpl,
    threshold: FROZEN_GATE.confidenceThreshold, minMargin: FROZEN_GATE.minMargin,
    cacheTtlMs: 0, maxCalls: 8,
    secondaryProvider: options.jevApiKey ? { mode: "jev", apiKey: options.jevApiKey, timeoutMs: 10000 } : null,
  });
}

/** Matches the V8 container worker; the generic client retains historical defaults. */
export function createFrozenSynthesize(options: { apiKey: string; fetchImpl?: FetchLike }): Synthesize {
  return input => synthesizePatch({ ...input, ...FROZEN_CODING, apiKey: options.apiKey,
    fetchImpl: options.fetchImpl, changeContract: true, maxOutputTokens: 8192, responsePhasePolicy: "final-answer" });
}
