# Pineagent CLI (Rust / Ratatui)

The workspace command UI, implemented in Rust with Ratatui and Crossterm. It is a
client of the existing authenticated Socket.IO gateway, not a second harness or
an unrestricted local coding agent. No model API or filesystem write is exposed
by this executable.

## Run

Build with `cargo build --manifest-path apps/cli/Cargo.toml`. The `pineagent` binary
is under `apps/cli/target/debug` (with `.exe` on Windows).

Set `PINEAGENT_URL`, `PINEAGENT_WORKSPACE` (`owner/repo`), `PINEAGENT_BRANCH`, and
`PINEAGENT_TOKEN_FILE`. The last setting names a private file containing a backend
session token accepted by the gateway's authenticator. It is NOT an AWS, GitHub,
Decisions or Jev credential. Never paste tokens into commands, logs or Git.
Remote endpoints require HTTPS; HTTP is allowed only on loopback for local tests.

Run without arguments for the TUI, `--check` for login/run-list verification, or
`--command "run implement sum()"` for one acknowledged request. Escape or Ctrl-C
exits the TUI. Commands include `runs`, `pause ID`, `resume ID`,
`approve ID CANDIDATE`, `reject ID HINT`, `read PATH`, `lock PATH`, `unlock PATH`,
and `git-status`. Approval always requires an explicit command.
Use Page Up / Page Down to inspect run and candidate DAG steps, write sets and
failure details; Home returns to the first run. Very small terminals show a
resize hint instead of an unusable layout.
The interactive result log is a bounded preview (200 lines, 2,000 characters per
line). Use `--command "read PATH"` for the complete JSON file snapshot.

The CLI preserves server ownership and increasing run sequences, bounds its
display/command queues, filters control characters from log output and refreshes
run snapshots on heartbeats. On connection loss, restart it to re-authenticate
and rejoin. It never automatically replays a write after an acknowledgement
timeout. Locks acquired by a one-shot command expire without a heartbeat.

## Verify

- `cargo test --manifest-path apps/cli/Cargo.toml`
- `cargo clippy --manifest-path apps/cli/Cargo.toml --all-targets -- -D warnings`
- Build the binary, set `PINEAGENT_CLI_BIN` to its absolute path, then run
  `npm test -w @pineagent/api -- tests/cli-transport.test.ts`. This exercises the
  compiled Rust client against the real gateway with a fake authenticator and
  harness; it does not call AWS or a model.

## Integration boundary

The xterm.js panel/PTY launcher and restricted container session-token issuance
are separate implementation units. This CLI can connect to a backend directly,
but does not make `noHarness` execute real tasks. Git mutations and arbitrary
shell execution are deliberately not implemented by this client: those must use
the reviewed Git queue and owner-container bridge. Opus 4.6 remains backend-owned.

Refs: LLD sections 3, 5-9; `contracts/RUN_EVENTS.md`;
`contracts/SOCKET_LOCKS_AND_FILES.md`. UI implementation follows the established
workspace's ownership, routing-mode and approval semantics.
