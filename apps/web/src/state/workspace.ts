import { useSyncExternalStore } from "react";
import type { FileChange, GitJob, GitResult, LeaseTiming, Lock, Member, RunView } from "../contracts/socket";
import type { TeamEvent } from "../runs/runs";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline" | "unauthenticated" | "forbidden" | "unavailable";

export type WorkspaceState = {
  connection: ConnectionStatus;
  self: Member | null;
  members: Member[];
  locks: Map<string, Lock>;
  tree: string[];
  timing: LeaseTiming | null;
  changes: Map<string, FileChange["status"]>; // the branch's uncommitted paths, for the explorer
  gitQueue: GitJob[];
  lastGitResult: GitResult | null;
  runs: Map<string, RunView>;
  team: TeamEvent | null; // last teammate join/leave, for the plant's overlay
};

const initial: WorkspaceState = {
  connection: "connecting",
  self: null,
  members: [],
  locks: new Map(),
  tree: [],
  timing: null,
  changes: new Map(),
  gitQueue: [],
  lastGitResult: null,
  runs: new Map(),
  team: null,
};

// Tiny external store: React reads it through useSyncExternalStore; socket handlers write it.
export function createWorkspaceStore() {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<WorkspaceState>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export function useWorkspace(store: WorkspaceStore) {
  return useSyncExternalStore(store.subscribe, store.get);
}
