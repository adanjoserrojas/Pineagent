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
