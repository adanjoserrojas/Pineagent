# Crown workspace handoff

Requirement: implement the selected Crown redesign with square edges, without changing collaborative editing or agent contracts. Owner/reviewer: Software Engineer 2 and the project owner.

## Design and behavior

- Forest-graphite surfaces, citron primary actions, and an angular pineapple mark.
- Square application surfaces, buttons, inputs, avatars, badges and dialogs. Native radio controls retain their standard semantics.
- Desktop navigation rail, explorer/presence, Monaco editor and agent column. Below 900px, panel controls switch visible surfaces without unmounting the editor or discarding a task draft.
- Ownership is explicit: blue for your lock, amber for another person, lavender for agents. The existing recovery banner, copy action and release/pause actions remain available.
- Branch activity is a current-state snapshot from existing locks, runs and Git queue data, not an event-history service. Disconnected snapshots are labelled last-known state.
- Compact existing plant faces, numbered run steps, approval choices and a bottom composer. Motion respects reduced-motion preferences. No new animation runtime or UI dependency.
- CLI integration is intentionally untouched. No placeholder terminal commands or simulated live activity were added.

## Scope

Changed: App shell, shared CSS/Monaco colors, editor presentation, RunPanel presentation, UI-only CrownMark/WorkspaceIcon/BranchActivity components, browser regression tests and optional Playwright browser-channel selection.

Unchanged: session/lock protocol, REST and Socket.IO contracts, server/backend, authentication, firmware, USB bridge and CLI.

The task submission handler also guards offline/pending states for keyboard submission, matching its disabled button.

## Verification

From the repository root:

```powershell
npm run typecheck --workspace apps/web
npm run build --workspace apps/web
npm test --workspace apps/web
$env:PLAYWRIGHT_CHANNEL = "msedge"
npm run e2e --workspace apps/web -- --workers=2
```

TypeScript and production build pass. The build retains the existing large Monaco-bundle warning.

Unit result: 90 pass; two filesystem symlink tests fail with Windows EPERM before reaching their assertions. No symlink/security behavior was changed or bypassed.

Browser coverage includes desktop/mobile layout, square corners, file navigation, preserved drafts, reduced motion, lock acquisition/release, simultaneous editors, live updates, reconnect/offline recovery, approvals, pause/resume, run restoration and commit ownership. The mock's push tests use local temporary bare repositories, not GitHub.

Observed browser results: the full 34-test run passed 33 tests; its new offline-emulation test did not establish a disconnected WebSocket. After replacing that setup with a private mock-server restart, all four Crown tests passed in a focused rerun. Thus all 34 scenarios have passing evidence across these runs. The final focused command was `npx playwright test --workers=1 crown.spec.ts` with `PLAYWRIGHT_CHANNEL=msedge`.

Two existing assertions now accept LF or CRLF without relaxing the expected edited text. The new Crown test waits for Monaco content before typing.

Visual evidence is generated under test-results/crown-*.png by the Crown browser tests; reviewed screenshots are also saved locally under .shots/. These generated artifacts are not committed.

## Limits and review

Browser verification uses Edge/Chromium with the local mock. Live AWS/Auth0/GitHub, physical robots, Safari/Firefox and the future CLI merge are not verified here.

Review the full branch diff and screenshots before merging. No push, deployment or pull request was performed.

Worktree: ../pineagent-redesign on feature/redesign. Another session switched the original checkout during validation; the first theme commit was copied from b98b62e to this branch as 8305993. The other session's branch was not reset or rewritten.
