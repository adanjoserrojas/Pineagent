# Submission run failures and task viewport — 2026-10-18

Requirement: inspect reported run failures, make the task viewport resizable, and
show only the latest request. Owners/reviewers: SE1 for model boundaries, SE2 for
UI, project owner for release review. Existing authorization covered isolated
implementation, atomic commits, feature-branch push and S3/EC2 deployment.

## Failure evidence and correction

SSM `c127e5d9-7a7a-4e16-8786-58208a803593` inspected only the named run receipts.

- `d6c3e682-201d-47b3-8174-fb2e3a5236ed`: Ask, `MODEL_INVALID_JSON`, one
  completed Opus answer attempt, no router/executor calls. It predates the plain-text
  Ask fix deployed in `7b63efbad03d`; see BANKING_LIVE_VALIDATION.md.
- `aed5d9ed-ed0f-4a9e-8872-195c8057f3e3`: Code, `MODEL_INVALID_PLAN`, one
  plan attempt, no router/executor calls. Historical raw model output was not retained.

Read-only model probes used the application instance role, current repository file
inventory and the exact task: `Modify accounts.py by adding a method that performs
1 + 1`. They invoked planning only, without locks, patches or test execution.
Both baseline repetitions proposed writing `banking/test_accounts.py`, triggering
`Existing verification files are immutable`. An explicitly qualified control asking
for separate new coverage succeeded. SSM: `b456fdd1-a91c-4023-adab-6a556a7c2424`.
This reproduces the reported failure code but does not reconstruct the lost historical
output. An earlier probe upload under the diagnostics prefix could not be read by
the EC2 role (403); it did not execute. The existing allowed releases prefix was used
without changing permissions.

The planner now receives an explicit protectedTests list and a write policy:
existing tests may be selected for verification, never included in allowedWrites;
new coverage must use a separate new file and acceptance criteria. A rejected
existing-test write now returns safe `MODEL_PLAN_TEST_WRITE` guidance. The validator,
authority boundary, inference call budget and routing remain unchanged. No silent
plan rewriting or automatic retry was added.

With this change, both exact-task repetitions and the control were accepted, with
separate new tests. SSM: `eb6dbe9d-96cf-45c1-b1c3-f26a4af6b0d0`.
These are a small targeted reproduction, not a general model-reliability benchmark.

## Live authenticated retry

On initial release `7ecf415a5835`, signed-in collaborator `4dandev` submitted the
exact original Code task. Run `a7889aa4-ef14-496a-8ac0-42310ffb5ebe` completed:

- Opus planning + patch: two calls; OpenAI routing: one call; no recovery.
- Wrote `banking/accounts.py` and new `banking/test_add_one_plus_one.py`.
- Added `Bank.add_one_plus_one`, returning integer 2, with tests for class/instance
  invocation and preserved banking operations.
- Targeted and full Docker verification succeeded; total run time 8,724 ms.
- No manual repair was needed. Existing `banking/test_accounts.py` retained SHA256
  `4a06ccdf112357dee83554edc059c0c60b3c54b33508aa2b3c87af4043a12fd7`.
- Independent full-suite verification in the same read-only, networkless image
  reported **76 passed in 0.14s**. SSM `0032299f-6961-416c-bc4a-6f6e327e6993`
  succeeded and confirmed all services healthy, store errors zero.

The demo changes remain uncommitted in My_App for owner review. The user's sorting
files and other work were preserved; no My_App commit/push was performed.

The exact Ask task (`can you implement a function that adds 1 + 1 in test_app.py`)
completed as `38c63f3a-e265-4b17-9d95-6a21e90ff9f8`, without JSON failure, but
still incorrectly promised that Code could edit the existing test. A follow-up
correction gives Ask explicit protected-test paths from its bounded evidence sample
and the same prohibition, including appending to a test. A real Opus read-only probe
then correctly said the existing test is protected even in Code and suggested new
source/new coverage. SSM `a9c21a61-0b3b-4397-bfcd-65eeb2c8b631` succeeded.

## UI behavior

- Only the latest own request is rendered, or the latest teammate request if the
  user has no requests. Older server runs are not deleted; other users cannot
  displace the user's newest request. The task viewport resets scroll on a new run.
- Task view defaults to 300px and resizes from 180–900px using the horizontal grip,
  pointer drag or arrow keys. Height persists; Home/End set bounds and double-click
  resets. The existing horizontal workspace resize remains available.
- The prompt input now resizes vertically from 96–480px. Short screens scroll to
  preserve access to the composer and Start run, without discarding the draft.
- Live keyboard resizing changed 300px to 310px. Submitting a second request left
  exactly one rendered article. Local screenshots were reviewed.

No Crown tokens, robot/firmware behavior, shared run-state schema, frozen DAG/routing,
Docker permissions, cloud roles or credentials were changed.

## Automated checks

```text
# services/api
node ../../node_modules/vitest/vitest.mjs run tests/bedrock.test.ts tests/ask.test.ts tests/feature-harness.test.ts --maxWorkers=1
# apps/web, PLAYWRIGHT_CHANNEL=msedge E2E_MOCK_PORT=3151 E2E_WEB_PORT=5211
node ../../node_modules/@playwright/test/cli.js test agent-workspace.spec.ts runs.spec.ts --workers=1
```

Final API result: 25 passed, 3 skipped (two optional Docker fixture integrations
and one Linux-only alias case on Windows). The live EC2 Docker tests above are
separate evidence. Browser: 15 passed, covering resize by pointer/keyboard, saved
height, draft retention, narrow screens, latest-only after reconnect, teammate
isolation, approvals, pauses, routing and plant behavior. Web/API typechecks and
production builds passed. `git diff --check` passed. Existing Monaco chunk-size
warnings remain.

## Final release and browser confirmation

- Release `93c12b634c5f`, archive SHA256
  `4a7b32c637bb75f374f90e7361bb27c5dbd4a5d21c3e49b5b5dcb6496779d2d2`.
  Docker image unchanged:
  `sha256:dc0b00f70769d600fb5be40cc4209de74f8876da0a98feb36d75895d82a264ac`.
- Original checksummed installer, deployment lock and expected-previous guard used.
  SSM `3339fe01-6d66-4e67-96a8-2846c6388ece` succeeded (exit 0), retaining
  rollback source `/opt/pineagent/releases/fbad0ddaf55a` and stage
  `/opt/pineagent/pty-stage.p6qQ9B`. One startup connection refusal recovered within
  the installer's readiness loop. Prior intermediate deployment SSM
  `077d3988-3878-4ccd-876f-af1e68911e48` also succeeded.
- Intermediate live Ask `ff99fbc8-d37e-4542-98df-97ed0f7d7a6f` correctly explained
  protection but reused a sampled test basename. The final prompt also instructs
  the model to check example names against evidence. Tests/typecheck/build reran
  successfully after that adjustment.
- Final exact Ask retry `9d112bf8-6335-4b68-9bc2-8cddc673015c` completed in
  3,448 ms: one Opus answer, zero router/executor calls, no writes or recovery.
  It explicitly said `test_app.py` is protected even in Code mode and suggested
  separate new coverage. Example filenames remain model advice; the coding
  planner and validator check actual paths before authorizing writes.
- SSM `b704567e-7f7b-4794-9e6a-5a7a36e149fa` confirmed that receipt, healthy
  final SHA, Docker/API/sandbox active and zero store errors. The public health
  endpoint agreed. Saved task height remained 310px after refresh.
- S3 `latest.txt` was conditionally updated from ETag
  `89c4515550ca122121abfdf61733f76b` after verification, then downloaded to confirm
  `93c12b634c5f`. New ETag: `2cba099955634dd8b65e5af85904287b`.
- Local screenshots and operator artifacts are retained outside the repository in
  `pineagent-submission-evidence-20261018`; `final-task-view.png` shows the latest
  completed request and resize grip. No credentials are included.

## Limits

Model-authored tests are not independent correctness proof. New-test syntax staging
and immediate explorer notifications remain follow-ups from BANKING_LIVE_VALIDATION.md.
Run history remains process-local and is lost on API restart. Only the newest request
is shown; earlier runs remain accessible through the API/CLI while the process lives.
Avoid launching overlapping runs during the submission demo. No production-readiness
score or broad claim that every model request now succeeds is made.
