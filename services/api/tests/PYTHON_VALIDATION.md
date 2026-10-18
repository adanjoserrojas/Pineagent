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
