# Rust CLI implementation handoff

Requirement: Rust + Ratatui workspace command UI, using the backend contracts
from LLD sections 3 and 5-9. Owner: Software Engineer 1; terminal UI work explicitly
authorized by the project owner. Review baseline: `1abe75b` on `git-queue`.

## Delivered boundary

`apps/cli` contains the Rust client, reproducible lockfile, Linux validation image,
rendering/state tests and usage instructions. `services/api/tests/cli-transport.test.ts`
exercises the compiled executable against the real Socket.IO gateway. Shared event
schemas and frozen V8 routing are unchanged. Server-side identity, approval checks,
locks and versions remain authoritative; the CLI has no local write/model tool.

## Observed verification

- `docker build -t pineagent-cli-validation:git-queue apps/cli`: passed on Linux
  with Rust 1.88, `cargo fmt --check`, strict Clippy, 10 Rust tests and binary build.
- In that image, a read-only source mount was copied to an ephemeral test directory;
  `npm ci --ignore-scripts` then `PINEAGENT_CLI_BIN=/usr/local/bin/pineagent npm test`:
  **117 passed** (92 web/core; 25 API, including all 6 Rust integration tests).
- `npm run typecheck` and `npm run build -w @pineagent/api`: passed.
- A real Linux PTY exercised interactive input, lock acquisition, slow snapshot
  replies, independent lease renewal and clean alternate-screen restoration.
- Tests use fake authentication and a fake harness, real Socket.IO transport,
  temporary Git repositories and synthetic model streams. No AWS/model calls,
  deployment, hardware changes or production-container security claim.
- Native Windows GNU compilation is blocked by the machine's incompatible MinGW
  `dlltool`. Linux Docker is verified; native Windows requires a working Rust
  linker/toolchain and has not been verified.

## Standards review

No hard ownership, secret-handling or shared-schema violations found in this
scoped change. Two correctness findings were corrected before commit:

1. Heartbeats could wait behind command/list replies. Renewal now has its own
   worker; the PTY regression delays normal responses beyond the test lease.
2. History eviction could hide an active approval. Completed history is now
   evicted before active/owned approvals, with a regression test.

The preceding workspace hardening is partial: spelling and run-owner checks do
not establish physical-file isolation across symlink/hardlink/case aliases.
That remains a release gate before real harness/shell writes.

## Spec review

No blocking mismatch for the thin CLI. Candidate DAG actions/write sets and
scores are visible; approvals are explicit; sequences are monotonic; routing and
coding recovery are separate. Ownership-denial propagation is now covered by an
integration test (the harness fixture returns `NOT_OWNER`). The interactive log
is a bounded preview; one-shot `read` returns the full snapshot, as documented.

Review summary: two standards correctness findings fixed; one spec verification
gap closed and one display limitation documented. Human review remains required.

## Bugs caught by integration

The Rust library's `connect()` returns before Socket.IO authentication completes;
waiting for its `open` callback prevents dropped room joins. Its acknowledgement
callbacks wrap a JSON argument array differently from ordinary events; decoding
those separately prevents false access denials. Both have regression coverage.

## Remaining larger-plan gates

Browser xterm/PTY integration, restricted sandbox session-token issuance, the
per-user sandbox supervisor and filesystem enforcement, real harness factory /
approval continuation, cross-run cost admission, and live Opus 4.6 access are
not delivered by this CLI unit. The model adapter is preparatory and not wired
into `main.ts`. `noHarness` still returns `NOT_AVAILABLE` for execution.

Suggested reviewers: project owner and SWE1 for authority/model boundaries;
SWE2 for command workflow and future browser-terminal integration. No PR or
deployment is created by this handoff.
