# Production deployment: 2026-10-18

Owner: Software Engineer 1. The project owner explicitly requested uploading the validated harness release to S3 and deploying it to EC2. Deployed source commit: `9e0bab595d1130a5779fae663bfc202a6d85c94d` on `fix/harness-production`. This receipt is a documentation-only follow-up; it does not require another deployment. PR #16 remains a draft; deployment did not merge the branch.

## Target and release artifacts

- Site: `https://pineagent.us`; AWS account `004575106238`, region `us-east-2`.
- Instance: `i-09aa740830e8ae1d1` (`pineagent-app`, m7i.xlarge), online in SSM.
- Release bucket: `pineagent-releases-004575106238`.
- Application: `releases/9e0bab595d11.tgz`, 7,982,747 bytes; SHA256 `cfe6c07206fd5faf28334ef2959a98b510d1ccd2011a1c3825bbadf0584f5728`.
- Unchanged sandbox archive copied server-side from `releases/2480f84a8a08-image.tar` to `releases/9e0bab595d11-image.tar`; SHA256 `423545c0cb7aaebbaaab98604fffaeb2cb31b12365fe9076bbc90d451dbf5cd2`.
- Unchanged image configuration ID: `sha256:dc0b00f70769d600fb5be40cc4209de74f8876da0a98feb36d75895d82a264ac`.
- Existing `infra/sandbox/install-release.sh`, normalized to LF, uploaded as `releases/9e0bab595d11-install-release.sh`; SHA256 `1d1d21fda1009e3e04631c619c6d4ad20b3333d0bf68fefaab7792a963d4d34e`.
- `latest.txt` now contains `9e0bab595d11`, updated only after live verification with an ETag precondition to avoid overwriting a concurrent update.

The unrelated default calendar AWS profile lacked deployment inspection permissions. The existing ADAN operator profile was used for S3/SSM. No credentials were read into output or embedded in artifacts, and no IAM changes were made. The application continues using its existing `pineagent-app` instance role.

## Build and installation evidence

The source worktree was clean. `npm.cmd run build -w @pineagent/api` passed, producing server and supervisor bundles. The production Vite build passed using `infra/deploy/production.env`; existing large-chunk warnings remain. Packaging followed `infra/package-pty.ps1` configuration, reusing the previously deployed sandbox archive rather than rebuilding it. All 145 archive entries were restricted to application/web/config/service artifacts. Linux `node --check` passed for both bundles; `bash -n` passed for the installer.

Preflight SSM `1bbd3c4a-a97c-4b32-abe4-b25f0875d3f3` succeeded: previous release `2480f84a8a08`, all services active, zero store errors, no running sandbox containers and sufficient disk space. The installer ran under `flock`, retained its expected-previous-release guards, verified all three checksums and kept automatic rollback enabled during startup.

Installation SSM `2b8c9397-4dcc-4272-93bd-b8dcea0ec7bb`: **Success, exit 0**. Its health polling saw one expected connection refusal while the service started, then succeeded. Installed path: `/opt/pineagent/releases/9e0bab595d11`.

Rollback source remains `/opt/pineagent/releases/2480f84a8a08`; previous service/configuration snapshots are retained in `/opt/pineagent/pty-stage.DU1CiL`. No rollback was needed. No user repository files, hardware, authentication settings or permissions were changed by this deployment.

## Post-deployment checks

Verification SSM `86dc460c-5b62-4898-b49a-1441922d62a9`: **Success, exit 0**.

- API, sandbox supervisor and Docker active. Both Pineagent services reported zero automatic restarts.
- Public and local `/health`: `ok=true`, `sha=9e0bab595d11`, GitHub/harness/terminal/interactiveTerminal enabled, store errors zero. Public health remained healthy more than a minute after startup.
- Supervisor Unix-socket health, queried as the application user: `ok=true`, protocol `pty-v1`, terminal enabled.
- A read-only, networkless container using the deployed image and UID 993 imported pytest successfully.
- Public `index.html` SHA256 matched the packaged web build.
- An unauthenticated production WebSocket connection was rejected with `UNAUTHENTICATED`.
- Deployed bundle hashes match local build artifacts: server `deca12c72d0fdf08d6edb26f6295d618e13fb0f2e96d5cb7cc4a04cf4ec084ae`; supervisor `12b9170e540edc7f35e15f09f28e5ce52221c4db2c832c04090501033ee2272b`.

The prior [production handoff](PRODUCTION_HANDOFF.md) records Linux regression and real Docker feature tests. No authenticated browser session was available to this deployment agent, so a post-deployment user-authenticated feature run and live provider quality/token measurements remain unverified. Health and bundle checks establish that the intended release is serving, not that every user workflow has been exercised. Suggested follow-up reviewer: Software Engineer 1 and the project owner.
