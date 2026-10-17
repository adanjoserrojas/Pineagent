# Socket.IO Contract Draft: Git Queue and Commit Ownership

**Status:** Draft from Software Engineer 2 (owner of LLD section 6). Not yet reviewed by Software Engineer 1. Implemented in the mock (`apps/web/mock/`), the browser commit dialog and the explorer's change letters; not in the real server.

**Covers:** release scenario 7 ("one user cannot commit another user's uncommitted paths") and LLD section 6 (one serial Git queue per worktree; commit only your paths; push = commit → pull --rebase → push, abort on conflict). Agent commits, the terminal `git` wrapper and incoming-remote "held" UI are out of scope here.

## Ownership rule

The server records, per path, every user whose `file:ops` were accepted since that path was last committed (`editors`). For the requesting user a dirty path is:

| Condition | Committable | `reason` |
| --- | --- | --- |
| editors = {me}, no lock held by anyone else | yes | — |
| editors include someone else | no | `OTHERS_EDITED` |
| another user (or my agent run) holds a lock covering it | no | `LOCKED_BY_OTHER` |
| no editors (shell, formatter, agent outside the editor) | no | `UNATTRIBUTED` |

The server re-checks every requested path when the job runs, not just when the dialog loads. One non-committable path fails the whole job (`NOT_YOURS`); nothing is committed partially.

## Shared types

```ts
type GitChange = {
  path: string;
  status: "M" | "A" | "D";
  added: number;               // lines, from git diff --numstat (untracked: line count)
  removed: number;
  editors: string[];           // userIds since the path's last commit
  committable: boolean;        // for the requesting user
  reason?: "OTHERS_EDITED" | "LOCKED_BY_OTHER" | "UNATTRIBUTED";
};

type GitJob = {
  id: string;
  userId: string;
  name: string;                // display name of the requester
  kind: "commit" | "push" | "commit+push";
  state: "queued" | "running";
};

type GitErrorCode =
  | "NOT_YOURS"          // a requested path isn't committable by this user (paths listed)
  | "NOTHING_TO_COMMIT"
  | "REMOTE_HELD"        // incoming remote commits touch paths with uncommitted work (paths listed); commit stays local
  | "REBASE_CONFLICT"    // rebase aborted; commit stays local
  | "PUSH_REJECTED"      // remote moved during the push
  | "BAD_REQUEST"
  | "FAILED";
```

## Events

| Event | Direction | Payload | Ack / notes |
| --- | --- | --- | --- |
| `git:status` | C→S | `{}` | `{ ok: true, branch, ahead, changes: GitChange[], queue: GitJob[] }`. Read-only; bypasses the queue (`GIT_OPTIONAL_LOCKS=0`). `ahead` = local commits not on the remote. |
| `git:commit` | C→S | `{ paths: string[], message: string, push: boolean }` | `{ ok: true, jobId }` or `{ ok: false, code: "BAD_REQUEST" }`. Empty `paths` with `push: true` pushes existing local commits. |
| `git:queue` | S→room | `{ jobs: GitJob[] }` | Sent whenever a job is queued, starts or finishes. |
| `git:changes` | S→socket, S→room | `{ changes: { path, status: "M" \| "A" \| "D" }[] }`, sorted by path | PROPOSED. The branch's whole working-tree status, with no ownership info, for the explorer's letters and Changed filter. Sent to a socket right after its `room:join`, then to the room whenever the set changes (debounced after accepted `file:ops`, agent edits, Git results and tree changes). |
| `git:result` | S→room | `{ jobId, userId, ok: true, sha?, pushed, paths }` or `{ jobId, userId, ok: false, code: GitErrorCode, message, paths? }` | Everyone refreshes `git:status` on any result. |

## Server rules

1. One FIFO queue per worktree, concurrency 1. Status reads bypass it.
2. While a job commits paths, `file:ops` for those paths wait (they are not rejected). While a push rebases, all `file:ops` in the worktree wait.
3. Commit = `git add -- <paths>` then `git commit -m <message> --author "<name> <email>" -- <paths>`. Committed paths' `editors` are cleared.
4. Push = commit (if paths) → `fetch` → if the remote is ahead: refuse with `REMOTE_HELD` when incoming paths intersect dirty paths; otherwise `rebase --autostash origin/<branch>` (abort on failure → `REBASE_CONFLICT`) → refresh changed files (version++, `file:changed` with `source: "shell"`, `tree:changed` for adds/deletes) → `push`.
5. Every Git command runs with the requesting user's own GitHub token (LLD section 8; real server only).

## Open items for Software Engineer 1

- Author email: GitHub noreply (`<id>+<login>@users.noreply.github.com`) needs the numeric id and login from the Auth0 profile.
- `editors` must survive a server restart (DynamoDB `Files` item?) or be rebuilt as "unattributed".
- Agent-run commits: owner as author plus `Co-Authored-By: agent-run/<runId>`; agent edits count as the owner's.
