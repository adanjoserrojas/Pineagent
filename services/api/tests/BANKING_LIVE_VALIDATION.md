# Banking feature and Ask failure validation — 2026-10-18

Owner: SE1/backend, with project-owner authorization to test using the existing
signed-in GitHub account. Requested app: a local Python demo with accounts,
deposits, withdrawals, transfers and tests, without real money/external services.
Suggested reviewers: project owner and SE1; SE2 for the Code help-text correction.

## Baseline and supported creation policy

At inspection, production had advanced to `9e0bab595d11` (PR #16), which already
supports bounded new Python/JavaScript files and acceptance tests. Work was based
on remote main `2110f73` in the isolated `pineagent-live-verification` checkout,
local branch `codex/banking-live-validation`. The old existing-files-only finding
in LIVE_WORKSPACE_VALIDATION.md is historical, not the current capability limit.

Current controls include at most 12 explicit write paths and 8 acceptance
criteria; missing-path observations, locks, freshness/alias checks, staged
publication with process-level rollback, immutable existing tests, bounded model
calls, and read-only/networkless Docker verification. Newly published tests also
become immutable during recovery. There is no arbitrary shell, package install,
new cloud resource or credential access. This task did not relax these controls.

## Reported failure and reproduction

Run `855171fb-39ff-4502-9a33-581fa30c1a17` requested a new merge-sort file but
was submitted in Ask mode. Receipt: one Opus answer attempt, `end_turn`,
`MODEL_INVALID_JSON`, phase `read-only answer`, zero executor/router calls.
The exact prompt reproduced the same error as signed-in collaborator `4dandev`
in run `c1588bbe-4cf4-40a1-9088-cf5c446a8c99`.

Raw provider replies were not retained, so their exact formatting defect is not
claimed. The unnecessary JSON envelope is removed from Ask only: final text is
bounded, nonempty and control-character checked, and must have completed normally.
Cancellation, permission/freshness checks, reasoning exclusion and the single-call
budget remain. Coding plans and patches still require strict structured validation.

Regression command from services/api:

```text
node ../../node_modules/vitest/vitest.mjs run tests/ask.test.ts tests/bedrock.test.ts --maxWorkers=1
```

The authenticated Ask integration test first failed (`error`, expected `done`)
with a valid plain-text streamed answer. After the change: 18 passed, one Linux-only
alias test skipped on Windows. Existing malformed coding output still fails closed.
All workspace typechecks, three freeze checks and API/web production builds passed.
The nine browser run cases passed using Edge with isolated ports 3149/5209.

## Banking app created through the live website

Run `8b908cd3-b142-4fc9-915b-ea9717e19cc0` used Code mode, real Opus and OpenAI
routing, creating exactly:

- `banking/__init__.py`
- `banking/accounts.py`
- `banking/test_accounts.py`

The implementation provides `Bank.create_account`, `balance`, `deposit`, `withdraw`
and `transfer`, with integer cents, invalid-amount rejection (including bool),
duplicate/unknown account errors, insufficient-funds rejection, and unchanged
balances after failed operations. It is an in-memory demo, not a financial service.

The initial run **failed** verification after its bounded recovery. Independent
Docker reproduction found `IndentationError` at test line 20: nested `with` bodies
had the same indentation as their parent. The protected test could not be repaired
by the coding recovery. No successful autonomous first-pass result is claimed.

A supervised correction through the normal signed-in editor changed whitespace
only, retaining every test/assertion token. A local non-whitespace equality check
and `ast.parse` passed before applying it. The editor acquired its normal file lock,
saved version 2 and released the lock. No direct server-side repository edit or
agent test-write bypass was used. A separate read-only Docker full-suite run then
reported **38 passed in 0.10s**, SSM `a40be8d2-7d21-49d3-a0a2-4e1d98abf6e6`.

Live Code follow-up `f2669aca-5371-404a-8a92-577af3226542` added a descriptive
Bank class docstring and verified the protected tests. It completed `done` with
one plan, one patch, one OpenAI route, no recovery, and 5,576 ms server receipt.
Both targeted and full verification completed. SSM
`02c3b6da-0212-4453-ac7d-2a96e58d2fca` confirmed no tracked My_App changes and
only the new `banking/` directory. The demo remains uncommitted for owner review;
no My_App commit or push was made.

## Remaining limitations and next design step

Model-authored tests supplement regressions; they are not independent correctness
proof. The first banking run demonstrates a real limitation: generated tests need
a staged syntax/collection check before publication and freezing. A future change
should allow one bounded repair of unpublished test candidates, then freeze them
before implementation recovery. Existing repository tests must stay immutable;
syntax errors must not justify weakening assertions. That extra staging capability
is not implemented by this small Ask/UI fix.

Agent-created files did not immediately appear in the explorer; a browser reload
made them visible. This inventory-notification issue remains open. The banking
demo has no persistence, authentication, concurrency guarantees or real accounts.
No new production-readiness score or inference benchmark was calculated.

## Deployment and post-release check

The two implementation commits are `abf3f2b` (Ask) and `7b63efb` (Code help).
Release `7b63efbad03d` was packaged from the clean committed source, uploaded to
S3, and installed with the existing expected-previous-release guard (`9e0bab595d11`),
checksum verification, deployment lock and automatic startup rollback.

- Application archive SHA256:
  `a9667cb2a7e395a2753e3e96080b659eded41f5d72397572b9c974ce933407e8`.
- Unchanged image ID:
  `sha256:dc0b00f70769d600fb5be40cc4209de74f8876da0a98feb36d75895d82a264ac`.
- Image archive SHA256:
  `423545c0cb7aaebbaaab98604fffaeb2cb31b12365fe9076bbc90d451dbf5cd2`.
- Installation SSM `ca06527f-f362-4390-b3aa-76d52fa8d99a`: Success, exit 0.
  One transient health connection refusal occurred during startup; health recovered.
  Rollback source: `/opt/pineagent/releases/9e0bab595d11`; retained installer
  evidence: `/opt/pineagent/pty-stage.agv9sb`.
- Post-release SSM `96c0e156-ea83-4942-9573-815bf8eb4782`: Success, exit 0;
  all three services active, new release healthy and store errors zero. Banking
  file hashes unchanged across deployment; original tracked files unchanged.
- The S3 `latest.txt` pointer was updated after verification with the previous
  ETag as an If-Match precondition; no unconditional concurrent overwrite.

In the refreshed authenticated browser, the original merge-sort question completed
as Ask run `15949b64-f1bd-4bab-9b66-ca0ee0c76bd2`: one successful Opus answer,
4,790 ms total, zero router/executor calls and no file changes. It correctly directed
creation to Code mode and supplied a read-only example. The updated Code help text
was also observed live. Screenshots and scoped SSM evidence are retained outside
the Git checkout in `pineagent-banking-evidence-20261018`.

This receipt is documentation-only and does not require another deployment.
