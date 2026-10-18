# Sandbox host deployment

This service is separate from the unprivileged Pineagent API. The supervisor is
privileged because Docker is privileged; its narrow Unix socket accepts only
bounded execution and interactive-terminal operations and validates paths and mounts. It has
no public TCP listener. Do not add the API user to the Docker group, expose the
daemon over TCP, or mount the control socket into any user container.

Before enabling, human review and deployment approval are required. Install a
reviewed Docker image, pin its local immutable `sha256:...` ID, and configure a
non-root UID for both the API and managed workspace owner (the existing host uses 993).
`/etc/pineagent/sandbox.env` contains only `WORKSPACES_ROOT`, `SANDBOX_IMAGE`, and
`SANDBOX_UID` and `TERMINAL_RELAY_ROOT`; no AWS, Auth0, router or GitHub credentials belong there.
If the existing API system user has a different UID, decide the service identity
and migrate permissions deliberately before deployment—never recursively change
ownership of a broad host directory as a shortcut.

Build `services/api` to produce the separate `supervisor.mjs` entrypoint. Review
the service's Node/Docker paths on the target distro, install the unit, and grant
the API access only to `/run/pineagent-sandbox/control.sock` (0600, service UID).
`RuntimeDirectory` is root-owned and cannot be replaced by the API. On startup
the supervisor removes orphaned containers in its configured root namespace.
It refuses to overwrite an active socket or a non-socket path.

The API installs workspace authority fences before edits or harness runs. The
browser launches the original Ratatui CLI in a separate read-only, networkless
container through authenticated PTY transport (contracts/TERMINAL.md). It has no
repository mount and cannot bypass file versions. General shells and shell-write
reconciliation remain out of scope.

`../package-pty.ps1` builds a clean-commit release and image with checksums.
`install-release.sh` installs both services, checks API and supervisor IPC health,
and restores the previous release on failure. It retains diagnostic/rollback
artifacts. An authenticated deployed browser/provider check is still required;
packaging or health flags alone do not establish end-to-end functionality.

Installer arguments: release SHA, release archive SHA256, image archive SHA256,
image configuration ID, and the explicitly reviewed previous release SHA. It refuses
to proceed if the live release differs, including a change during download. Coordinate
with other deployers before invoking it; this is not a cross-tool deployment lock.
