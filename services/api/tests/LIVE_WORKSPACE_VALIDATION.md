# Live workspace and LLD audit — 2026-10-18

Owner: SE1/runtime and SE2/UI, with project-owner authorization to test, make the
requested UI corrections, commit atomic units and push feature/isolation-harness-sandbox.
Reviewers: project owner and SE2. Hardware is unchanged.

## Observed live workflow

Baseline release: `59f2b1cd5ece`, instance `i-09aa740830e8ae1d1`, us-east-2.
Authenticated browser opened adanjoserrojas/My_App/main as GitHub collaborator
4dandev; another member, adanjoserrojas, was visible. No fixture identity/providers.

- Historical failure `b70edca3-bb26-49aa-af94-54232ae90ea7`: the banking-directory
  request returned `UNSUPPORTED_SCOPE` during planning. One successful Opus plan
  call, zero patch calls, no router selection. This was not a Docker failure.
  The prior Ask answer incorrectly promised new files in Code mode. The answer
  system prompt now states the deployed limitations without changing coding policy.
- Live Code `660d37de-5157-4a59-b20f-af207e4a99bc`: `done`, router `openai`,
  two successful Opus calls (plan and patch), no warm recovery, 6,927 ms server
  receipt. Only app.py changed: split the original title normalization into
  `raw_title = str(data.get("title", ""))` and `title = raw_title.strip()`.
  Browser showed all five steps complete and zero remaining locks.
- Docker event `94e50428ab8bd111893c3c443ae2591b2dbccd0cedce602ebe000a25f21953b4`
  executed `/opt/python/bin/python -I -B /opt/python/bin/pytest -q -p
  no:cacheprovider --basetemp=/tmp/pytest /workspace`, with exit code 0.
  This is the actual full-suite Docker event at the run's completion time, not a
  new fixture replay. The event does not contain a test count; none is inferred.
- Browser opened the original Ratatui CLI. `read app.py` returned a file snapshot;
  `git-status` returned main, ahead=0, only app.py, +2/-1, and the current editor.
- CLI `ask` launched `dc742d4e-14d3-4ed8-b960-c9531996db56`, completed, and
  correctly explained whitespace rejection using the newly edited app.py.
  Browser displayed the same run and read-only answer. No additional files changed.
- Closed only this test terminal. The temporary source refactor was restored through
  the post-deployment Code run below. My_App is clean; no commit/push was performed.

SSM inspection receipts: `eca0df70-b80e-46a8-a037-27f8a855f997` and
`47e82836-3371-4382-bdbb-6fe9cb9546f1`, both Success, exit 0.
Commands checked systemd, Docker version/events, a scoped container inspect,
the two run receipts, and `git diff/status` for My_App. No secrets were read.

## EC2 observations

- m7i.xlarge running with instance profile and role `pineagent-app`.
- Docker 25.0.16; docker, pineagent-api and pineagent-sandbox active.
- Application UID 993, primary GID 992; no Docker group membership.
- Supervisor socket mode 0600; terminal relay directory mode 0700.
- Observed TUI: user 993:993, network=none, readonly root, all capabilities dropped,
  only `/relay` mounted read-only. No repository mount.
- Sandbox image: `sha256:dc0b00f70769d600fb5be40cc4209de74f8876da0a98feb36d75895d82a264ac`.
- Both `pineagent-locks` and `pineagent-files` ACTIVE, keys room/path.
- Health: harness/terminal/interactiveTerminal true, store errors=0.
- Operator inspection used the explicitly authorized local ADAN root profile after
  the unrelated calendar profile was denied SSM access. No IAM changes were made;
  no operator credentials were passed to the app or containers.

## What the CLI is useful for

Ratatui is an authenticated alternative client of the same workspace API. It can
read files, list runs, start Ask/Code, pause/resume owned runs, approve a candidate,
reject with a hint, acquire/release file/directory locks, and inspect Git status.
Commands are `ask QUESTION`, `run TASK`, `runs`, `read PATH`, `lock PATH`,
`unlock PATH`, `pause ID`, `resume ID`, `approve ID CANDIDATE`, `reject ID HINT`,
and `git-status`. See apps/cli/src/lib.rs and contracts/TERMINAL.md.

It is not bash: no arbitrary pytest, npm, pip, git push, or Docker commands.
The server routes Code verification to a separate constrained Docker container.
Browser run controls and CLI share identity, locks, versions and approval gates.
The full LLD's general per-user shell remains unimplemented. Long file snapshots
can overwhelm the CLI's small Results pane; the editor is the better file reader.

## LLD coverage matrix

The preparation diagram is a requirement, not verification. This matrix compares
its twelve sections with source/contracts and the observations above. It does not
certify production readiness or create a new inference benchmark.

| LLD area | Current implementation and evidence | Remaining boundary |
| --- | --- | --- |
| 1. Plan/select/execute | Live Opus planning, frozen Master-0/V8 routes, mediated patch, Docker verification, all-or-nothing in-process write-set acquisition | Existing JS/Python sources and supported tests only; no agent-created files/tests/dependencies, no general tool DAG interpreter |
| 2. Router/recovery | Live OpenAI Decisions; frozen 0.30 margin gate, approval/reassessment and Jev backup covered by source/tests | Original 0.60 placeholder, per-node LLM flow and one-hour score cache were superseded by frozen design; frozen factory disables caching; live outage/fallback drill not performed |
| 3. Locks | Branch/path ownership, directory conflicts, 10s heartbeat, 30s lease, idle expiry, agent-owned files; live run released locks | Single Node authority, not DynamoDB transactional multi-host locking; two-user simultaneous write denial not newly tested live |
| 4. Proposals | No production proposal service/overlay acceptance path found | S3 overlays, mini-PR accept/reject, three-way merge and retry escalation absent |
| 5. File consistency | Server versions, snapshots, mediated edits, reconnect and alias fences; live source diff and CLI snapshot agree | General shell-write watcher/reconciliation absent; no claim that arbitrary commands stay in sync |
| 6. Git | Serialized per-worktree queue, ownership-aware commit, rebase/push and conflict handling in core/tests; live status verified | No live commit/push/rebase drill here; CLI exposes git-status only; original generic git wrapper and automated incoming-remote handling not fully implemented |
| 7. Sandbox | Live Docker tests and isolated TUI; private supervisor; fixed argv, read-only verification and no network | Not the original per-human Linux UID/chown general shell; grants are enforced with mounts/fences; no registry egress or persistent build-cache workflow |
| 8. Authentication | Real Auth0 GitHub sign-in, repo allowlist/collaborator access, backend token broker, mutation authorization | Auth0 flow replaces original custom GitHub App/token-storage design; original webhook/15-minute outage policy and solo repository creation not established |
| 9. Run events | Owner-scoped sequence/state snapshots, reconnect list, read-only viewing of other runs; live browser and CLI match | Runs live in process memory; API restart loses run history/running state; no durable event replay store |
| 10. Physical robot | Existing Web Serial/UI and firmware preserved | No connected robot during this test; physical power/actuator/audio safety and reconnect require hardware-owner evidence |
| 11. Shared context/voice | Branch presence, other users' run visibility, existing robot voice assets | Shared comments, pinned context, versioned workspace memory and full wake-word/voice control flow absent or unverified |
| 12. Cloud/persistence | Running EC2 role/services, two active DynamoDB tables, release bucket/installer, provider receipts in journald | Original Runs/RunEvents/Proposals/Members/Comments/ScoreCache/Users persistence model and full CloudWatch metrics not implemented by the current store |

Evidence anchors: services/api/src/harness/{controller,runtime,python}.ts,
services/api/src/sandbox/{room,host,terminal-host}.ts, services/api/src/dynamo.ts,
packages/core/src/server/{gateway,workspace,store,gitQueue}.ts,
harness/docs/FROZEN_DESIGN.md and contracts/TERMINAL.md. Some older contract
introductions still say mock-only; current wiring and observed live behavior take
precedence as implementation evidence, without implying every original requirement.

## UI correction and verification

Narrow desktop panels (701–900px) can show editor and Agents with an accessible
divider. Wider screens allow up to 800px for Agents when room permits; saved widths
are respected. Phones retain panel navigation. Visible grips improve discoverability.
The plant uses its matching reviewed firmware GIF at up to 240px width, with a static
SVG for reduced motion. Short screens scroll to keep the composer reachable.
Firmware files, Crown tokens, authentication, shared contracts and frozen harness
remain unchanged.

New browser cases first failed on the original code: hidden divider at 820px,
desktop cap=520px, and SVG instead of GIF. After changes, the initial 24-case
focused browser run passed, covering new cases plus Crown/layout/split/runs/terminal.
All workspace typechecks and all three freeze checks passed. Model/Ask tests:
11 passed, one platform-gated skip. After adding short-screen scrolling, all four
agent-workspace cases passed again, including a 390x600 viewport. Desktop/tablet/
phone screenshots were inspected. No horizontal overflow or lost composer draft.

Commands (from apps/web unless otherwise noted):

```text
PLAYWRIGHT_CHANNEL=msedge E2E_MOCK_PORT=3147 E2E_WEB_PORT=5207
node ../../node_modules/@playwright/test/cli.js test agent-workspace.spec.ts crown.spec.ts layout.spec.ts split.spec.ts runs.spec.ts terminal.spec.ts --workers=1
node ../../node_modules/@playwright/test/cli.js test agent-workspace.spec.ts --workers=1
npm run typecheck                       # repository root
npm run verify:freeze -w @pineagent/harness  # repository root
node ../../node_modules/vitest/vitest.mjs run tests/bedrock.test.ts tests/ask.test.ts --maxWorkers=1  # services/api
git diff --check                       # repository root
```

Suggested follow-up requires an explicit design decision: expanding agent creation
and test-authoring changes the frozen write/evidence policy, not Docker installation.

## Production release and final live verification

Release `2480f84a8a08` was built from the committed changes and installed with the
existing checksum-verified installer. Its expected previous release guard matched
`59f2b1cd5ece`; that release remains the rollback target. API and production web
builds passed. The existing sandbox image was reused without modification.

- Application archive SHA256:
  `72e3d93af48e61dfcf72301ad6a36734d948e0d5c43aaca420af2989677a4699`.
- Sandbox image archive SHA256:
  `423545c0cb7aaebbaaab98604fffaeb2cb31b12365fe9076bbc90d451dbf5cd2`.
- Installer SSM `2c754898-6bd0-4ae7-a2ca-47faf535eda9`: Success, exit 0.
  An initial invocation (`3222d667-6820-4163-a1b0-d2e227ad4b29`) stopped at
  `set` because the submitted shell payload had CRLF endings, before modifying
  the host. Normalizing the payload to LF resolved it.
- Final inspection SSM `d023accc-b50e-4d50-9ef7-aa89c18a3221`: Success,
  exit 0; health identified the new release, all three services were active,
  harness/terminal/interactiveTerminal were true and store errors were zero.

In the authenticated production browser, editor and Agents were visible together
at 786px viewport width. The separator changed Agents from 332px to 342px using
the keyboard. The loaded plant source was `/faces/idle-loop.gif`, rendered at
160x85 on the short viewport. The asset contains 96 frames and loops indefinitely.

Post-release Ask `b2ef165b-3b05-4279-92fc-c597fde8dda5` completed with one real
Opus call (3,539 ms), correctly explaining that Code cannot create the requested
banking directory, new classes/files or tests under the current frozen policy.

Post-release Code `3f34db89-b533-411d-8f79-1efa506beb57` restored only the
temporary app.py refactor to its original title normalization. It completed with
OpenAI routing and two successful Opus calls (6,328 ms). The full-suite Docker
pytest execution `7b35d567431bb640706350d5f2d0f52d89a3ae46f2ed0a242e75524f8e88ab2d`
exited 0. Server `git diff --exit-code -- app.py` succeeded and `git status --short`
was empty; the browser showed zero changed files and zero locks. No My_App
commit/push or fixture provider was used. Run history disappeared across the API
restart, confirming the persistence limitation recorded in the matrix above.

Work was isolated in the `pineagent-live-verification` checkout on local branch
`codex/isolation-live-verification`, for an ordinary fast-forward push to the
requested remote `feature/isolation-harness-sandbox`. The original checkout's
uncommitted work was preserved. This document's final receipt update follows the
deployed commit and does not require another deployment.
