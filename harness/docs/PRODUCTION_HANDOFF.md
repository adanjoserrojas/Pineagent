# Feature-building harness handoff

Requirement and owner: Software Engineer 1; owner-authorized branch `fix/harness-production`, based on remote main `ccc3005` with Python validation. Implement bounded features from requirements, including new source files, existing integration points and executable acceptance tests, while retaining deterministic DAG execution. This is production hardening, not certification of unrestricted autonomous development.

Main advanced during implementation. The branch also incorporates `189bceb` (PR #15), preserving read-only Ask, failure phases and failed-attempt accounting. Ask remains one read-only answer call with no router, locks, writes or tests. Its capability description now reflects bounded feature building in Code mode; its prompt receives no coding edit contract. Existing-file coding evidence reuses the stronger handle-identity checks added for Ask.

## Behavior and inference budget

The backend plans a feature, validates its write set, observes existing files and absent creation paths, acquires run locks, routes to one of the same three DAGs, gathers evidence locally, synthesizes the implementation and runs verification. A successful fixture uses one planning call, one router decision and one coding call. A failing implementation can use one coding recovery. Reads, import discovery, hash checks, patch materialization and test execution require no inference calls.

The existing low-confidence behavior remains: one bounded read-only expansion and one reassessment, then owner approval if still uncertain. Provider retries/availability failover are additional requests and appear in routing receipts. Owner clarification can replan once, subject to the same cumulative model budget. There is no new per-tool planning loop, online training or change to DAG IDs/history/routing thresholds.

| Control | Production behavior |
| --- | --- |
| Feature scope | At most 12 write paths; at most 8 acceptance criteria of 500 characters each |
| Evidence | 48,000-character envelope; complete file contents, duplicate removal, run-local read reuse; overflow fails closed |
| Model input | Default cumulative 180,000 characters, including system instructions and failed attempts; 100,000-character serialized input limit per request |
| Coding model | Existing Opus model; default 3 requests total across planning, coding and recovery; at most 8,192 output tokens per request |
| Patch output | Full new files or compact exact edits bound to existing SHA-256 snapshots; no extra model call to materialize edits |
| Verification | Existing read-only Node/pytest Docker validator; 120-second execution deadline; cancellation quiesces the sandbox |
| Accounting | Model and routing receipts include failures, provider usage where available and elapsed time; total provider calls include both ledgers |

Character limits are not exact token or dollar caps. Actual token reduction relative to Codex CLI has not been measured in this revision. Model-generated tests supplement existing regression tests; they are not an independent correctness oracle.

## Changed implementation and interfaces

- `harness/src/`: strict routing score validation, bounded evidence, JS/CJS import discovery, planned file creation, hash-bound edits and bounded fixture execution. Candidate generation and frozen configuration remain unchanged.
- `services/api/src/harness/`: validated feature plans, planned Python files, freshness checks, creation observations, cancellation propagation and receipts. Existing tests are immutable; newly created acceptance tests become immutable during recovery.
- `services/api/src/models/bedrock.ts`: feature planning, structured edits and cumulative input limits, retaining the existing model and authentication mechanism.
- `packages/core/src/server/workspace.ts`: internal missing-file observations and staged patch publication through existing run locks, freezes and version authority. Validate/stage the whole patch before publication; rollback published files if publication fails; reserve persistent versions before publication and never reuse them after a failed attempt.
- `services/api/src/sandbox/room.ts`: abort propagation for verification. No new dependencies, public REST/Socket.IO/device schemas, cloud resources or hardware changes.

Patch publication is a process-level transaction with rollback, not a crash-atomic multi-file filesystem transaction. Failed validation can leave candidate edits in the workspace for review or bounded recovery. New-file modes default to `0600`; existing file modes are preserved.

## Verification evidence

Provider fixtures emit deterministic plans/patches; the resulting Node and Python code is actually executed. Coverage includes empty-repository creation, new module plus existing caller, preservation of regressions, a genuinely failing first implementation followed by repair, and refusal to edit tests during recovery. Adversarial checks cover malformed routing scores, stale hashes/evidence, unsafe paths, concurrent creation, staging failure, publication rollback, non-reused versions, context overflow and cancellation.

Observed on 2026-10-18 using local image `pineagent-cli-validation:python`, pinned to `sha256:c61b476bfb16d014dd0af57c38d438ad84c79be784295df0252246df7c650605`:

- All workspace typechecks passed in Linux Docker.
- Final Linux regression after integrating main: harness 46/46, web 143/143, API 79 passed and 14 optional integration tests skipped; zero failures. Freeze checks 3/3.
- Separate host-driven feature, rollback, write, model and lifecycle suite: 25/25 passed, including both real read-only Docker Node and Python feature integrations. All workspace typechecks also passed on Windows.
- `git diff origin/main --check` passed. The full Windows suite has the platform failures described below.

No live model credentials are used by these tests. Skipped integration tests are not counted as passes; the two new Docker feature cases were run separately as stated above.

```powershell
# Run all workspace checks in Linux, using a read-only source mount.
# Use the locally built, reviewed Node/Python validation image.
$featureImage = docker image inspect pineagent-cli-validation:python --format '{{.Id}}'
docker run --rm --name pineagent-harness-production-checks --mount "type=bind,source=$($PWD.Path),target=/source,readonly" --mount type=volume,target=/work --workdir /work $featureImage bash /source/harness/scripts/verify-linux.sh

# From services/api, run the feature integrations against the existing
# Pineagent validation image (Node and /opt/python pytest).
$env:PINEAGENT_FEATURE_IMAGE = $featureImage
node ../../node_modules/vitest/vitest.mjs run tests/feature-harness.test.ts tests/feature-rollback.test.ts tests/feature-writes.test.ts tests/bedrock.test.ts tests/live-harness.test.ts
```

`verify-linux.sh` installs locked dependencies inside a disposable container volume, then runs all workspace typechecks, tests and the harness seal check. It requires no host credentials or Docker socket. Docker-specific integration cases are exercised separately from the host using `PINEAGENT_FEATURE_IMAGE`.

The pre-merge Windows full-suite run encountered existing platform assumptions: four web symlink-permission failures and two API Unix shell/path failures. Linux is the final full-regression reference; these assertions were not weakened. The added Ask alias tests were exercised on Linux.

## Remaining limits and review

Supported executable feature targets are bounded JavaScript Node tests and Python pytest projects whose dependencies already exist in the sandbox. TS/TSX can be inspected, but this change does not add a TypeScript compiler or framework-specific test runner. Literal import discovery is conservative; dynamic expressions, bundler aliases and export maps are not a general semantic dependency graph. Large evidence sets fail closed instead of silently truncating source.

This revision does not install dependencies automatically, scaffold arbitrary frameworks, deploy applications, run a paid Codex-vs-harness benchmark or establish live model quality. Hardware, browser interaction, AWS rollout and live provider compatibility were not exercised. Existing backend containment is reused; no claim of a new comprehensive sandbox security audit is made.

Suggested reviewer: Software Engineer 1 and the human owner, with Software Engineer 2 reviewing shared workspace version/event behavior. Human review is required before merging. For the demo comparison, pin both arms, repository commits, tasks, limits and independent hidden checks; report success, provider calls, uncached/cached input tokens, output tokens, latency and recovery separately.
