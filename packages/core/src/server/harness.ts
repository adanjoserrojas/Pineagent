// The plug point for the agent harness (SE1, LLD sections 1, 2, 9). The harness runs inside this
// Node process, one instance per branch room, and talks to the rest of the server only through
// this interface: it locks and edits files through the room's Workspace (so every agent write
// passes the same lock checks as a person's) and reports progress through HarnessEvents, which the
// gateway broadcasts as contracts/RUN_EVENTS.md events.
import type { Lock, Op, RunActionAck, RunEvent, RunStartAck, RunView } from "../contracts";
import type { Workspace } from "./workspace";

export type HarnessEvents = {
  run(e: RunEvent): void;
  lockChanged(path: string, lock: Lock | null, reason: "acquired" | "released"): void;
  fileChanged(path: string, version: number, ops: Op[], author: string): void;
};

export type HarnessContext = {
  ws: Workspace;
  roomId: string; // RunEvent.workspaceId
  files: () => Promise<string[]>; // the branch's file list, for planning
  events: HarnessEvents;
};

export interface Harness {
  start(owner: { id: string; name: string }, task: unknown): RunStartAck;
  list(): RunView[];
  approve(runId: string, userId: string, choice: { candidateId?: unknown; none?: unknown; hint?: unknown }): RunActionAck;
  pause(runId: string, userId: string): RunActionAck;
  resume(runId: string, userId: string): RunActionAck;
  close(): void;
}

export type HarnessFactory = (ctx: HarnessContext) => Harness;

// Until the real harness is plugged in: no runs, and starting one says so (instead of hanging,
// which the browser would read as a dead connection).
export const noHarness: HarnessFactory = () => ({
  start: () => ({ ok: false, code: "NOT_AVAILABLE" }),
  list: () => [],
  approve: () => ({ ok: false, code: "NOT_FOUND" }),
  pause: () => ({ ok: false, code: "NOT_FOUND" }),
  resume: () => ({ ok: false, code: "NOT_FOUND" }),
  close: () => {},
});
