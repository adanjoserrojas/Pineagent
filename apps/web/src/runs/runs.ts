import type { RunEvent, RunState, RunView } from "../contracts/socket";
import type { ConnectionStatus } from "../state/workspace";

// Pure run-panel logic, shared by the store and the plant (docs/contracts/RUN_EVENTS.md).

// Keeps a run only if the event is newer than what we have; returns null when it is old news.
export function applyRunEvent(runs: ReadonlyMap<string, RunView>, e: RunEvent): Map<string, RunView> | null {
  const current = runs.get(e.runId);
  if (current && e.seq <= current.seq) return null;
  return new Map(runs).set(e.runId, e.run);
}

// Merges a run:list answer, never replacing a newer snapshot we already hold.
export function mergeRuns(runs: ReadonlyMap<string, RunView>, list: RunView[]): Map<string, RunView> {
  const next = new Map(runs);
  for (const r of list) if ((next.get(r.runId)?.seq ?? 0) < r.seq) next.set(r.runId, r);
  return next;
}

// LLD 9: the plant shows the owner's highest-priority run.
const PRIORITY: RunState[] = ["error", "awaiting_approval", "blocked", "paused", "executing", "routing", "planning", "done"];

export type FaceKey =
  | "idle" | "planning" | "routing" | "routing_cache" | "routing_llm" | "executing" | "awaiting_approval" | "blocked"
  | "paused" | "error" | "done" | "disconnected" | "reconnecting" | "team_join" | "team_leave";

export type PlantView = { face: FaceKey; run: RunView | null; reason: "run" | "idle" | "connection" | "team" };

export type TeamEvent = { kind: "team_join" | "team_leave"; at: number };

export const DONE_HOLD_MS = 4000; // "done" smiles for a moment, then back to idle
export const ERROR_HOLD_MS = 20_000; // long enough to notice from across the table
export const TEAM_OVERLAY_MS = 3000; // join/leave animation, then back to the current state

export function plantFace(
  runs: Iterable<RunView>,
  selfId: string | null,
  opts: { connection: ConnectionStatus; now: number; team?: TeamEvent | null },
): PlantView {
  if (opts.connection === "reconnecting" || opts.connection === "connecting") return { face: "reconnecting", run: null, reason: "connection" };
  if (opts.connection !== "connected") return { face: "disconnected", run: null, reason: "connection" };

  // In-progress runs always count; finished ones only for a short while after they end.
  const counts = (r: RunView) => {
    if (r.state === "done") return opts.now - (r.endedAt ?? 0) < DONE_HOLD_MS;
    if (r.state === "error") return opts.now - (r.endedAt ?? 0) < ERROR_HOLD_MS;
    return true;
  };
  const mine = [...runs].filter((r) => r.ownerId === selfId && counts(r));
  // Most important state first; among equals, the most recently started run.
  mine.sort((a, b) => PRIORITY.indexOf(a.state) - PRIORITY.indexOf(b.state) || b.startedAt - a.startedAt);
  const top = mine[0] ?? null;

  // Team join/leave plays over anything but an error or a question for the owner.
  const urgent = top && (top.state === "error" || top.state === "awaiting_approval");
  if (opts.team && opts.now - opts.team.at < TEAM_OVERLAY_MS && !urgent) return { face: opts.team.kind, run: top, reason: "team" };

  if (!top) return { face: "idle", run: null, reason: "idle" };
  return { face: faceFor(top), run: top, reason: "run" };
}

export function faceFor(run: Pick<RunView, "state" | "routerMode">): FaceKey {
  if (run.state === "routing") return run.routerMode === "llm" ? "routing_llm" : run.routerMode === "cache" ? "routing_cache" : "routing";
  return run.state;
}
