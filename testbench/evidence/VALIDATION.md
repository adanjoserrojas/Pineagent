# Observed validation, 2026-10-18

Owner and suggested reviewer: Software Engineer 1 / release captain.

Requirement: a reproducible paired comparison of the frozen remote-main harness with installed Codex CLI. This handoff covers evaluator implementation and offline validation. **Live model comparison is not complete. No winner or token savings have been measured.**

## Provenance

- Worktree: sibling `pineagent-codex-testbench`, branch `codex/platform/harness-comparison`.
- Draft PR: https://github.com/adanjoserrojas/Pineagent/pull/23 . Created and code pushed before the first Docker invocation.
- Tested testbench commit: `2435beb980060abe42e9649723259a9d79651425`.
- Harness pin: `9076b82b5d126a314b847bd94da842c5ac34e38b`, initially fetched from remote main. A subsequent fetch found main at `3e4937b8af78b6973e70779d4600dc7a4ce17a62`; `git diff 9076b82 origin/main -- harness` was empty. The harness tree is unchanged between them.
- Codex CLI in the container: `0.163.0`.
- Changes are confined to `testbench/`. No frozen harness, shared service contract, hardware, browser or cloud configuration changed. The original checkout's uncommitted work remains untouched.

## Commands and results

| Verification | Observed result |
|---|---|
| `node --test testbench/test/*.test.mjs` | 11 tests passed, 0 failed |
| Calibration assertions within that suite | 16/16 buggy projects fail and 16/16 reference fixes pass |
| `node testbench/src/run.mjs --pr https://github.com/adanjoserrojas/Pineagent/pull/23` | Docker build succeeded, 4 offline smoke trials completed |
| Isolated Docker corpus validation | Both selected buggy tasks fail, both reference fixes pass |
| Smoke grading | 4/4 unchanged buggy workspaces fail, as expected. Zero model requests |
| `docker run --rm --network none --entrypoint node --workdir /opt/harness pineagent-bench:2435beb98006 --test 'dist/test/*.test.js'` | 46 frozen-harness tests passed, 0 failed |
| Container filesystem inspection | No testbench corpus, hidden-test directory, or trial input baked into image |
| Runner/worker `node --check` | Passed |

Raw ignored run directory: `testbench/runs/2026-10-18T10-20-50-127Z-smoke`. Contains the image digest, corpus hash, schedule, grading logs, manifest and records. Sanitized metadata is retained alongside this document. No secrets or model prompt traces are published.

## Remaining work and interpretation

The shell has no exposed OpenAI API key. An existing credential location and authorized live spending cap were requested and remain unanswered. Live access to `gpt-6-sol` Responses and the frozen `gpt-6-luna` Decisions route is unverified. End-to-end live Codex transport and fallback remain unverified.

Run a pilot before selecting a confirmatory sample size. The 16 authored tasks are calibration exercises and do not constitute sufficient evidence of general coding ability. The runner currently supports self-contained Node-test fixtures, not arbitrary repository issues. Token budgets stop between requests/pairs and can overshoot; they are not hard dollar limits. No Jev backup is configured. Containers use ordinary bridge networking for model access; this is not a hostile-code execution service.

For a credible repository-level follow-up, consider the JavaScript subset of [SWE-PolyBench Verified](https://github.com/amazon-science/SWE-PolyBench). Its maintainers describe 100 JavaScript issues and provide frozen instance images. Use its official test-patch evaluator and repository snapshots without exposing gold patches to agents. This requires an adapter and scope-compatibility review; it has **not** been implemented or run here. Preserve the entire prespecified sample, including unsupported tasks, in the coverage report. Public benchmark contamination remains a limitation.

Do not merge before human review. Suggested review focus: metering completeness, grading isolation, proxy failure behavior, fixture scope, and statistical claims. Rollback is removal of `testbench/`; no production behavior was modified.
