# Feature-building production revision

Owner: Software Engineer 1. Authorized branch: `fix/harness-production`, based on remote main `ccc3005` (Python validator included).

Acceptance: requirements can produce a bounded feature spanning new source files, existing callers and new acceptance tests, for Node and Python. Existing tests are immutable. The same Master-0 candidates, Master-1 gate, deterministic discovery, one synthesis and at most one coding recovery remain. No per-tool inference is introduced.

Functional commits: (1) validate routing responses, (2) bounded reusable evidence and repository adapters, (3) transactional feature-file creation through workspace authority, (4) requirements-to-feature model/controller integration, (5) resource accounting and cancellation, (6) end-to-end verification and handoff.

Interfaces: additive internal harness plan/patch fields and the backend workspace authority. Existing REST, Socket.IO and device schemas stay unchanged. Backend-owned implementation changes to the workspace authority are needed for missing-file expectations; its existing locks and version semantics remain authoritative.

Failure behavior: malformed routing pauses; stale evidence, scope violations, incomplete patches and exhausted budgets fail closed. New files require an absence observation and a run lock. All patches are validated before publication. Generated acceptance tests supplement existing regression tests; they are not an independent correctness oracle.

Verification: adversarial routing tests; bounded evidence and import tests; transactional write/creation tests; controller tests with real Node/Python validation and deterministic provider fixtures; package typechecks and regression suites. Live model quality, cloud deployment and broad benchmark performance remain separate evaluations. No credentials, cloud writes or paid benchmark runs are needed for this implementation.

Historical `FREEZE_MANIFEST.json` stays unchanged. Explicit production overrides and additions are sealed by `node scripts/seal-production.mjs` after each reviewed unit; the seal is change detection, not evidence of correctness.
