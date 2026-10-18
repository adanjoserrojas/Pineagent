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

## Workbench corrections

- Drag the borders to resize Explorer, Agents, Activity and the editor split. Focus a divider and use arrows (Shift for larger steps), Home/End, or double-click to reset its size.
- Collapse Explorer/Agents using their header chevrons, and restore with the left rail. Collapse Activity from its header; restore with the toolbar. Sidebar/activity sizes and visibility persist locally; Reset layout restores defaults.
- Split right or down into two editor groups. Focus a group before opening a file from Explorer. The same file can be open in both groups, with one FileSession and one lock. Closing the second group flushes/releases only files no longer visible.
- A narrow editor area automatically stacks the groups; panes stay mounted when switching mobile panels.
- Individual agent cards collapse while keeping their status and task visible. Approval inputs stay mounted, preserving choices and hint drafts.
- Keyboard shortcuts: Ctrl/Cmd+B toggles Explorer; Ctrl/Cmd+Alt+B toggles Agents; Ctrl/Cmd+J toggles Activity; Ctrl/Cmd+Backslash splits right.
- Recursive 1.085 is bundled locally with its OFL license. The UI uses its proportional/casual forms; Monaco uses a measured monospace setting. Font-ready remeasurement keeps caret positioning aligned.
- Custom SVG/CSS motion adds pineapple leaf movement, opening/closing lock shackles and a real executing-step indicator. All added movement honors reduced motion. Rive MCP reported no open document, so these are not claimed as Rive exports.

UX references: [VS Code custom layout](https://code.visualstudio.com/docs/configure/custom-layout) and [Recursive's official font documentation](https://www.recursive.design/).

## Scope

Changed: App shell, resizable layout state, editor groups, browser-local FileSession view fan-out and open-file lifecycle, CSS/Monaco typography, run disclosure, SVG motion, browser regression tests and optional Playwright browser-channel selection.

Unchanged: session/lock protocol, REST and Socket.IO contracts, server/backend, authentication, firmware, USB bridge and CLI.

The task submission handler also guards offline/pending states for keyboard submission, matching its disabled button.

## Original redesign verification

From the repository root:

```powershell
npm run typecheck --workspace apps/web
npm run build --workspace apps/web
npm test --workspace apps/web
$env:PLAYWRIGHT_CHANNEL = "msedge"
npm run e2e --workspace apps/web -- --workers=2
```

TypeScript and production build pass. The build retains the existing large Monaco-bundle warning.

Unit result: 92 pass; two filesystem symlink tests fail with Windows EPERM before reaching their assertions. No symlink/security behavior was changed or bypassed.

Browser coverage includes desktop/mobile layout, square corners, file navigation, preserved drafts, reduced motion, lock acquisition/release, simultaneous editors, live updates, reconnect/offline recovery, approvals, pause/resume, run restoration and commit ownership. The mock's push tests use local temporary bare repositories, not GitHub.

Observed browser results: all 40 tests passed in the final full run (2.8 minutes), with `PLAYWRIGHT_CHANNEL=msedge` and two workers. New coverage includes pointer/keyboard resizing, persisted layout and minimum sidebar widths at 901px, collapse/restore without draft loss, synchronized same-file split views, independent-file lock release, stacked/mobile splits, local Recursive loading, monospace measurements and reduced-motion behavior.

Two existing assertions now accept LF or CRLF without relaxing the expected edited text. The new Crown test waits for Monaco content before typing.

Visual evidence is generated under test-results/crown-*.png by the Crown browser tests; reviewed screenshots are also saved locally under .shots/. These generated artifacts are not committed.

## Limits and review

Browser verification uses Edge/Chromium with the local mock. Live AWS/Auth0/GitHub, physical robots, Safari/Firefox and the future CLI merge are not verified here.

Review the full branch diff and screenshots before merging. No push, deployment or pull request was performed.

Worktree: ../pineagent-redesign on feature/redesign. Another session switched the original checkout during validation; the first theme commit was copied from b98b62e to this branch as 8305993. The other session's branch was not reset or rewritten.

## Merge repair: fix/crown-ui

Requirement/owner: restore the approved Crown workspace after PR #9's merge while retaining newer workspace features; Software Engineer 2 and the project owner review this repair.

Reference: `6d0ddde` (`backup/crown-before-repair` / `redesign/v3`). Repair starts from `9cf06d9`, not by reverting main or overwriting the entire web application.

- Fixed missing React/Avatar imports and disconnected file-creation wiring.
- Composed the newer tab and image-view components inside Crown's resizable editor groups. Toolbar splits duplicate the focused file using the existing shared FileSession; the tab-bar Split action opens an empty second group. Explorer reveals existing tabs; closing the last tab removes its group.
- Restored profile-card and commit-button styles with Crown tokens and square edges. Retained ownership, approval, Recursive, animations, panel persistence and responsive collapse behavior.
- Browser test helpers now handle collapsed folders and mobile panel navigation. No backend, CLI, authentication, shared contract, or hardware files changed.

Unit verification: `npx vitest run --maxWorkers=1` from `apps/web`: 117 passed, four Windows EPERM symlink-fixture failures before assertions. Earlier parallel runs had timing failures; serial verification cleared those. Symlink behavior was not modified or bypassed.

Browser verification: the full 56-test run passed 54 tests. Two legacy mobile assertions expected the pre-Crown stacked-panel layout; updated them to navigate to Files before measuring its scroll area and to check split stacking below Crown's 560px editor-width breakpoint. Both passed in a focused rerun. No application code changed after the full run. All 56 scenarios therefore have passing evidence across these runs (not a single all-green full run).

Commands from `apps/web`, with `PLAYWRIGHT_CHANNEL=msedge`, `E2E_MOCK_PORT=3111`, and `E2E_WEB_PORT=5184`:

```powershell
npx playwright test --workers=2
npx playwright test --last-failed --workers=1
```

Production build/typecheck: `npm run build --workspace apps/web` passed, retaining the Monaco chunk-size warning. `git diff --check` passed. Desktop, phone and split-view screenshots were inspected and saved locally under `.shots/` (ignored).

Review preview: `http://127.0.0.1:5175/ws/crown-repair-review/main?as=adan&api=http://localhost:3112` uses an isolated local mock, not live services. The repair is committed locally only; pushing and merging remain with the project owner after review. The original backend checkout was not modified. Live cloud/auth/device behavior and the future CLI integration remain unverified.
