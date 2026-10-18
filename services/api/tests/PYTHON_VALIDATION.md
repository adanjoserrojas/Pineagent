# Python adapter verification

SE1, 2026-10-18. Source: public My_App commit
`f67daea40938c2219a6419afed6b6615f1287d1f` (read-only clone; no remote changes).

`my-app-e2e.test.ts` copies the five relevant original files into a disposable Linux
workspace. Removing title trimming produces a genuine failing original test.
Authenticated Socket.IO terminal input enters the real Rust Ratatui CLI, which starts
LiveHarness through the private room-scoped relay. Real Master-0/V8 execution uses
mocked model/scorer boundaries only. The first patch fails; the existing warm fallback
receives its current files and pytest failure, restores the source, and passes all
five original tests. The test asserts three provider attempts (plan + patch + recovery),
two version increments, unchanged test content, owner identity and released locks.
This is integration evidence, not a Python accuracy/inference benchmark or live-model proof.

Observed: 5/5 tests passed across `my-app-e2e.test.ts` and `room-sandbox.test.ts`,
including actual Docker Node regression, pytest shadow-module rejection, and zero-test
failure. The image builds the original CLI: 11 Rust tests, format and Clippy checks pass.
Python/Flask/pytest dependencies are pinned in `apps/cli/python-requirements.txt`,
installed at build time only, with binary wheels and dependency validation.

To reproduce: build `apps/cli/Dockerfile` targets `validation` and `integration`.
Use only `validation` as the immutable `PINEAGENT_SANDBOX_IMAGE` ID. The integration
runner needs a read-only source checkout and My_App checkout, a Docker-host-visible
named volume mounted at its identical absolute host path, and access to Docker.
Set `MY_APP_SOURCE`, `PINEAGENT_PTY_ROOT` and `TMPDIR` to the relevant paths; set
`PINEAGENT_CLI_BIN=/usr/local/bin/pineagent`. Install npm dependencies into a separate
writable/executable test directory and run the two tests through `@pineagent/api`.
The integration runner is trusted test infrastructure, never a deployed user sandbox.

Production tests retain: non-root identity, no network, read-only workspace/root,
hidden Git metadata, no credentials/Docker socket, fixed argv and timeout. pytest is
loaded from its trusted installed entry point with an isolated interpreter; a local
`pytest.py` cannot replace it. Application tests still execute untrusted code inside
that sandbox. Missing dependencies and unsupported languages fail closed; no installs
or arbitrary shell commands are inferred. Python unittest/build systems and dynamic
import discovery are not claimed. Crown and the original Ratatui source are unchanged.

## Release checkpoint

- Full Linux suite: harness 34/34, web 121/121, API 71/71 (including real Docker,
  CLI, PTY and My_App); workspace typechecks and three freeze checks passed.
- Browser: 59 ordinary workspace tests passed in the complete 62-test run. Its
  three real-terminal tests failed because the old preview fixture referenced a
  Docker image ID removed when its tag was rebuilt. After moving the fixture to
  the pinned Python image, all three passed (390/900/1440px). No product/test
  assertion was weakened. Earlier focused 19-test browser run also passed.
- Two independent read-only reviews found no remaining blocker after fixing
  Node search isolation and trusted pytest loading.
- CloudFormation `PineagentModelAccess`: CREATE_COMPLETE, exactly three additive
  IAM policies on the existing role. No new users, keys or host infrastructure.
- One live Opus request from the EC2 `pineagent-app` instance role succeeded
  (20 input / 32 output tokens). It reached the intentionally tiny token limit;
  this proves invocation access only, not a completed coding/gateway run.
- Release `4b88474d557f` and its image were built/checksummed and staged in the
  existing private release bucket. The application was NOT switched.
- Deployment blocker: live health changed from `5b6e8f861436` to `f9c7f0d9de20`
  during this work. That new commit was unavailable locally. Owner coordination
  is required before replacing/integrating another engineer's release.
- GitHub sign-in in the opened Pineagent tab is still needed for the authenticated
  deployed My_App/Opus/scorer/terminal test. No live approval gate was bypassed.

Rebuild the final reviewed commit after resolving release ownership; the later
installer safety guard requires the expected previous SHA explicitly. No branch
push, PR, merge, or GitHub change to My_App was performed by this session.

## Deployed-version integration (2026-10-18)

The owner authorized integrating deployed `f9c7f0d9de20f293acccc453dca7895740ed12ca`
before continuing deployment. This brings in the existing USB/voice browser bridge,
its firmware source, prerecorded voice assets and shared-file import repair. The
only merge conflict was equivalent import ordering in `workspace.ts`; both sides'
behavior is preserved. No device was flashed and no hardware topology changed.

The integration itself changes no harness source/manifests, Python adapter,
sandbox, authenticated PTY, original Rust CLI or shared workspace contracts.
Merged Linux verification: harness 34/34, web 143/143, API 71/71; all workspace
typechecks and three frozen-manifest checks pass. Actual Docker/CLI/My_App tests
were enabled, not skipped. These remain mocked-provider integration tests.

Merged browser verification: the complete 64-test single-worker Edge run passed
63 tests; one long split-editor scenario exceeded its existing 30-second limit.
An unchanged focused rerun passed in 13.3 seconds with the same timeout and
assertions. Thus all 64 scenarios have passing evidence across these runs, not
one all-green full run. The real Ratatui input/resize/exit tests passed at
390/900/1440px. Desktop/mobile Crown and desktop Ratatui screenshots were inspected.
Commands: `node ../../node_modules/@playwright/test/cli.js test --workers=1`, then
`test split.spec.ts --grep "split groups synchronize" --workers=1`; run from
`apps/web` with `PLAYWRIGHT_CHANNEL=msedge`, `PTY_BROWSER_API=http://localhost:3312`,
`E2E_MOCK_PORT=3139`, `E2E_WEB_PORT=5199` and the isolated Docker preview fixture.
An initial npm-wrapper invocation ignored the requested worker limit; that run
was stopped and is not counted as verification evidence.

Independent standards/spec reviews found no harness/PTY/Python preservation
blocker. Two pre-existing incoming USB reliability issues remain with the UI /
hardware owner: disconnect during delayed reconnect can reopen the port, and a
late reply after timeout can acknowledge the next command. They are not repaired
by this integration and physical USB recovery is not claimed verified. Browser
mock tests cannot establish physical-device safety or reliability.

The signed-in production browser identifies `4dandev` and reports no access to
Pineagent. An authorized GitHub collaborator session for My_App is required for
the live authenticated provider test; authorization will not be bypassed.

## Integrated deployment result

Release `66c94dd77804` was deployed to `pineagent.us` in account `004575106238`,
`us-east-2`, on instance `i-09aa740830e8ae1d1`. SSM installation
`7bc2de09-361c-4556-99db-128adee8c3c1` completed successfully (response code 0).
The installer checked expected previous release `f9c7f0d9de20`, both artifact
hashes, portable image configuration ID, API health and private supervisor IPC.
No rollback was needed; the prior release and installation snapshots remain at
`/opt/pineagent/releases/f9c7f0d9de20` and `/opt/pineagent/pty-stage.3vpGaF`.

- Release archive SHA256: `0a7b03d871577aff792e2b4438de42eb7aac829b65f5415ff714546e7898d6f6`.
- Image archive SHA256: `de0107a395e6fee6c3317aa7a179f20648b46176e9c76deda6a2cf618e80b125`.
- Image configuration: `sha256:cd6a74e286ec5ad483d7855f5a57a582f08a288a92dc1bca7796abdc32ba602e`.
- Live health: correct release SHA, `harness`, `terminal`, `interactiveTerminal`
  true, store errors zero. The preserved `/voice/done.pcm` asset returns HTTP 200.
- Runtime verification SSM `5e599730-e20e-4038-8e3d-cf7b72eafea7`: success/code 0.
  Both services active, supervisor enabled, relay directory mode 0700, private
  control socket 0600. API user 993 is not a Docker-group member. The exact deployed
  image launches Flask 3.1.3/pytest 9.1.1 and the original Rust CLI as UID 993 with
  no network, read-only root, dropped capabilities and bounded resources.
- API startup successfully loads configured router secrets using the instance
  role; this does not prove a successful Decisions/Jev scoring request.

The refreshed production browser is signed in as `4dandev`; opening the explicitly
authorized My_App repository reports **No access to this repository**. Therefore
the live authenticated Ratatui/My_App/Opus/scorer run remains unverified. The owner
must grant that account collaborator/write access to `adanjoserrojas/My_App` or
sign in as an authorized account, then retry. No auth bypass, live coding run,
approval override, GitHub push or hardware flash was performed.

Reviewers: project owner / SE1 for deployment and Python integration; SE2 and the
hardware owner for the recorded incoming USB recovery risks. Local branch commits
remain unpushed for owner review. This deployment is not a claim of production
readiness or a new inference/accuracy benchmark.
