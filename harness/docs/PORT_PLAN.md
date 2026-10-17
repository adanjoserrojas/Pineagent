# Frozen V8 TypeScript transfer

Owner: Software Engineer 1. Human owner explicitly approved the V8 design freeze, TypeScript transfer and local atomic commits on feature/harness. Keep all writes within harness/.

Acceptance: preserve the V8 candidate IDs, routing gate, provider fallback, deterministic execution, bounded recovery and no-write behavior. Every atomic unit includes its tests, passes strict type checking and is committed locally. TypeScript conversion requires verification; the JavaScript benchmark remains evidence for the original source until parity checks pass.

Units:

1. Typed domain model, canonicalization, registry and deterministic Master-0.
2. Master-1 scorer adapters, frozen configuration and router tests.
3. Sandbox tools, V7 execution and V8 recovery with self-contained fixture tests and parity evidence.
4. Backend integration reference, public exports, complete verification and source freeze manifest.

Backend design references: low-level design sections 1 (plan, acquire, select, route, execute), 2 (availability and approval), 7 (owner sandbox), 8–9 (run events), and the accepted V8 correction. V8 resolves node arguments deterministically and uses model calls for route selection/reassessment, patch synthesis and optional warm coding recovery, preserving the approved Direct DAG design.

The workspace branch already has run event contracts. Read its existing contracts and the backend's current seam before documenting integration. Do not merge a frontend branch, change shared wire contracts, deploy, push, or copy credentials, benchmark corpora, generated runs or Git metadata as part of this transfer.

Verified units: Master-0 passed five tests and retained all three frozen candidate IDs. Master-1 plus the frozen configuration passed thirteen cumulative tests, including low-confidence pause, malformed-response handling, simulated Decisions-to-Jev availability fallback, cache behavior and the exact V8 margin. No live provider calls were required for the transfer.

Execution unit: strict compilation and 32 cumulative unit tests passed. Seven additional offline reference checks passed against the original frozen JavaScript: source hashes, complete Master-0 candidates and history, Master-1 outcomes, and V8 selected, recovered, persistent-uncertainty and exhausted-budget paths. Runtime tests also exercised failed-patch warm recovery, deterministic dependency expansion and write-set/traversal rejection. No original benchmark fixtures or generated results were transferred. This verifies a bounded source port, not a new live benchmark or backend integration.

Final handoff unit adds the tested frozen synthesis factory (matching the original worker), design and integration references, verification evidence and normalized-LF source seals. Final acceptance is 33 unit tests, seven reference checks, three freeze checks and strict type checking, followed by a scoped diff review and local commit. Backend/shared-contract work remains a separate gate; no frontend branch pull is necessary based on the inspected local main ancestry.
