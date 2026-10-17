// Mirror of docs/contracts/SOCKET_LOCKS_AND_FILES.md (draft, not yet frozen).
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

export type Member = { userId: string; name: string; openPath: string | null };

export type RoomJoinAck =
  | { ok: true; self: Member; members: Member[]; locks: Lock[]; tree: string[] } // PROPOSED: self, tree
  | { ok: false; code: "NOT_COLLABORATOR" };

export type LockAcquireAck = { ok: true; lock: Lock } | { ok: false; code: "HELD"; lock: Lock };
export type HeartbeatAck = { ok: true; expired: string[] };
export type SnapshotAck =
  | { ok: true; path: string; version: number; content: string; hash: string }
  | { ok: false; code: "NOT_FOUND" };
export type OpsAck = { ok: true; version: number } | { ok: false; code: "NOT_HOLDER" | "STALE"; currentVersion: number };

export type LockChangeReason = "acquired" | "released" | "expired" | "idle" | "revoked";

export interface ClientToServerEvents {
  "room:join": (msg: { wsId: string; branch: string }, ack: (res: RoomJoinAck) => void) => void;
  "presence:update": (msg: { openPath: string | null }) => void;
  "lock:acquire": (msg: { path: string; kind: Lock["kind"] }, ack: (res: LockAcquireAck) => void) => void;
  "lock:release": (msg: { path: string }, ack: (res: { ok: true }) => void) => void;
  "session:heartbeat": (msg: Record<string, never>, ack: (res: HeartbeatAck) => void) => void;
  "file:snapshot": (msg: { path: string }, ack: (res: SnapshotAck) => void) => void;
  "file:ops": (msg: { path: string; baseVersion: number; ops: Op[] }, ack: (res: OpsAck) => void) => void;
}

export interface ServerToClientEvents {
  "presence:changed": (msg: { userId: string; name: string; status: "joined" | "left"; openPath?: string | null }) => void;
  "lock:changed": (msg: { path: string; kind: Lock["kind"]; lock: Lock | null; reason: LockChangeReason }) => void;
  "file:changed": (msg: { path: string; version: number; ops: Op[]; author: string; source: "editor" | "agent" | "shell" }) => void;
  "tree:changed": (msg: { path: string; change: "add" | "delete" | "rename"; newPath?: string }) => void;
}

export const roomName = (wsId: string, branch: string) => `ws:${wsId}:${branch}`;
