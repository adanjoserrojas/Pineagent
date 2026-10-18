# Sandbox supervisor boundary (SE1, LLD box 7)

`host.ts` is the Docker-side component of the supervisor, not a public API handler.
It is intentionally **not wired into `main.ts`** until the restricted supervisor
transport, ownership reconciliation, and room authority adapter are complete.
Do not give the API user membership in the Docker group or mount the Docker socket
into the API/CLI. Docker authority belongs only to a separately managed supervisor.

The backend must establish the authenticated user and room, freeze/drain the
workspace, quiesce/reconcile previous writable processes, and derive grants from
the server's lock table before calling `ensure`. Client-supplied paths or owner
IDs are never authority. All changed grants require removal/recreation, which
terminates old open descriptors. `quiesce` must finish before releasing locks;
if it fails, ownership remains held and new sessions fail closed.

The supervisor enforces a pinned local image ID, non-root UID, read-only base
mount/root filesystem, only explicit held-path writable mounts, hidden Git
metadata, no capabilities, no privilege escalation, no network, 1 CPU / 2 GiB /
256 processes, bounded command output/time, 16-session capacity, and 30-minute
container lifetime. UID defaults to 1000 and must match the managed workspace
filesystem's writer identity. Directory grants reject symlink/hardlink aliases,
special files, and nested Git metadata, with a bounded inspection budget.
One supervisor owns a workspace-root namespace; at startup it removes orphaned
containers carrying that namespace label before admitting work.

Conservative current behavior: reopening a session recreates its container. No
package-registry egress or persistent dependency cache is implemented yet.
File-only bind grants support in-place writes, not rename-over-file saves.
The API's authoritative edit path supports atomic replacement after quiescence.

Verification from repository root (Docker must be running): set
`PINEAGENT_SANDBOX_IMAGE` to the local SHA-256 image ID from
`docker image inspect pineagent-cli-validation:git-queue`, then run
`npm test -w @pineagent/api -- tests/sandbox.test.ts`.
The optional real-Docker probe validates mount denial, non-root identity, Git
masking, missing credentials/socket/network, and termination of an inherited
writable file descriptor after revocation. Other tests fake only the Docker
process boundary to exercise daemon failure and restart reconciliation.

Pending before activation: narrow supervisor IPC, shell-change versions/editor
attribution, authoritative grant adapter, scoped CLI sessions, browser PTY,
frozen-harness runtime wiring, and deployment approval. This component alone is
not evidence that the deployed workspace is isolated.
