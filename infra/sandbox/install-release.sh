#!/usr/bin/env bash
# Approved operator entry point. Downloads only checksummed release artifacts;
# never reads provider keys. Runtime uses the existing pineagent-app role.
set -euo pipefail
SHA=$1
SUM=$2
IMAGE_SUM=$3
IMAGE_ID=$4
[[ "$SHA" =~ ^[a-f0-9]{12}$ && "$SUM" =~ ^[a-f0-9]{64}$ && "$IMAGE_SUM" =~ ^[a-f0-9]{64}$ && "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
test "$(id -u)" = 0
test "$(aws sts get-caller-identity --query Account --output text)" = 004575106238
UID_APP=$(id -u pineagent)
test "$UID_APP" -gt 0
STAGE=$(mktemp -d /opt/pineagent/pty-stage.XXXXXX)
PREV=$(readlink -f /opt/pineagent/current)
[[ "$PREV" == /opt/pineagent/releases/* && -d "$PREV" ]] || exit 2
DIR=/opt/pineagent/releases/$SHA
test ! -e "$DIR"
aws s3 cp --region us-east-2 --only-show-errors "s3://pineagent-releases-004575106238/releases/$SHA.tgz" "$STAGE/release.tgz"
aws s3 cp --region us-east-2 --only-show-errors "s3://pineagent-releases-004575106238/releases/$SHA-image.tar" "$STAGE/image.tar"
printf '%s  %s\n' "$SUM" "$STAGE/release.tgz" "$IMAGE_SUM" "$STAGE/image.tar" | sha256sum -c -
mkdir "$DIR"
tar -xzf "$STAGE/release.tgz" -C "$DIR"
test -f "$DIR/api/server.mjs" && test -f "$DIR/api/supervisor.mjs" && test -f "$DIR/web/index.html"
docker load -i "$STAGE/image.tar"
test "$(docker image inspect "$IMAGE_ID" --format '{{.Id}}')" = "$IMAGE_ID"
install -d -m 755 /etc/pineagent /etc/systemd/system/pineagent-api.service.d
DROPIN=/etc/systemd/system/pineagent-api.service.d/terminal.conf
WAS_ENABLED=$(systemctl is-enabled pineagent-sandbox 2>/dev/null || true)
if test -f "$DROPIN"; then cp "$DROPIN" "$STAGE/terminal.conf.previous"; fi
if test -f /etc/systemd/system/pineagent-sandbox.service; then cp /etc/systemd/system/pineagent-sandbox.service "$STAGE/sandbox.service.previous"; fi
if test -f /etc/pineagent/sandbox.env; then cp /etc/pineagent/sandbox.env "$STAGE/sandbox.env.previous"; fi
printf '%s\n' "$PREV" > "$STAGE/previous-release"
rollback() {
  trap - ERR
  systemctl stop pineagent-api pineagent-sandbox || true
  ln -s "$PREV" /opt/pineagent/rollback-next
  mv -Tf /opt/pineagent/rollback-next /opt/pineagent/current
  if test -f "$STAGE/terminal.conf.previous"; then cp "$STAGE/terminal.conf.previous" "$DROPIN"; else rm -f "$DROPIN"; fi
  if test "$WAS_ENABLED" != enabled; then systemctl disable pineagent-sandbox || true; fi
  if test -f "$STAGE/sandbox.service.previous"; then cp "$STAGE/sandbox.service.previous" /etc/systemd/system/pineagent-sandbox.service; else rm -f /etc/systemd/system/pineagent-sandbox.service; fi
  if test -f "$STAGE/sandbox.env.previous"; then cp "$STAGE/sandbox.env.previous" /etc/pineagent/sandbox.env; else rm -f /etc/pineagent/sandbox.env; fi
  systemctl daemon-reload
  if test "$WAS_ENABLED" = enabled; then systemctl enable pineagent-sandbox; fi
  if test -f "$PREV/api/supervisor.mjs" && test -f "$STAGE/sandbox.env.previous"; then systemctl start pineagent-sandbox; fi
  systemctl start pineagent-api
  echo "Rolled back to $(basename "$PREV"); diagnostic artifacts retained at $STAGE" >&2
  exit 1
}
trap rollback ERR
systemctl stop pineagent-api
if test "$(systemctl show pineagent-sandbox -p LoadState --value)" != not-found; then
  systemctl stop pineagent-sandbox
  if systemctl is-active --quiet pineagent-sandbox; then false; fi
fi
install -m 644 "$DIR/pineagent-sandbox.service" /etc/systemd/system/pineagent-sandbox.service
printf 'WORKSPACES_ROOT=/workspaces/repos\nSANDBOX_IMAGE=%s\nSANDBOX_UID=%s\nTERMINAL_RELAY_ROOT=/run/pineagent-terminals\n' "$IMAGE_ID" "$UID_APP" > /etc/pineagent/sandbox.env
chmod 600 /etc/pineagent/sandbox.env
printf '[Service]\nRuntimeDirectory=pineagent-terminals\nRuntimeDirectoryMode=0700\nReadWritePaths=/run/pineagent-terminals\nTimeoutStopSec=150\n' > "$DROPIN"
ln -s "$DIR" /opt/pineagent/release-next
mv -Tf /opt/pineagent/release-next /opt/pineagent/current
systemctl daemon-reload
systemctl start pineagent-sandbox
systemctl start pineagent-api
HEALTHY=false
for _ in $(seq 1 45); do
  if curl -fsS localhost:3001/health | /usr/local/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok&&h.sha===process.argv[1]&&h.harness&&h.interactiveTerminal?0:1)}catch{process.exit(1)}})' "$SHA"; then HEALTHY=true; break; fi
  sleep 1
done
test "$HEALTHY" = true
systemctl is-active --quiet pineagent-sandbox
runuser -u pineagent -- /usr/local/bin/node -e 'const h=require("http");const q=h.get({socketPath:"/run/pineagent-sandbox/control.sock",path:"/health"},r=>{let s="";r.on("data",d=>s+=d);r.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.ok&&v.protocol==="pty-v1"&&v.terminal?0:1)}catch{process.exit(1)}})});q.setTimeout(5000,()=>{q.destroy();process.exit(1)});q.on("error",()=>process.exit(1));'
systemctl enable pineagent-sandbox
trap - ERR
echo "Installed $SHA; rollback source $PREV; retained artifacts $STAGE"
curl -fsS localhost:3001/health
