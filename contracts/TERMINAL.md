# Interactive Ratatui terminal

Owner: Software Engineer 1 (transport/isolation), Software Engineer 2 reviews Crown integration.
Requirement: embed the existing apps/cli Ratatui interface, not a replacement JSON prompt.
Frozen routing, workspace locks, file versions, approvals and Git ownership are unchanged.

## Additive authenticated Socket.IO contract

- `terminal:open {cols,rows}` -> `{ok:true,id}` or `{ok:false,code:NOT_AVAILABLE|REFUSED}`.
- `terminal:input {id,data}` -> `{ok:boolean}`. UTF-8 input, max 8192 bytes; never replay after an ambiguous acknowledgement.
- `terminal:resize {id,cols,rows}` -> `{ok:boolean}`. 2..500 columns, 2..200 rows.
- `terminal:close {id}` -> `{ok:boolean}`.
- Server `terminal:output {id,data}`: base64 PTY bytes. Client acknowledges only after xterm renders; five-second stalled-render timeout closes the terminal.
- Server `terminal:exit {id}`: close/end notification. Existing `terminal:command` remains backward compatible, but is no longer the browser UI.

The browser connection, authenticated user, immutable room scope and opaque container generation own the terminal. Another tab/user cannot operate it by guessing its id. Opening requires current repository permission. Nested terminal launches from scoped CLI sessions are refused. Room change, disconnect, expiry or transport failure closes the terminal and revokes its capability. Reopen starts a fresh UI and reloads run state; backend agent runs do not stop with the terminal. No input is replayed.

## Sandbox and relay

Supervisor alone accesses Docker. A separate immutable-image, non-root, networkless, read-only container launches only `/usr/local/bin/pineagent`. It has no repository or Docker mount, no provider/GitHub/Auth0 credentials, capped CPU/memory/processes, and a private 16 MB scratch volume. Its maximum session lifetime is fifteen minutes.

The sole host mount is a session-specific read-only directory outside repositories containing a private Unix relay socket and an expiring room-bound backend token. CLI loopback forwards to that socket, which reaches only the local API. All commands still pass normal authenticated backend handlers. No unrestricted shell, writable test mount or registry egress is introduced. Test-container revocations cannot terminate the independent TUI container.

The relay root must be created by systemd for the API user, mode 0700. The supervisor validates ownership and canonical paths. Shutdown revokes credentials before container cleanup; failed container removal is not silently treated as success. Output is capped at 256 KB pending consumption. No terminal contents or credentials are logged. The browser blocks OSC clipboard writes while preserving Ratatui screen controls.

## Gates

Rust format/clippy/tests; authenticated cross-user/stale-room tests; real Docker PTY with real Rust CLI, input/read/resize/exit; responsive Crown/browser regressions; then live sign-in and sandbox repository harness run. Mock-provider success is not live-model evidence. Browser reconnect requires explicit Reopen; general shell/build-cache workflows remain out of scope.
