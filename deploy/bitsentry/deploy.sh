#!/usr/bin/env bash
# Deploy one bitsentry/build release of Automata on bitsentry-mcp.
#
#   deploy/bitsentry/deploy.sh v1.3.2-bitsentry.1
#
# Run by .github/workflows/bitsentry-deploy.yml on the self-hosted runner, from
# a checkout of the tag. Never run by hand once the workflow works.
#
#   1. build   web + telegram-bridge images from this checkout (nothing changes yet)
#   2. backup  pg_dump of the automata database, the WhatsApp session volume,
#              and the compose files in /opt/automata
#   3. install docker-compose.yml from the tag, our override, and a release file
#              naming the new images; `docker compose up -d`
#   4. health  web answers through Traefik (MCP gate -> app -> app DB), dashboard
#              renders, bridge healthy with Telegram configured
#   5. on any failure after step 3: stop, restore the database and the previous
#              compose files, start the previous images, health-check again, fail
#
# Reusable for the Odoo MCP fork later: the shape (build -> backup -> install ->
# health -> rollback) and the state/backup layout stay; APP_DIR, images, the DB
# step and the health probes are what change.
set -euo pipefail

TAG="${1:?usage: deploy.sh <tag>}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-bitsentry\.[0-9]+$ ]] || { echo "not a bitsentry release tag: $TAG" >&2; exit 2; }

APP_DIR=/opt/automata
STATE_DIR=/opt/deploy-state/automata
BACKUP_ROOT=/opt/deploy-backups/automata
KEEP_BACKUPS=5
PG_CONTAINER=postgres-postgres-1
DB=automata
WEB_IMAGE="local/automata-web:${TAG}"
BRIDGE_IMAGE="local/automata-bridge:${TAG}"
HEALTH_TIMEOUT=240
SRC="$(git rev-parse --show-toplevel)"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }
compose() { (cd "$APP_DIR" && docker compose "$@"); }

mkdir -p "$STATE_DIR"
CURRENT="$(cat "$STATE_DIR/current" 2>/dev/null || echo none)"
if [ "$CURRENT" = "$TAG" ]; then
  log "$TAG is already deployed; nothing to do"
  summary "Already deployed: \`$TAG\`"
  exit 0
fi
grep -q '^COMPOSE_FILE=' "$APP_DIR/.env" || { echo "COMPOSE_FILE is not set in $APP_DIR/.env (see deploy/bitsentry/README.md)" >&2; exit 2; }

# ── 1. build ─────────────────────────────────────────────────────────────────
log "building $WEB_IMAGE and $BRIDGE_IMAGE"
docker build --pull -q -f "$SRC/apps/web/Dockerfile" -t "$WEB_IMAGE" "$SRC" >/dev/null
docker build --pull -q -f "$SRC/apps/telegram-bridge/Dockerfile" -t "$BRIDGE_IMAGE" "$SRC" >/dev/null

# ── 2. backup ────────────────────────────────────────────────────────────────
BACKUP="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$TAG"
mkdir -p "$BACKUP" && chmod 700 "$BACKUP_ROOT" "$BACKUP"
log "backing up to $BACKUP (previous release: $CURRENT)"
echo "$CURRENT" > "$BACKUP/previous-tag"
for f in docker-compose.yml docker-compose.override.yml docker-compose.release.yml; do
  [ -f "$APP_DIR/$f" ] && cp -p "$APP_DIR/$f" "$BACKUP/$f"
done
( umask 077; docker exec "$PG_CONTAINER" pg_dump -U postgres -d "$DB" -Fc > "$BACKUP/$DB.dump" )
docker exec -i "$PG_CONTAINER" pg_restore -l < "$BACKUP/$DB.dump" > /dev/null   # readable, or stop here
docker run --rm --network none -v automata_evolution_instances:/v:ro -v "$BACKUP":/out alpine:3.22 \
  tar czf /out/evolution_instances.tar.gz -C /v .
chmod -R go-rwx "$BACKUP"

# ── health ───────────────────────────────────────────────────────────────────
health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) fake host
  fake="wamcp_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' | cut -c1-43)"
  host="$(sed -n 's/^AUTOMATA_HOST=//p' "$APP_DIR/.env")"
  while [ $SECONDS -lt $deadline ]; do
    sleep 5
    # Through Traefik: the header gate passes a well-formed token, the app looks it
    # up in its database and answers 401. 503 = app DB down; 404/502 = not routed.
    local mcp login bridge
    mcp=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:443:127.0.0.1" \
      -X POST -H "Authorization: Bearer $fake" -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
      "https://$host/mcp" || true)
    login=$(docker exec automata-web-1 node -e "fetch('http://127.0.0.1:3000/login').then(r=>console.log(r.status),()=>console.log(0))" 2>/dev/null || echo 0)
    bridge=$(docker exec automata-telegram-bridge-1 node -e "fetch('http://127.0.0.1:8095/health').then(r=>r.json()).then(j=>console.log(j.ok&&j.telegram==='configured'?'ok':'bad'),()=>console.log('down'))" 2>/dev/null || echo down)
    log "health: mcp=$mcp login=$login bridge=$bridge"
    [ "$mcp" = 401 ] && [ "$login" = 200 ] && [ "$bridge" = ok ] && return 0
  done
  return 1
}

# ── 5. rollback ──────────────────────────────────────────────────────────────
rollback() {
  log "ROLLBACK to $CURRENT"
  summary "Deploy of \`$TAG\` failed; rolled back to \`$CURRENT\`."
  compose stop web telegram-bridge evolution || true
  docker exec "$PG_CONTAINER" psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" \
    -c "CREATE DATABASE $DB OWNER automata" \
    -c "REVOKE CONNECT, TEMPORARY ON DATABASE $DB FROM PUBLIC" \
    -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO automata"
  docker exec -i "$PG_CONTAINER" pg_restore -U postgres -d "$DB" --exit-on-error < "$BACKUP/$DB.dump"
  for f in docker-compose.yml docker-compose.override.yml docker-compose.release.yml; do
    if [ -f "$BACKUP/$f" ]; then cp -p "$BACKUP/$f" "$APP_DIR/$f"; else rm -f "$APP_DIR/$f"; fi
  done
  # No release file before the first deploy: compose reads it unconditionally, so leave an empty one.
  [ -f "$APP_DIR/docker-compose.release.yml" ] || printf 'services: {}\n' > "$APP_DIR/docker-compose.release.yml"
  compose up -d
  if health; then log "rollback healthy"; else log "ROLLBACK UNHEALTHY: manual attention needed"; summary "**Rollback unhealthy: manual attention needed.**"; fi
}

# ── 3. install ───────────────────────────────────────────────────────────────
trap 'rc=$?; if [ $rc -ne 0 ] && [ "${INSTALLED:-0}" = 1 ]; then rollback; fi; exit $rc' EXIT
INSTALLED=1
cp "$SRC/docker-compose.yml" "$APP_DIR/docker-compose.yml"
cp "$SRC/deploy/bitsentry/docker-compose.override.yml" "$APP_DIR/docker-compose.override.yml"
cat > "$APP_DIR/docker-compose.release.yml" <<EOF
# Written by deploy/bitsentry/deploy.sh for $TAG. Do not edit by hand.
services:
  web:
    image: $WEB_IMAGE
  telegram-bridge:
    image: $BRIDGE_IMAGE
EOF
log "starting $TAG"
compose config --quiet
compose up -d

# ── 4. health ────────────────────────────────────────────────────────────────
health || { log "health check failed"; exit 1; }

INSTALLED=0
echo "$TAG" > "$STATE_DIR/current"
echo "$(date -u +%FT%TZ) $TAG $(git -C "$SRC" rev-parse HEAD)" >> "$STATE_DIR/history"
log "deployed $TAG"
summary "Deployed \`$TAG\` ($(git -C "$SRC" rev-parse --short HEAD)); previous: \`$CURRENT\`; backup: \`$BACKUP\`."

# Keep the last few deploy backups and the images of the current and previous release.
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf
for repo in local/automata-web local/automata-bridge; do
  docker images "$repo" --format '{{.Tag}}' | grep -v -x -e "$TAG" -e "$CURRENT" | sed "s#^#$repo:#" | xargs -r docker rmi >/dev/null 2>&1 || true
done
