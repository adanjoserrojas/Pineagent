// Mirror of contracts/SOCKET_LOCKS_AND_FILES.md (draft, not yet frozen).
// Fields marked PROPOSED are additions this slice needs; they still need SE1 sign-off.

export type Lock = {
  path: string; // "src/auth.ts", or "src/K/" for a directory
  kind: "file" | "dir";
  holder: string; // userId (Auth0 `sub`)
  holderType: "user" | "run";
  runId?: string;
  expiresAt: number; // epoch ms
};

// Maps from Monaco: change.rangeOffset, change.rangeLength, change.text.
export type Op = { offset: number; length: number; text: string };

export type ErrorCode = "NOT_COLLABORATOR" | "HELD" | "NOT_HOLDER" | "STALE" | "NOT_FOUND";

// PROPOSED: connect_error `data.code` when the handshake token is missing or invalid.
export const UNAUTHENTICATED = "UNAUTHENTICATED";

// PROPOSED: avatarUrl. The server derives it from the Auth0 sub `github|<id>`; null when unknown.
export type Member = { userId: string; name: string; avatarUrl: string | null; openPath: string | null };

// PROPOSED: the server owns lease timing, so clients heartbeat at the rate it asks for
// (tests shorten both; production is 10 s / 30 s).
export type LeaseTiming = { heartbeatMs: number; leaseMs: number };

export type RoomJoinAck =
  | { ok: true; self: Member; members: Member[]; locks: Lock[]; tree: string[]; timing: LeaseTiming } // PROPOSED: self, tree, timing
  // PROPOSED: UNAVAILABLE = the server couldn't open the repository (clone failed, not allowlisted).
  | { ok: false; code: "NOT_COLLABORATOR" | "UNAVAILABLE" };

export type LockAcquireAck = { ok: true; lock: Lock } | { ok: false; code: "HELD"; lock: Lock };
export type HeartbeatAck = { ok: true; expired: string[] };
// PROPOSED: `ok: true` on success so every ack shares one discriminant (the draft omits it).
export type SnapshotAck =
  | { ok: true; path: string; version: number; content: string; hash: string }
  | { ok: false; code: "NOT_FOUND" }
  // PROPOSED: the file exists but isn't editable text (binary, or over 1 MB).
  | { ok: false; code: "UNSUPPORTED"; reason: "binary" | "too_large" };
export type OpsAck = { ok: true; version: number } | { ok: false; code: "NOT_HOLDER" | "STALE"; currentVersion: number };

export type LockChangeReason = "acquired" | "released" | "expired" | "idle" | "revoked";

// --- Agent runs (contracts/RUN_EVENTS.md, draft; SE1 owns the run-state machine) -----

export type RunState = "planning" | "routing" | "awaiting_approval" | "blocked" | "executing" | "paused" | "error" | "done";
// "openai" is the current harness adapter's name for OpenAI Decisions.
// Jev is a scorer-provider backup, not the coding agent used after a failed DAG.
export type RouterMode = "openai" | "jev" | "cache" | "llm";
export type CodingRecovery = "none" | "warm_agent";
export type RunStep = { tool: string; detail: string; writes: string[] };
export type RunCandidate = { id: string; score: number; steps: RunStep[] };

export type RunView = {
  runId: string;
  ownerId: string;
  ownerName: string;
  task: string;
  state: RunState;
  routerMode: RouterMode | null;
  // PROPOSED: optional only while the existing mock migrates; real backend emits it.
  codingRecovery?: CodingRecovery;
  nodeIndex: number;
  seq: number;
  steps: RunStep[];
  candidates?: RunCandidate[];
  confidence?: number;
  writeSet: string[];
  blockedOn?: { path: string; holder: string };
  error?: { nodeIndex: number; message: string };
  startedAt: number;
  endedAt?: number;
};

// The fields fixed in PROJECT_MEMORY.md, plus `run` (PROPOSED): the full snapshot after this event.
export type RunEvent = {
  runId: string;
  ownerId: string;
  workspaceId: string;
  seq: number;
  state: RunState;
  routerMode: RouterMode | null;
  codingRecovery?: CodingRecovery;
  nodeIndex: number;
  ts: number;
  run: RunView;
};

// PROPOSED: NOT_AVAILABLE = this server has no agent harness yet.
export type RunStartAck = { ok: true; runId: string } | { ok: false; code: "BAD_REQUEST" | "NOT_AVAILABLE" };

export type RunActionAck = { ok: true } | { ok: false; code: "NOT_OWNER" | "NOT_WAITING" | "NOT_FOUND" };

// --- Git queue (contracts/GIT_QUEUE.md, draft) ---------------------------------------

export type GitChange = {
  path: string;
  status: "M" | "A" | "D";
  added: number;
  removed: number;
  editors: string[]; // userIds whose edits landed since the path's last commit
  committable: boolean; // for the requesting user
  reason?: "OTHERS_EDITED" | "LOCKED_BY_OTHER" | "UNATTRIBUTED";
};

// PROPOSED: the branch's working-tree status, for everyone (the explorer's letters). Unlike
// GitChange it says nothing about who may commit, so it's cheap to broadcast.
export type FileChange = { path: string; status: GitChange["status"] };

export type GitJob = {
  id: string;
  userId: string;
  name: string;
  kind: "commit" | "push" | "commit+push";
  state: "queued" | "running";
};

export type GitErrorCode =
  | "NOT_YOURS"
  | "NOTHING_TO_COMMIT"
  | "REMOTE_HELD"
  | "REBASE_CONFLICT"
  | "PUSH_REJECTED"
  | "BAD_REQUEST"
  | "FAILED";

export type GitStatusAck = { ok: true; branch: string; ahead: number; changes: GitChange[]; queue: GitJob[] };
export type GitCommitAck = { ok: true; jobId: string } | { ok: false; code: "BAD_REQUEST" };
export type GitResult =
  | { jobId: string; userId: string; ok: true; sha?: string; pushed: boolean; paths: string[] }
  | { jobId: string; userId: string; ok: false; code: GitErrorCode; message: string; paths?: string[] };

export interface ClientToServerEvents {
  "room:join": (msg: { wsId: string; branch: string }, ack: (res: RoomJoinAck) => void) => void;
  "presence:update": (msg: { openPath: string | null }) => void;
  "lock:acquire": (msg: { path: string; kind: Lock["kind"] }, ack: (res: LockAcquireAck) => void) => void;
  "lock:release": (msg: { path: string }, ack: (res: { ok: true }) => void) => void;
  "session:heartbeat": (msg: Record<string, never>, ack: (res: HeartbeatAck) => void) => void;
  "file:snapshot": (msg: { path: string }, ack: (res: SnapshotAck) => void) => void;
  "file:ops": (msg: { path: string; baseVersion: number; ops: Op[] }, ack: (res: OpsAck) => void) => void;
  "git:status": (msg: Record<string, never>, ack: (res: GitStatusAck) => void) => void;
  "git:commit": (msg: { paths: string[]; message: string; push: boolean }, ack: (res: GitCommitAck) => void) => void;
  "run:start": (msg: { task: string }, ack: (res: RunStartAck) => void) => void;
  "run:list": (msg: Record<string, never>, ack: (res: { ok: true; runs: RunView[] }) => void) => void;
  "run:approve": (
    msg: { runId: string; candidateId: string } | { runId: string; none: true; hint: string },
    ack: (res: RunActionAck) => void,
  ) => void;
  "run:pause": (msg: { runId: string }, ack: (res: RunActionAck) => void) => void;
  "run:resume": (msg: { runId: string }, ack: (res: RunActionAck) => void) => void;
}

export interface ServerToClientEvents {
  // PROPOSED: status "updated" (openPath changed) and avatarUrl.
  "presence:changed": (msg: {
    userId: string;
    name: string;
    avatarUrl?: string | null;
    status: "joined" | "left" | "updated";
    openPath?: string | null;
  }) => void;
  "lock:changed": (msg: { path: string; kind: Lock["kind"]; lock: Lock | null; reason: LockChangeReason }) => void;
  "file:changed": (msg: { path: string; version: number; ops: Op[]; author: string; source: "editor" | "agent" | "shell" }) => void;
  "tree:changed": (msg: { path: string; change: "add" | "delete" | "rename"; newPath?: string }) => void;
  "git:queue": (msg: { jobs: GitJob[] }) => void;
  // PROPOSED: the full list, to the joining socket after room:join and to the room when it changes.
  "git:changes": (msg: { changes: FileChange[] }) => void;
  "run:event": (msg: RunEvent) => void;
  "git:result": (msg: GitResult) => void;
}

export const roomName = (wsId: string, branch: string) => `ws:${wsId}:${branch}`;

// Auth0's GitHub connection issues subs like "github|583231"; the number is the GitHub user id,
// which resolves to the profile picture without any extra API call or token claim.
export function githubAvatarUrl(sub: string, size = 64): string | null {
  const m = sub.match(/^github\|(\d+)$/);
  return m ? `https://avatars.githubusercontent.com/u/${m[1]}?s=${size}` : null;
}
