import { useSyncExternalStore } from "react";
import type { GitJob, GitResult, LeaseTiming, Lock, Member } from "../contracts/socket";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline" | "unauthenticated" | "forbidden";

export type WorkspaceState = {
  connection: ConnectionStatus;
  self: Member | null;
  members: Member[];
  locks: Map<string, Lock>;
  tree: string[];
  timing: LeaseTiming | null;
  gitQueue: GitJob[];
  lastGitResult: GitResult | null;
};

const initial: WorkspaceState = {
  connection: "connecting",
  self: null,
  members: [],
  locks: new Map(),
  tree: [],
  timing: null,
  gitQueue: [],
  lastGitResult: null,
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
