# Socket.IO Contract Draft: Locks and Live File Edits

**Status:** Draft proposal from Software Engineer 2 for the hour-1.5 interface freeze. Not yet approved by Software Engineer 1 or the Hardware Engineer. Implemented by the mock (`apps/web/mock/`) and the browser editor, with the tests below passing against the mock; not in the real server. The TypeScript mirror is `apps/web/src/contracts/socket.ts`; fields marked PROPOSED there are additions that need sign-off.

**Covers:** low-level design section 3 (locks) and section 5 (live edits and file versioning), browser-to-server only. Agent lock acquisition, the run-event stream, Git, and proposals are out of scope.

## Principles

- The client asks, the server decides, the server announces. A client never assumes it holds a lock or that an edit landed until the server says so.
- Identity comes from the authenticated socket (`socket.data.user`), never from a payload field.
- One room per branch: `ws:{wsId}:{branch}`. Different branches share no locks and no file events.
- The server is the only sequencer. Each file has one monotonic `version`.
- Socket.IO does not restore room membership after a reconnect. The client must emit `room:join` again.

## Decisions taken

| # | Question | Decision |
| --- | --- | --- |
| D1 | First keystroke while the lock request is in flight | **Optimistic.** Show the keystroke immediately; if the server answers `HELD`, revert the buffer to the last server snapshot and switch to read-only. |
| D2 | Unsent edits when the writer loses the lock | **Warn and preserve.** Show "Your recent edits to `<path>` were not saved", offer a **Copy my version** button, then re-snapshot. |
| D3 | Audience for `file:changed` | **Branch-wide.** Broadcast to the whole room; clients without the file open ignore the payload. |

## Shared types

```ts
type Lock = {
  path: string;                  // "src/auth.ts", or "src/K/" for a directory
  kind: "file" | "dir";
  holder: string;                // userId
  holderType: "user" | "run";    // "run" = the holder's agent
  runId?: string;
  expiresAt: number;             // epoch ms
};

type Op = { offset: number; length: number; text: string };
// Maps directly from Monaco: change.rangeOffset, change.rangeLength, change.text.
// Ops in one batch apply in array order against the progressively updated text.

type ErrorCode = "NOT_COLLABORATOR" | "HELD" | "NOT_HOLDER" | "STALE" | "NOT_FOUND";
```

## Events

C→S events use a Socket.IO acknowledgement. S→room events are broadcasts. A handshake with a missing or invalid token fails with `connect_error` whose `data.code` is `"UNAUTHENTICATED"` (PROPOSED).

### Room and presence

| Event | Direction | Payload | Ack / notes |
| --- | --- | --- | --- |
| `room:join` | C→S | `{ wsId, branch }` | `{ ok: true, self: Member, members: Member[], locks: Lock[], tree: string[], timing: { heartbeatMs, leaseMs } }` or `{ ok: false, code: "NOT_COLLABORATOR" }`. `Member = { userId, name, avatarUrl, openPath }`. PROPOSED: `self`, `tree`, `timing`, `avatarUrl`. |
| `presence:update` | C→S | `{ openPath: string \| null }` | No ack. |
| `presence:changed` | S→room | `{ userId, name, avatarUrl?, status: "joined" \| "left" \| "updated", openPath? }` | PROPOSED: `updated` (a member opened another file) and `avatarUrl`. |

### Locks

| Event | Direction | Payload | Ack / notes |
| --- | --- | --- | --- |
| `lock:acquire` | C→S | `{ path, kind }` | `{ ok: true, lock }` or `{ ok: false, code: "HELD", lock }`. A directory claim also fails when an ancestor or descendant is held by someone else. |
| `lock:release` | C→S | `{ path }` | `{ ok: true }` |
| `session:heartbeat` | C→S, every 10 s | `{}` | `{ ok: true, expired: string[] }`. Renews every lease this user holds. |
| `lock:changed` | S→room | `{ path, kind, lock: Lock \| null, reason }` | `reason`: `acquired`, `released`, `expired` (no heartbeat for 30 s), `idle` (10 min without edits), `revoked` (GitHub access removed). Agent locks taken by the harness arrive here with `holderType: "run"`. |

### Files

| Event | Direction | Payload | Ack / notes |
| --- | --- | --- | --- |
| `file:snapshot` | C→S | `{ path }` | `{ path, version, content, hash }` or `{ ok: false, code: "NOT_FOUND" }`. Used on open, on a version gap, and after reconnect. |
| `file:ops` | C→S, at most every 100 ms | `{ path, baseVersion, ops: Op[] }` | `{ ok: true, version }` or `{ ok: false, code: "NOT_HOLDER" \| "STALE", currentVersion }` |
| `file:changed` | S→room except sender | `{ path, version, ops, author, source: "editor" \| "agent" \| "shell" }` | `shell` = formatter or codegen output detected by the worktree watcher. |
| `tree:changed` | S→room | `{ path, change: "add" \| "delete" \| "rename", newPath? }` | |

## Server rules

1. `file:ops` is accepted only when the sender holds a `user` lock covering `path` and `baseVersion === version`. On accept: apply, write to disk, `version++`, set the lock's `lastEditAt`, ack, then broadcast.
2. A socket `disconnect` does **not** release locks. Wi-Fi drops are common; leases expire through the 30 s heartbeat timeout instead.
3. A sweep timer releases leases past `expiresAt` or idle for 10 minutes, and emits `lock:changed` for each.
4. A running agent run keeps its own leases alive. A run paused for approval counts as idle.
5. Lock state is held in memory and written through to DynamoDB before the ack (table keys owned by Software Engineer 1).

## Client behavior

### Writer: optimistic first keystroke (D1)

```text
lock map says path is free, user types
  → apply keystroke locally, buffer the op, emit lock:acquire
  ├─ ok   → start the 100 ms flush loop with baseVersion = snapshot version
  └─ HELD → editor.setValue(lastSnapshot.content); readOnly = true;
            toast "<holder> is editing this file"
```

If the lock map already shows another holder, the editor is read-only and no optimistic edit is attempted. The optimistic path exists only for the race where two users start typing on a free file at the same moment.

### Writer: flush loop

- Keep at most one `file:ops` batch in flight. Send the next batch only after the previous ack, using the version it returned as the next `baseVersion`.
- `NOT_HOLDER` or `STALE` on an ack → go to the lost-edits path below.

### Writer: lost edits (D2)

Triggers: `NOT_HOLDER` or `STALE` ack, `lock:changed` removing this user's lock while the buffer is non-empty, `session:heartbeat` listing the path in `expired`, or a reconnect where the lock is gone or the server version differs from the last acked version.

```text
keep a copy of the full local buffer text
show banner "Your recent edits to <path> were not saved"  [Copy my version]
request file:snapshot, replace the buffer, set readOnly according to the lock map
```

The copy action must be a button: `navigator.clipboard.writeText` requires a user gesture in most browsers.

The "server version differs" check also covers a formatter in the user's own terminal rewriting the file while the writer was offline.

### Viewer: applying broadcasts (D3)

```ts
socket.on("file:changed", (m) => {
  if (!openFiles.has(m.path)) return;          // branch-wide broadcast; not open here
  const mine = versions.get(m.path)!;
  if (m.version <= mine) return;               // duplicate
  if (m.version === mine + 1) return apply(m); // in order
  requestSnapshot(m.path);                     // gap
});
```

### Reconnect

On every `connect` event: `room:join`, replace the lock map with the returned `locks`, then for each open file either resume (writer, lock still held, server version equals last acked version: resend buffered ops) or `file:snapshot`.

## Browser acceptance tests (proposed)

| ID | Scenario | Expected observable result |
| --- | --- | --- |
| L1 | User A types in a free file | A's edits are accepted; user B sees a lock badge and a read-only editor within 1 s. |
| L2 | A and B type in the same free file within 50 ms | Exactly one becomes holder; the other's buffer reverts to the snapshot and shows "<holder> is editing". (Release scenario 4.) |
| L3 | B attempts `file:ops` without holding the lock (forced via devtools) | Server acks `NOT_HOLDER`; file on disk unchanged. |
| L4 | A stops sending heartbeats for 30 s | All clients receive `lock:changed` with `reason: "expired"`; B can acquire. |
| F1 | A types continuously for 10 s | B's buffer matches A's and the disk contents byte-for-byte; versions strictly increase. |
| F2 | Mock drops one `file:changed` delivered to B | B detects the gap, requests a snapshot, and converges. |
| F3 | B reloads the page mid-edit | B rejoins, snapshots, and matches A's current version. (Release scenario 5.) |
| F4 | A goes offline for 45 s with unsent edits | On reconnect A sees the lost-edits banner; **Copy my version** copies the local text; the buffer equals the server snapshot. |

## Open items for the freeze

- Software Engineer 1: DynamoDB `Locks` and `Files` item shapes, and the harness call for atomic agent `writeSet` acquisition.
- Software Engineer 1: whether terminal-sandbox `chown` enforcement subscribes to lock changes (recommended as a stretch goal).
- Maximum ops-batch size and maximum file size for snapshots.
