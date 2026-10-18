# Read-only Ask and production error correction

Requirement/owner: user-approved read-only repository chat, clear failures, My_App
default, preserved Crown/Ratatui/frozen coding DAG. Owner: SE1; UI review: SE2.
Branch: `feature/python-validator`. Review baseline: user-selected `b98b62e`;
this increment starts after `bfa2849`.

## Changes and contracts

- `run:start` adds optional `mode`; omitted remains Code for existing clients.
  Crown defaults to Ask. Rust adds `ask QUESTION`; `run TASK` stays Code.
- Ask reads at most 12 safe text files / 24,000 source characters, then makes one
  Opus answer call. It cannot select a DAG, acquire ownership, patch, run commands
  or test. It is a single-question answer path, not conversational memory.
- Safe source sampling rejects hidden/generated/credential paths and file,
  directory and hard-link aliases, including previously cached browser aliases.
  Strict workspace reads check opened file identity and bounded contents. They do
  not invoke sandbox fences. Permission, cancellation and snapshot checks reject
  stale answers; answer rendering is plain text.
- Error phase/code and operator receipts distinguish invalid JSON, unsupported
  plans, invalid/out-of-scope patches, incomplete responses, access, throttling,
  timeouts, stale evidence and verification failures. Provider bodies and private
  reasoning are not exposed. Failed synthesis is counted and attributed to
  editing, not the last completed search.
- My_App is the first allowlisted/default picker repository. Existing workspace
  URLs are not redirected. `main` remains the repository branch, not release SHA.
- No frozen harness source/manifests, Crown design document, auth configuration,
  hardware behavior or coding approval/recovery policy changed.

## Diagnosis and live provider evidence

Earlier question/greeting runs were sent into the coding-plan contract, which
requires nonempty writes and an existing test. Empty-write answers were rejected.
The new explicit Ask path avoids that contract; it does not add intent inference
or weaken the coding gate.

Run `62a576de-4e6d-438d-983a-3a5374859df6` reached plan and patch: two Opus attempts,
patch failed validation, no recorded executor model calls because the old counter
only advanced on successful return. The UI incorrectly marked search. The old
receipt does not retain the rejected-response reason, so its exact failure is
unknown. Do not claim a deterministic model-output fix.

Live server-role provider probes previously returned successful OpenAI Decisions
and Jev scoring responses. This increment tested the actual `OpusRun` streaming
adapter from service user `pineagent`, using a disposable public My_App fixture
and the instance role, without applying a patch:

- SSM `0efed492-c347-4535-9373-0804b9b25c6d`: success/code 0.
- Read-only answer: 1,743 input / 84 output tokens; valid bounded answer.
- Coding plan: 113 input / 64 output; `app.py`, verification `test_app.py`.
- Patch: 1,587 input / 652 output; valid `app.py` replacement, not applied.
- All three returned `end_turn`. This did not reproduce the historical rejection
  and is not an accuracy or inference-savings benchmark.
- Initial probe download outside the role's permitted S3 prefix returned 403;
  artifacts were placed under the existing authorized release prefix. No IAM
  permissions changed and no root credentials entered the application.

## Verification

Linux Docker integration runner, public My_App checkout
`f67daea40938c2219a6419afed6b6615f1287d1f`, disposable workspace copies:

- 34 harness tests, 79 API/integration tests, 143 web/core tests: passing evidence.
  The final parallel full run had one existing file-session timing failure;
  the complete web/core suite then passed serially without code/assertion changes.
- Rust formatting, clippy `-D warnings`, 13 tests and build passed in Linux.
  Native Windows compilation hit the pre-existing MinGW toolchain failure; the
  deployed binary is the tested Linux build.
- Typechecks and all three freeze-manifest checks pass. Full increment diff
  under `harness/` is empty.
- My_App test exercises real Rust input/output/resize, authenticated relay,
  gateway and frozen executor. Ask publishes an answer with no file changes,
  patches or tests; Code exercises warm recovery and all five real pytest tests.
  Identity/model/scorer are fixture providers, not live Auth0/Opus.
- Browser: 61 passed, one initial local connection timeout, three real-PTY
  viewport cases skipped. The failed scenario passed unchanged on focused retry:
  62 enabled scenarios have passing evidence, not one all-green full run.
  The optional preview-launch command was denied by the execution environment;
  that browser-to-Docker fixture was not started or worked around. Backend real
  PTY tests cover the current CLI separately.
- Ask desktop/phone screenshots inspected; Crown square surfaces, tokens,
  layout, native radios and original terminal panels retained.

Commands: `npm test`, `npm run typecheck`,
`npm run verify:freeze -w @pineagent/harness`; web serial retry
`node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1`; browser
`node ../../node_modules/@playwright/test/cli.js test --workers=1` with Edge and
isolated mock/web ports 3139/5199. Real Docker runner uses an immutable image ID,
read-only source mounts, disposable fixtures and no provider credentials.

## Standards review

Initial blocking finding: credential exclusions could be bypassed through aliases.
Fixed and reproduced red-to-green on Linux. Follow-up cancellation race fixed.
Final focused independent review found no remaining blocker.

## Spec review

Initial alias defect and subsequent sample-freshness/sandbox-fence concerns fixed.
Final focused independent review found no remaining blocker. Frozen routing and
approval gates remain unchanged.

## Remaining limits / human check

The Codex browser's prior identity lacked My_App write access. The user could not
complete Auth0 sign-in in that browser. Live authenticated browser → My_App →
Opus/scorer → Docker verification remains unverified; no auth bypass was added.
Use the normal browser at pineagent.us, sign in through Auth0's GitHub connection
as a My_App collaborator, then test Ask and a focused Code task. Do not share
credentials. Existing USB recovery risks remain with SE2/hardware; physical
hardware, expanded languages/new-file coding, and production readiness are not
claimed. Reviewers: project owner/SE1, SE2 for the additive UI/contract.

Commits are local for owner review; no GitHub push or PR merge was performed.

## Deployed result

Release `59f2b1cd5ece` deployed to `pineagent.us`, account `004575106238`, region
`us-east-2`, instance `i-09aa740830e8ae1d1`.

- Installation SSM `4c94d728-744a-4eca-982e-bb49a2535844`: success/code 0.
- Release archive SHA256:
  `413da7c698c3970199f146402c2bdc8d15db8ca1643a511111751e04881b82dd`.
- Image archive SHA256:
  `423545c0cb7aaebbaaab98604fffaeb2cb31b12365fe9076bbc90d451dbf5cd2`.
- Deployed image configuration:
  `sha256:dc0b00f70769d600fb5be40cc4209de74f8876da0a98feb36d75895d82a264ac`.
- Expected previous SHA `66c94dd77804` checked before switching. Rollback source
  `/opt/pineagent/releases/66c94dd77804`; retained snapshots
  `/opt/pineagent/pty-stage.w1VV7n`. No rollback needed.
- Public health returns the new SHA, harness/terminal/interactiveTerminal true,
  store errors zero. Deployed web bundle contains Ask and My_App-first ordering;
  preserved `/voice/done.pcm` returns HTTP 200.
- Runtime SSM `0f400265-b456-4ef7-9a9d-f59ddafb661d`: success/code 0. Both services
  active, supervisor enabled; application UID 993 has no Docker group. Relay
  directory 0700, control socket 0600. Exact image starts original Ratatui CLI,
  Flask 3.1.3 and pytest 9.1.1 as UID 993, with no network, read-only root and
  dropped capabilities.

These checks confirm deployment/runtime configuration, not the still-pending live
authenticated browser workflow described above. No new benchmark or readiness
score is inferred from these integration checks.
