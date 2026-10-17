# TypeScript transfer verification and handoff

## Requirement, ownership and scope

Transfer the approved frozen V8 harness into `pineagent/harness` using strict TypeScript, preserving behavior and validating each atomic unit before a local commit on `feature/harness`. Owner/reviewer: Software Engineer 1 and the human project owner. SWE2 should review the later shared run-event integration, not the internal port in isolation.

The agent-platform skill informed the scoped transfer, failure/approval boundary and explicit integration acceptance gates. Only `harness/` source, tests, package metadata and documentation changed. No shared browser/backend contracts, firmware, deployment, credentials or original experiment artifacts were modified.

## Atomic commit evidence

| Unit | Local commit | Observed acceptance before commit |
| --- | --- | --- |
| Master-0 and typed foundation | `e9cf432` | Strict build and 5 tests; all 3 frozen candidate IDs retained. |
| Master-1 and frozen routing configuration | `953e533` | Strict build and 13 cumulative tests; mocked scorer failover, ambiguity and malformed responses checked. |
| Direct execution, bounded recovery and parity tooling | `8511d16` | Strict type check, 32 cumulative tests and 7 offline original-reference checks passed. |
| Public frozen composition, design/backend handoff and source seals | Commit containing this document | Strict type check, 33 cumulative unit tests, 7 reference checks and 3 freeze checks; staged diff review. |

The fourth unit pins synthesis to the original V8 worker's Sol 6/medium, 8,192 output-token and cross-file settings through a tested factory; it does not change generic client defaults or routing/execution behavior. Git history is the authoritative commit ledger. All four units are local; nothing was pushed, merged or deployed by this transfer.

## Reproducible commands and observed results

Run from the `harness` directory:

```powershell
npm run typecheck
npm test
npm run verify:freeze
$env:FROZEN_JS_REFERENCE = 'C:\Users\17866\Downloads\Adan_Rojas_Workspace_2025\Pear\harness'
npm run verify:reference
git diff --check
```

Observed final checks: strict type check passed; 33 unit tests passed; 7 reference checks passed; 3 source-freeze/public-export checks passed; zero failures. Reference checks validate the original freeze-review hashes, full registry/candidate equality and history, three Master-1 outcomes, and selected/recovered/uncertain/exhausted V8 execution paths. They ignore wall-clock durations and compare stable outputs, evidence, routing/synthesis inputs and resulting file contents. This is bounded differential coverage, not a proof of equivalence for every possible input.

Runtime checks use disposable local fixtures and mocked HTTP. They verify deterministic dependency expansion before one synthesis, current-working-tree reuse after failed patches, no-write approval paths, evidence budgets, final-answer extraction, write-set/traversal rejection and credential-like environment-name stripping. These fixtures run locally, not in Docker; no untrusted repository or live provider was used for the transfer. Dependency installation used locked TypeScript/Node type packages with install scripts disabled and reported zero vulnerabilities at install time.

`verify:freeze` hashes normalized-LF text so a Windows CRLF checkout does not invalidate otherwise identical source. The manifest excludes itself to avoid a self-hash; Git records that file. This is change detection, not a signature/security attestation. `verify:reference` requires the original archive; regular unit/freeze checks do not.

## Historical experiment evidence, not a new benchmark

Original V8 run: `v8-sol6-docker-20261017-a`. The recorded 36 live trials cover 12 authored behaviors across three arms: V8 12/12, Codex CLI 12/12, prior Master-1 initial arm 10/12. Each arm passed all four bounded function implementations. Both natural V8 read-only recoveries succeeded. Original run evidence remains in `Pear/harness/results/iterations/v8-sol6-docker-20261017-a`; it was not copied to this package.

The historical median paired savings versus CLI were 97.1% input tokens, 83.0% estimated cost and 25.0% measured trial wall time. Aggregate input savings were 81.1%, not 97.1%. Warm fallback solved one task at 15.1% more estimated cost than CLI. The historical 36 local tests and 24 benchmark verification checks are distinct from this port's 33 unit, 7 reference and 3 freeze checks.

The original sample does not establish statistical noninferiority, broad repository competence or production readiness. No new live model benchmark, token reduction measurement or Jev connectivity test was performed during this transfer. The owner's approval completes the historical design-review decision; it does not substitute for the backend integration gate. The frozen demo checklist can therefore be marked 10/10 for the accepted original scope, not 10/10 production or integrated-workspace readiness.

## Remaining release gates

Actual backend wiring, file-version/run-lock mediation, non-root owner-container execution, persistent approval/pause/resume, live node-event streaming, cross-owner/reconnect tests and target-language acceptance remain unverified/unimplemented here. Source-transfer completion must not enable the raw fixture writer against a shared workspace. Benchmark gateway/meter/CLI launcher and generated outputs were deliberately excluded; the host must supply a reviewed, metered isolated fallback.

See `BACKEND_INTEGRATION.md` for exact inspected seams and the run-contract mismatch requiring review. No browser, AWS or hardware integration evidence is claimed. Push/PR/release actions still require the owner's authorization.
