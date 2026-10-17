# Accepted V8 behavior and boundary

## Requirement and source of truth

Preserve the approved V8 Direct DAG behavior while transferring its source into strict TypeScript. Owner: Software Engineer 1. The human owner approved the design freeze and local atomic commits on `feature/harness`; no push, merge, deployment or shared-interface rewrite is included.

Sources: the preparation archive's `Updated_SwampHacks_LowLevel_Design.excalidraw`, harness sections 1–2 and 7–9; the accepted Direct DAG/V8 corrections in this conversation; and the original `Pear/harness` V8 freeze-review snapshot. The snapshot still says awaiting review because it predates the owner's approval; this transfer does not rewrite the historical record. Source hashes and inspected branch refs are recorded in `FREEZE_MANIFEST.json`.

The LLD's dependency ordering, write-set ownership, approval gate, fallback visibility and event sequence remain architectural requirements. The accepted experiment deliberately replaces the older LLD's per-node LLM argument filling: discovery/expansion arguments are resolved by code, not a new inference/system prompt at every tool transition. It also freezes a calibrated 0.30 probability-gap gate instead of the original placeholder 0.60 confidence gate. Other unimplemented LLD infrastructure is not implied by a core port.

## Master-0 and Master-1

Master-0 validates tool dependencies, rejects cycles, canonicalizes sibling order, removes duplicate candidates, checks unordered overlapping writers and applies repeat/depth bounds. It returns the same three candidate IDs and route labels as the frozen JavaScript:

| Route label | Discovery strategy before synthesis/verification |
| --- | --- |
| `targeted_symbol_search` | Read the visible test and small symbol/task-relevant source set. |
| `failure_first_diagnosis` | Also execute the visible test to gather authoritative failure output. |
| `repository_flow_mapping` | Trace imports/callers from the visible entry point with bounded collected evidence. |

Master-1 chooses among these candidates using Decisions. The frozen factory disables score caching, uses confidence threshold 0 and requires top-minus-runner-up probability margin at least 0.30. Scores are provider outputs, not calibrated probabilities of task correctness. Unknown or malformed choices cannot authorize a write. Jev is an availability backup, not an ambiguity bypass; missing/ambiguous successful Decisions output does not automatically try another provider. Generic legacy/oracle modes exist for tests and are not the frozen demo arm.

## One bounded uncertainty recovery

An initial `awaiting_approval` result permits exactly one read-only collection, followed by at most one reassessment under the same gate. It reads the visible test, relevant named sources, package metadata and resolvable dependencies, up to two edges from the test. No repository code or tests execute during this recovery collection.

Frozen caps are 12 collected files, 24,000 characters including file headers/separators and a 10-second checked elapsed budget. The time limit is checked between operations, not enforced as an interrupt on directory enumeration or filesystem reads. File enumeration and full-file I/O are not hard bounded by the exported evidence limit. These are context/approval limits, not containment or latency guarantees.

The visible test and observed direct source entry points must be fully read, at least one complete source must be present, and no evidence/budget truncation is accepted. Otherwise the result is `awaiting_approval`, with no synthesis or writing fallback. Continued uncertainty after reassessment also pauses. The core returns this boundary; persisting it and handling later owner approval are backend adapter responsibilities.

## Direct execution and warm recovery

The V8 wrapper invokes the frozen V7 executor with the selected discovery strategy. Its collector follows a fixed implementation for these three known routes; it is not a general arbitrary-plugin DAG interpreter. Deterministic checkpoints can expand discovery (up to two iterations) for unresolved imports/cross-file work. V8 does not provide the optional V7 `chooseExpansion` router callback, so there is no extra Master-1 call between these tool transitions.

Before patch synthesis the wrapper requires a selected candidate and source/test evidence; recovered runs also require sufficient recovery evidence. This checks observable prerequisites, not semantic correctness. Collected recovery snapshots are reused instead of duplicated in the synthesis prompt where already present. One coding request uses `gpt-6-sol`, medium reasoning, final-answer extraction, the cross-file change contract and 8,192 maximum output tokens, matching the V8 worker.

After writing the patch, visible repository verification runs. An empty/unusable patch or failed verification may invoke the injected warm coding fallback once. It receives the same working tree, prior evidence, current changed file contents and the failure, plus recovery snapshots if collected. It does not redo initial discovery from scratch. Fallback model, effort, execution isolation and usage accounting are host responsibilities; the experimental callback used Codex CLI on Sol 6/medium. Missing fallback simply means no warm recovery. Failure after recovery is reported, not silently retried forever.

`execution.modelCalls` counts synthesis and only fallback calls reported by the callback; it excludes routing and is not a token/cost measure. Use `routingDecisions`, provider receipts and fallback usage for total inference accounting. `changedPaths` does not enumerate additional fallback writes, so the host must reconcile the final workspace diff independently.

## Frozen scope and risks

The benchmark supports bounded JavaScript code repair and small function implementation, not broad feature work or arbitrary repository/language competence. TypeScript is the implementation language; V7 dependency indexing remains JS/MJS/CJS-specific. TypeScript/TSX workspace targeting needs its own acceptance cases before enabling it.

The local runtime executes tests as child processes and writes directly to disk. Lexical write-set checks and some symlink checks are not comprehensive security, transactional multi-file writes or version/lock enforcement. A failed multi-file patch may already have partially written; there is no rollback. Test runtime/output capture has no hard process timeout/memory bound here. Use only trusted fixtures in this standalone package; untrusted repositories require the owner container, mediated writes, resource limits and credential isolation described in the LLD. No backend, browser, AWS or hardware readiness follows from passing these tests.
