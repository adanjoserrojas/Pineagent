# Sandbox host deployment preparation — not deployed

This service is separate from the unprivileged Pineagent API. The supervisor is
privileged because Docker is privileged; its narrow Unix socket accepts only
open/execute/quiesce operations and validates workspace paths and mounts. It has
no public TCP listener. Do not add the API user to the Docker group, expose the
daemon over TCP, or mount the control socket into any user container.

Before enabling, human review and deployment approval are required. Install a
reviewed Docker image, pin its local immutable `sha256:...` ID, and configure a
non-root UID (1000 or greater) for both the API and managed workspace owner.
`/etc/pineagent/sandbox.env` contains only `WORKSPACES_ROOT`, `SANDBOX_IMAGE`, and
`SANDBOX_UID`; no AWS, Auth0, router or GitHub credentials belong there.
If the existing API system user has a different UID, decide the service identity
and migrate permissions deliberately before deployment—never recursively change
ownership of a broad host directory as a shortcut.

Build `services/api` to produce the separate `supervisor.mjs` entrypoint. Review
the service's Node/Docker paths on the target distro, install the unit, and grant
the API access only to `/run/pineagent-sandbox/control.sock` (0600, service UID).
`RuntimeDirectory` is root-owned and cannot be replaced by the API. On startup
the supervisor removes orphaned containers in its configured root namespace.
It refuses to overwrite an active socket or a non-socket path.

The public API integration must derive grants from locks and call the supervisor
inside the workspace authority barrier. Browser terminal, shell-change
reconciliation and full harness integration are separate activation gates.
No infrastructure, IAM, service installation, or production restart was performed
by preparing these files. Docker isolation probes ran locally only.
