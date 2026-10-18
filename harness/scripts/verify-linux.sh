#!/bin/bash
# Trusted test runner only: mount this worktree read-only at /source and an empty
# disposable volume at /work. No host credentials or Docker socket are required.
set -euo pipefail
cd /work
tar -C /source --exclude=node_modules --exclude=dist --exclude=.git -cf - package.json package-lock.json harness packages/core services/api apps/web | tar -xf -
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run verify:freeze -w @pineagent/harness
