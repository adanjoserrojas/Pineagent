/** The frozen runtime's internal contract. Backend wire contracts remain backend-owned. */
export interface ToolDefinition {
  name: string;
  description: string;
  routeLabel?: string;
  routeDescription?: string;
  requiredTools: string[];
  requires: string[];
  provides: string[];
  writes: string[];
  maxRepeats: number;
  timeoutMs: number;
}
export interface DagNode { name: string; description: string; writes: string[]; timeoutMs: number }
export interface DagCandidate {
  id: string; goalCapability: string; nodes: DagNode[]; edges: string[][];
  order: string[]; depth: number; discoveryTool?: string;
  routeLabel: string; routeDescription: string;
}
export interface HarnessTask {
  id?: string; prompt: string; allowedWrites: string[]; visibleTestPath: string;
}
export interface TokenUsage {
  inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
  chargedTokens?: number | null; chargedCredits?: number | null;
}
export type ProviderMode = "openai" | "jev";
export type RouterMode = ProviderMode | "oracle" | "cache" | "llm";
export interface RouteDecision {
  taskId?: string; candidateId: string | null; confidence?: number;
  probabilities?: Record<string, number | null>; probabilityMargin?: number | null;
  routerMode?: RouterMode; reasonCode?: string; status: "selected" | "awaiting_approval" | "error";
  routerCalls?: number; routerMs?: number; usage?: TokenUsage;
  providerTrace?: { mode: string; status: string; reason?: number | string }[];
  routeLabel?: string | null;
}
export interface RouteRequest {
  taskId?: string; task: string; candidates: DagCandidate[];
  oracleCandidateId?: string; historyPriors?: Record<string, number>;
}
export interface Router { route(input: RouteRequest): Promise<RouteDecision> }
export interface HttpResponse {
  ok: boolean; status?: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}
export type FetchLike = (url: string, options: RequestInit) => Promise<HttpResponse>;
export interface FileSnapshot { path: string; content: string }
export interface ToolEvent {
  name: string; status: "ok" | "error"; ms: number; input: Record<string, unknown>; error?: string;
}
export interface TestResult { exitCode: number | null; output: string }
/** Integration revision 1: transport seam only; the DAG policy is unchanged. */
export interface ToolRuntime {
  outputLimit: number;
  events: ToolEvent[];
  listFiles(): Promise<string[]>;
  searchCode(query: string | string[]): Promise<{ path: string; score: number }[]>;
  readText(path: string): Promise<string>;
  readFiles(paths: string[]): Promise<FileSnapshot[]>;
  writeFiles(files: FileSnapshot[]): Promise<string[]>;
  runTests(testPath?: string | null): Promise<TestResult>;
}
export type ToolRuntimeFactory = (options: { root: string; allowedWrites: string[]; outputLimit: number }) => ToolRuntime;
export interface Patch {
  files: FileSnapshot[]; usage?: TokenUsage; model?: string; wallMs?: number; summary?: string;
}
export type Synthesize = (input: { task: string; evidence: string }) => Promise<Patch>;
export interface RouteHistory {
  global?: Record<string, number>; byShape?: Record<string, Record<string, number>>;
  [metadata: string]: unknown;
}
export interface AgentResult {
  status?: string; modelCalls?: number; usage?: TokenUsage | null; wallMs?: number;
  [metadata: string]: unknown;
}
export type FallbackAgent = (input: { trialRoot: string; task: HarnessTask; evidencePacket: string }) => Promise<AgentResult>;
export interface ExpansionOption { route: string; utility: number }
export interface Checkpoint {
  sufficient: boolean; unresolved: string[]; next: ExpansionOption | null; paused?: boolean;
}
export interface RecoveryLimits { maxFiles: number; maxChars: number; maxMs: number }
export interface Recovery {
  sufficient: boolean; reasons: string[]; budgetReason: string | null; limits: RecoveryLimits;
  files: string[]; fileCount: number; chars: number; packet: string; wallMs: number; nodeEvents: ToolEvent[];
}
export interface WriteGate { routeApproved: boolean; evidenceSufficient: boolean; recoverySufficient: boolean | null }
export interface ExecutionResult {
  status: string; wallMs: number; modelCalls: number; changedPaths: string[];
  routeLabel?: string; executedRoutes?: string[]; checkpoints?: Checkpoint[];
  checkpointDecisions?: RouteDecision[]; evidenceChars?: number; evidenceFiles?: string[];
  repositoryFiles?: number; nodeEvents?: ToolEvent[]; pauseReason?: string;
  model?: { usage?: TokenUsage; wallMs?: number; model?: string };
  fallback?: AgentResult | null; injected?: unknown; initialVerification?: TestResult; fullTest?: TestResult | null;
  synthesisError?: { name: string; message: string };
  routingDecisions?: RouteDecision[]; recovery?: Recovery | null; writeGate?: WriteGate | null;
}
export interface DagExecutionOptions {
  runtimeFactory?: ToolRuntimeFactory;
  trialRoot: string; task: HarnessTask; candidate: DagCandidate; synthesize: Synthesize;
  fallbackAgent?: FallbackAgent | null; history?: RouteHistory; adaptive?: boolean;
  afterPatch?: ((input: { trialRoot: string; patch: Patch; evidence: string }) => Promise<unknown>) | null;
  chooseExpansion?: ((input: { task: HarnessTask; executedRoutes: string[]; unresolved: string[]; options: ExpansionOption[] }) => Promise<RouteDecision>) | null;
}
export interface V8ExecutionOptions {
  runtimeFactory?: ToolRuntimeFactory;
  trialRoot: string; task: HarnessTask & { id: string }; router: Router; candidates: DagCandidate[];
  history?: RouteHistory; synthesize: Synthesize; fallbackAgent?: FallbackAgent;
  limits?: RecoveryLimits; afterPatch?: DagExecutionOptions["afterPatch"];
}
