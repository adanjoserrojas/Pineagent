#!/usr/bin/env bash
# Build the web app and the server, ship them to the instance, and switch over.
#
#   laptop: build → release.tgz (+ sha256) → s3://<bucket>/releases/<sha>.tgz
#   server (over SSM): download, verify sha256, unpack, switch /opt/pineagent/current,
#                      restart, wait for /health to report <sha>, else roll back
#
# Usage: infra/deploy.sh            (needs: npm ci at the repo root, terraform applied, AWS profile)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INFRA="$ROOT/infra"
CONFIG="$INFRA/deploy/production.env"
PROFILE=${AWS_PROFILE:-pineagent}
REGION=${AWS_REGION:-us-east-2}

# shellcheck source=deploy/production.env
set -a; . "$CONFIG"; set +a

SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD)
if [ -n "$(git -C "$ROOT" status --porcelain -- apps packages services infra/deploy)" ]; then
  SHA="$SHA-dirty-$(date +%s)" # uncommitted changes: still deployable, but visibly not a commit
  echo "warning: deploying uncommitted changes as $SHA" >&2
fi
BUCKET=$(terraform -chdir="$INFRA" output -raw release_bucket)
INSTANCE=$(terraform -chdir="$INFRA" output -raw instance_id)
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
echo "== building $SHA"
npm --prefix "$ROOT" run --silent -w @pineagent/api build >/dev/null
mkdir -p "$STAGE/api"
cp "$ROOT/services/api/dist/server.mjs" "$ROOT/services/api/dist/server.mjs.map" "$STAGE/api/"

(cd "$ROOT/apps/web" && npx tsc --noEmit && \
  VITE_API_URL="$PUBLIC_URL" VITE_AUTH0_DOMAIN="$AUTH0_DOMAIN" VITE_AUTH0_CLIENT_ID="$AUTH0_SPA_CLIENT_ID" \
  VITE_AUTH0_AUDIENCE="$AUTH0_AUDIENCE" VITE_REPOS="$ALLOWED_REPOS" \
  npx vite build --mode production --outDir "$STAGE/web" --emptyOutDir --logLevel warn)

# Only the server's settings go to the server; RELEASE_SHA is how /health proves which build runs.
{
  for k in AUTH0_DOMAIN AUTH0_AUDIENCE AUTH0_M2M_CLIENT_ID AUTH0_M2M_KEY_FILE WORKSPACES_ROOT ALLOWED_ORIGINS ALLOWED_REPOS; do
    printf '%s=%s\n' "$k" "${!k}"
  done
  printf 'RELEASE_SHA=%s\n' "$SHA"
} > "$STAGE/api.env"

tar -czf "$STAGE.tgz" -C "$STAGE" api web api.env
SUM=$(shasum -a 256 "$STAGE.tgz" | cut -d' ' -f1)
echo "== uploading releases/$SHA.tgz ($(du -h "$STAGE.tgz" | cut -f1), sha256 ${SUM:0:12}…)"
aws s3 cp --only-show-errors "$STAGE.tgz" "s3://$BUCKET/releases/$SHA.tgz"
rm -f "$STAGE.tgz"

echo "== installing on $INSTANCE"
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "pineagent deploy $SHA" \
  --parameters "commands=[\"/opt/pineagent/bin/install-release $SHA $SUM\"]" \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" || true
invocation() { aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query "$1" --output text; }
STATUS=$(invocation Status)
invocation StandardOutputContent | sed 's/^/server: /'
if [ "$STATUS" != "Success" ]; then
  echo "deploy failed ($STATUS):" >&2
  invocation StandardErrorContent >&2
  exit 1
fi

# Only a release that came up healthy becomes the one a rebuilt instance installs.
printf '%s' "$SHA" | aws s3 cp --only-show-errors - "s3://$BUCKET/latest.txt"
echo "== live: $(curl -fsS "$PUBLIC_URL/health")"
