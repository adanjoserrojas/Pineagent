# Connecting the frozen harness to Pineagent

## Recommendation about SWE2

Do not pull the workspace branch directly into `feature/harness` to connect routing. In the inspected local refs, SWE2's `claude/workspace/solo-editor-slice` is already an ancestor of `main`. Use the release captain's reviewed integration baseline and its existing socket contracts; fetch/reconcile the latest remote state before a future integration merge. No frontend/backend branches were merged or changed during this transfer.

The browser starts/lists/approves/pauses runs through Socket.IO. It does not import this package, hold provider credentials, or call Decisions/Jev. The backend authenticates the owner and binds a run to the room's workspace/branch.

## Existing server connection point

Read-only inspection found a real seam on local `claude/infra/ec2`, not in this older feature branch's checkout:

- `packages/core/src/server/harness.ts`: `HarnessFactory = (ctx: HarnessContext) => Harness`.
- Context exposes `ws`, `roomId`, `files()` and `events.run/lockChanged/fileChanged`.
- Harness exposes synchronous start acknowledgement plus `list`, `approve`, `pause`, `resume`, `close`.
- `packages/core/src/server/gateway.ts`: instantiates one harness per branch room and delegates `run:*` events using the authenticated user ID.
- `services/api/src/app.ts`: accepts `harness?: HarnessFactory` and forwards it to `createGateway`.
- `services/api/src/main.ts`: currently omits this option, so the app uses `noHarness` and starting a run returns `NOT_AVAILABLE`.

The eventual adapter implements that interface, then server composition supplies it as `createApp({ ...deps, harness: factory })`. `executeV8Dag` alone does not implement `HarnessFactory`; replacing `noHarness` with a bare executor would lose ownership, run state and write protection. No actual server composition has been changed here.

Packaging is also an explicit integration step: the inspected root npm workspace list includes only `packages/core`, `apps/web` and `services/api`. Add `harness` and the backend's `@pineagent/harness` dependency through the reviewed integration change, reconcile the root lockfile, and build this package before resolving its compiled ESM/declaration exports. Its standalone lockfile serves this feature branch; do not assume the current root workspace already installs or builds it. No root package metadata was modified here.

## LLD-to-runtime mapping

| LLD requirement | Backend adapter responsibility | Frozen package hook |
| --- | --- | --- |
| 1: PLAN goal and writeSet | Validate task schema, visible test, exact allowed paths, owner and workspace; obtain/approve a plan. No new planning model is hidden in this port. | `HarnessTask`, `selectCandidateDags({goalCapability:"verified_change", tools:prototypeTools})` |
| 1, 3: ACQUIRE | Atomically acquire the complete write set through Workspace; queue blocked runs, renew leases and stop on loss/revocation. | `allowedWrites` is an additional lexical scope check, not a lock. |
| 1–2: SELECT/ROUTE | Build candidates, own credentials/metering, create a per-run router; retain candidates/decisions for approval UI. | `createFrozenRouter`, `FROZEN_HISTORY`, `executeV8Dag` |
| 1–2: EXECUTE/approval | Own asynchronous run lifecycle and owner-only controls. Persist uncertainty; do not auto-write or restart a paused run with fresh credentials/evidence. | `executeV8Dag` returns trace/result and `awaiting_approval`; no persisted continuation/control loop is provided. |
| 4, 7: edits and owner sandbox | Route every edit through the shared version/lock authority or an audited owner-container bridge; run tools/fallback inside that owner's non-root sandbox. | Local `SandboxToolRuntime` is a fixture implementation, not the shared writer. |
| 8–9: events/reconnect | Emit monotonic `seq`, consistent snapshots and node progress; implement `run:list`, pause/resume and persistence. | `routingDecisions`, `nodeEvents`, `recovery`, `writeGate`, verification/fallback result fields. These are returned after work, not a live event stream. |
| 2, 9: observable fallback | Report scorer-provider failover separately from coding recovery; independently meter every attempt. | `route.routerMode`, `providerTrace`, `execution.fallback`; injected `FallbackAgent`. |

## Critical write boundary

The server Workspace API already exposes `acquireForRun(paths, ownerId, runId)`, `read(path)`, `applyOps(path, userId, baseVersion, ops, runId)` and `releaseRun(runId)`. `applyOps` rejects stale versions/non-holders and is the authority for sequenced file changes. Agent writes must preserve these checks and notify `fileChanged`/`lockChanged` through the gateway.

Do not point the raw filesystem writer or an unconstrained CLI fallback at the collaborative room root. Before wiring this package, implement and validate the Workspace-mediated tool seam, or the LLD's owner-container permission and watcher/version bridge. The choice affects shared editing/lock behavior and requires SE1/release-captain review. Neither mechanism is implemented by this source transfer. Lock loss must halt further writes; a failed/paused run must follow the agreed lease policy and avoid leaking locks.

A returned `awaiting_approval` is not an implemented resumable server run. Candidate approval must be authenticated, revalidate workspace versions/locks/evidence and resume through a reviewed continuation design. Pause/resume/cancel and node-boundary event hooks are likewise adapter work, not claims about the frozen core.

## Contract mismatch to resolve before enabling

Local `main`'s draft `contracts/RUN_EVENTS.md` and browser mirror recognize `routerMode: "openai" | "jev" | "cache" | "llm"` and optional `codingRecovery: "none" | "warm_agent"`. The inspected infra snapshot still has the older router union without `openai` and lacks `codingRecovery`. Reconcile these reviewed changes across the shared core, browser and backend first. This handoff does not change or freeze that shared contract.

Decisions must display as `openai`, not `jev`; Jev indicates scorer availability backup. Bounded read-only uncertainty recovery does not mean warm coding recovery. A warm coding fallback must not be mislabeled as routing mode `llm`. The original frozen executor permits fallback after unusable synthesis as well as verification failure; the draft contract wording only describes verification failure. Confirm that broader trigger with SWE2/SE1 rather than inventing a new wire meaning. Increment `seq` and keep event/snapshot values aligned when mode/recovery changes.

## Minimum integration acceptance gate

Before enabling a real room, demonstrate owner/non-owner controls; lock conflict, expiry and revocation; stale-version rejection; exactly-once file/event reconciliation; persistent approval without writes; safe pause/resume; reconnect snapshots with increasing `seq`; final diff reconciliation including fallback writes; provider failover separate from recovery; and failure/timeout cleanup. Exercise the actual target language/repository, not only these JavaScript fixtures. Run untrusted tests and CLI in the owner container with no host credentials or hidden benchmark answers. No browser, backend, cloud or hardware integration evidence was produced by the TypeScript transfer.

Suggested integration reviewers: Software Engineer 1/release captain for the adapter and safety boundary; SWE2 for run-event/browser compatibility. No SWE2 files, shared contracts, infrastructure, firmware or deployed services were modified.
