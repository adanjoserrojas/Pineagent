import type { DagCandidate, FetchLike, ProviderMode, RouteDecision, RouteRequest, TokenUsage } from "./types.js";
type RouterFailure = Error & { status?: number; retryAfter?: string | null };
type Probabilities = Record<string, number> | { value: string; probability: number }[];
interface Answer { type?: string; name?: string; choice?: string; confidence?: number; probabilities?: Probabilities }
interface DecisionsResponse { answers?: Answer[]; usage?: { input_tokens?: number; output_tokens?: number } }
interface JevResponse { answers?: { route?: Answer }; latency_ms?: number; usage?: { input_tokens?: number; output_tokens?: number; charged_tokens?: number; charged_credits?: number } }
export interface RouterOptions {
  mode: ProviderMode | "oracle"; apiKey?: string; fetchImpl?: FetchLike; timeoutMs?: number;
  retryCount?: number; threshold?: number; minMargin?: number; cacheTtlMs?: number;
  breakerFailures?: number; breakerOpenMs?: number; maxCalls?: number;
  secondaryProvider?: { mode: ProviderMode; apiKey: string; timeoutMs?: number } | null;
  fallback?: (input: RouteRequest) => Promise<string>; now?: () => number;
}
interface ProviderChoice {
  providerMode: ProviderMode; candidateId: string; confidence: number;
  probabilities: Record<string, number | null>; probabilityMargin: number | null;
  routerMs: number; usage: TokenUsage;
}

import { stableId } from "./canonical.js";

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MIN_MARGIN = 0.1;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function candidateDescription(candidate: DagCandidate, historyPrior?: number): string {
  return [
    candidate.routeDescription,
    `Evidence path: ${candidate.order.join(" -> ")}.`,
    Number.isFinite(historyPrior) ? `Observed success prior for similar completed tasks: ${(historyPrior! * 100).toFixed(1)}%.` : "",
    "Select this only when it is the least-cost route expected to gather enough evidence for a correct change.",
  ].filter(Boolean).join(" ");
}

function isAvailabilityError(error?: RouterFailure): boolean {
  if ([402, 408, 409, 425, 429].includes(error?.status as number)) return true;
  if (Number(error?.status) >= 500) return true;
  return ["AbortError", "TimeoutError", "TypeError"].includes(error?.name as string);
}

function normalizeProbabilities(probabilities: Probabilities | undefined, labels: Record<string, DagCandidate>): Record<string, number | null> {
  const vector: Record<string, number | null> = Object.fromEntries(Object.keys(labels).map((label) => [label, null]));
  const entries = Array.isArray(probabilities)
    ? probabilities
    : Object.entries(probabilities ?? {}).map(([value, probability]) => ({ value, probability }));
  for (const item of entries) {
    if (typeof item?.value === "string" && Object.hasOwn(labels, item.value)) {
      const probability = Number(item.probability);
      vector[item.value] = Number.isFinite(probability) ? probability : null;
    }
  }
  return vector;
}

function probabilityMargin(vector: Record<string, number | null>): number | null {
  const values = Object.values(vector).filter((value): value is number => Number.isFinite(value)).sort((a, b) => b - a);
  return values.length >= 2 ? values[0] - values[1] : null;
}

async function postJson<T>(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number, fetchImpl: FetchLike): Promise<{ json: T; clientMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Router HTTP ${response.status}: ${text.slice(0, 400)}`) as RouterFailure;
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      throw error;
    }
    return { json: JSON.parse(text) as T, clientMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export class MasterTool1Router {
  mode: RouterOptions["mode"];
  apiKey: string | undefined;
  fetchImpl: FetchLike;
  timeoutMs: number; retryCount: number; threshold: number; minMargin: number;
  cacheTtlMs: number; breakerFailures: number; breakerOpenMs: number; maxCalls: number;
  secondaryProvider: RouterOptions["secondaryProvider"]; fallback: RouterOptions["fallback"];
  now: () => number; cache: Map<string, { value: RouteDecision; expiresAt: number }>;
  consecutiveFailures: number; openedAt: number | null; calls: number;
  constructor({
    mode,
    apiKey,
    fetchImpl = fetch,
    timeoutMs = 3_000,
    retryCount = 1,
    threshold = DEFAULT_THRESHOLD,
    minMargin = DEFAULT_MIN_MARGIN,
    cacheTtlMs = 3_600_000,
    breakerFailures = 3,
    breakerOpenMs = 60_000,
    maxCalls = 100,
    secondaryProvider = null,
    fallback,
    now = () => Date.now(),
  }: RouterOptions) {
    this.mode = mode;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retryCount = retryCount;
    this.threshold = threshold;
    this.minMargin = minMargin;
    this.cacheTtlMs = cacheTtlMs;
    this.breakerFailures = breakerFailures;
    this.breakerOpenMs = breakerOpenMs;
    this.maxCalls = maxCalls;
    this.secondaryProvider = secondaryProvider;
    this.fallback = fallback;
    this.now = now;
    this.cache = new Map();
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.calls = 0;
  }

  get breakerState() {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.breakerOpenMs ? "half_open" : "open";
  }

  async route({ taskId, task, candidates, oracleCandidateId, historyPriors = {} }: RouteRequest): Promise<RouteDecision> {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("Master-1 requires at least one candidate");
    }
    if (this.mode === "oracle") {
      const candidate = candidates.find((item) => item.id === oracleCandidateId);
      if (!candidate) throw new Error(`Oracle candidate missing for ${taskId}`);
      return {
        taskId,
        candidateId: candidate.id,
        confidence: 1,
        routerMode: "oracle",
        reasonCode: "fixture-gold",
        status: "selected",
        routerCalls: 0,
        routerMs: 0,
      };
    }

    const cacheKey = stableId({ mode: this.mode, secondaryMode: this.secondaryProvider?.mode, task, historyPriors, candidates: candidates.map((c) => c.id) });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return { ...cached.value, routerMode: "cache", reasonCode: `${this.mode}-cache-hit`, routerCalls: 0 };
    }

    if (this.breakerState === "open") return this.useFallback({ taskId, task, candidates }, "breaker-open");
    if (!this.apiKey) return this.useFallback({ taskId, task, candidates }, "missing-key");

    let lastError: RouterFailure | undefined;
    const callsBefore = this.calls;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      if (this.calls >= this.maxCalls) return this.useFallback({ taskId, task, candidates }, "call-budget-exhausted");
      this.calls += 1;
      try {
        const result = await this.callProvider({ mode: this.mode, apiKey: this.apiKey, task, candidates, historyPriors });
        this.consecutiveFailures = 0;
        this.openedAt = null;
        const value: RouteDecision = {
          taskId,
          candidateId: result.candidateId,
          confidence: result.confidence,
          probabilities: result.probabilities,
          probabilityMargin: result.probabilityMargin,
          routerMode: result.providerMode,
          reasonCode: "provider-choice",
          status: result.confidence >= this.threshold
            && Number.isFinite(result.probabilityMargin)
            && result.probabilityMargin! >= this.minMargin
            ? "selected"
            : "awaiting_approval",
          routerCalls: this.calls - callsBefore,
          routerMs: result.routerMs,
          usage: result.usage,
          providerTrace: [{ mode: result.providerMode, status: "selected" }],
        };
        this.cache.set(cacheKey, { value, expiresAt: this.now() + this.cacheTtlMs });
        return value;
      } catch (caught) {
        const error = caught as RouterFailure;
        lastError = error;
        if (attempt < this.retryCount) {
          const retryAfterMs = Number(error.retryAfter) * 1_000;
          await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 100 + Math.floor(Math.random() * 150));
        }
      }
    }

    if (this.secondaryProvider && isAvailabilityError(lastError) && this.calls < this.maxCalls) {
      this.calls += 1;
      try {
        const result = await this.callProvider({
          mode: this.secondaryProvider.mode,
          apiKey: this.secondaryProvider.apiKey,
          timeoutMs: this.secondaryProvider.timeoutMs ?? this.timeoutMs,
          task,
          candidates,
          historyPriors,
        });
        this.consecutiveFailures = 0;
        this.openedAt = null;
        const value: RouteDecision = {
          taskId,
          candidateId: result.candidateId,
          confidence: result.confidence,
          probabilities: result.probabilities,
          probabilityMargin: result.probabilityMargin,
          routerMode: result.providerMode,
          reasonCode: `provider-fallback:${this.mode}->${result.providerMode}`,
          status: result.confidence >= this.threshold
            && Number.isFinite(result.probabilityMargin)
            && result.probabilityMargin! >= this.minMargin
            ? "selected"
            : "awaiting_approval",
          routerCalls: this.calls - callsBefore,
          routerMs: result.routerMs,
          usage: result.usage,
          providerTrace: [
            { mode: this.mode, status: "failed", reason: lastError?.status ?? lastError?.name ?? "Error" },
            { mode: result.providerMode, status: "selected" },
          ],
        };
        this.cache.set(cacheKey, { value, expiresAt: this.now() + this.cacheTtlMs });
        return value;
      } catch (caught) {
        const error = caught as RouterFailure;
        lastError = error;
      }
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breakerFailures) this.openedAt = this.now();
    return this.useFallback(
      { taskId, task, candidates },
      `provider-failed:${lastError?.name ?? "Error"}`,
    );
  }

  async callProvider({ mode = this.mode, apiKey = this.apiKey, timeoutMs = this.timeoutMs, task, candidates, historyPriors = {} }: { mode?: RouterOptions['mode']; apiKey?: string; timeoutMs?: number; task: string; candidates: DagCandidate[]; historyPriors?: Record<string, number> }): Promise<ProviderChoice> {
    const labels = Object.fromEntries(candidates.map((candidate) => [candidate.routeLabel, candidate]));
    const taskState = [
      `Coding task: ${task}`,
      "Choose the route that should solve the task correctly with the least unnecessary inspection.",
      "A route is sufficient only if its evidence is expected to support a correct patch. Prefer lower-cost evidence only when accuracy is preserved.",
      ...Object.entries(labels).map(([label, candidate]) => `${label}: ${candidateDescription(candidate, historyPriors[label])}`),
    ].join("\n");

    if (mode === "jev") {
      const criteria = Object.fromEntries(
        Object.entries(labels).map(([label, candidate]) => [label, candidateDescription(candidate, historyPriors[label]).slice(0, 400)]),
      );
      const response = await postJson<JevResponse>(
        "https://jev-ai.org/api/v1/systemone/",
        {
          model: "jev-1.13",
          state: taskState,
          questions: {
            route: {
              type: "choice",
              instructions: "Select the best route for this coding task.",
              criteria,
            },
          },
        },
        apiKey,
        timeoutMs,
        this.fetchImpl,
      );
      const answer = response.json.answers?.route;
      const candidate = labels[answer?.choice as string];
      if (!candidate) throw new Error("Jev returned an unknown route");
      const probabilities = normalizeProbabilities(answer?.probabilities, labels);
      return {
        providerMode: mode,
        candidateId: candidate.id,
        confidence: Number(answer!.confidence ?? 0),
        probabilities,
        probabilityMargin: probabilityMargin(probabilities),
        routerMs: Number(response.json.latency_ms ?? response.clientMs),
        usage: {
          inputTokens: response.json.usage?.input_tokens ?? null,
          outputTokens: response.json.usage?.output_tokens ?? null,
          chargedTokens: response.json.usage?.charged_tokens ?? null,
          chargedCredits: response.json.usage?.charged_credits ?? null,
        },
      };
    }

    if (mode === "openai") {
      const choices = Object.entries(labels).map(([label, candidate]) => ({
        value: label,
        description: candidateDescription(candidate, historyPriors[label]),
      }));
      const response = await postJson<DecisionsResponse>(
        "https://api.openai.com/v1/decisions",
        {
          model: "gpt-6-luna",
          input: taskState,
          questions: [
            {
              type: "choice",
              name: "route",
              instructions: "Select the best route for this coding task.",
              choices,
            },
          ],
        },
        apiKey,
        timeoutMs,
        this.fetchImpl,
      );
      const answer = response.json.answers?.find((item) => item.name === "route") ?? response.json.answers?.[0];
      const candidate = labels[answer?.choice as string];
      if (!candidate) throw new Error("OpenAI Decisions returned an unknown route");
      if (answer?.type === "refusal") throw new Error("OpenAI Decisions refused route selection");
      const probabilities = normalizeProbabilities(answer?.probabilities, labels);
      return {
        providerMode: mode,
        candidateId: candidate.id,
        confidence: Number(answer!.confidence ?? 0),
        probabilities,
        probabilityMargin: probabilityMargin(probabilities),
        routerMs: response.clientMs,
        usage: {
          inputTokens: response.json.usage?.input_tokens ?? null,
          outputTokens: response.json.usage?.output_tokens ?? null,
        },
      };
    }

    throw new Error(`Unsupported router mode: ${mode}`);
  }

  async useFallback(input: RouteRequest, reasonCode: string): Promise<RouteDecision> {
    if (!this.fallback) {
      return {
        taskId: input.taskId,
        candidateId: null,
        confidence: 0,
        routerMode: "llm",
        reasonCode,
        status: "error",
        routerCalls: 0,
        routerMs: 0,
      };
    }
    const started = performance.now();
    const candidateId = await this.fallback(input);
    if (!input.candidates.some((candidate) => candidate.id === candidateId)) {
      throw new Error("Fallback returned an unknown candidate");
    }
    return {
      taskId: input.taskId,
      candidateId,
      confidence: 1,
      routerMode: "llm",
      reasonCode,
      status: "selected",
      routerCalls: 0,
      routerMs: Math.round(performance.now() - started),
    };
  }
}
