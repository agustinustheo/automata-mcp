#!/usr/bin/env bash
# Upstream sync for the bitsentry fork of Automata, run on demand by
# .github/workflows/bitsentry-sync.yml on a GitHub-hosted runner (workflow_dispatch;
# scheduled from Grok Bot).
#
#   1. fetch ju-li/automata-mcp main; fast-forward our main (an exact mirror)
#   2. merge main into bitsentry/build
#   3. run the checks upstream's PR template names, in a throwaway Node container
#   4. only if something changed and every check passed: push main + bitsentry/build,
#      tag the next v<version>-bitsentry.N and push the tag -> bitsentry-deploy.yml
#
# Conflict, failed check, or a main that no longer fast-forwards: nothing is
# pushed, the job fails, and GitHub mails the person who triggered it. Work
# happens in a fresh clone over the deploy key (GITHUB_TOKEN may not push
# workflow files, and upstream's commits touch them; a tag it pushed would not
# trigger the deploy either).
set -euo pipefail

FORK=git@github-automata:agustinustheo/automata-mcp.git
UPSTREAM=https://github.com/ju-li/automata-mcp.git
BUILD=bitsentry/build
NODE_IMAGE=node:22.23.2-alpine

log() { echo "[$(date -u +%FT%TZ)] $*"; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY" || true; }
fail() { log "SYNC STOPPED: $*"; summary "**Sync stopped, nothing pushed:** $*"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone -q --no-tags "$FORK" "$WORK/repo"
cd "$WORK/repo"
git config user.name "bitsentry-sync"
git config user.email "bitsentry-sync@users.noreply.github.com"
git remote add upstream "$UPSTREAM"
git fetch -q --no-tags upstream main
git fetch -q --tags origin

# 1. main mirrors upstream; anything else is a human's to sort out.
git checkout -q -B main origin/main
OLD_MAIN="$(git rev-parse HEAD)"
git merge -q --ff-only upstream/main || fail "our main has commits upstream main does not; it must stay a mirror"
NEW_MAIN="$(git rev-parse HEAD)"

# 2. merge main into the build branch.
git checkout -q -B "$BUILD" "origin/$BUILD"
OLD_BUILD="$(git rev-parse HEAD)"
if ! git merge -q --no-edit -m "Merge upstream main $(git rev-parse --short "$NEW_MAIN") into $BUILD" main; then
  git merge --abort || true
  fail "merging upstream main $(git rev-parse --short "$NEW_MAIN") into $BUILD conflicts"
fi
NEW_BUILD="$(git rev-parse HEAD)"

if [ "$OLD_MAIN" = "$NEW_MAIN" ] && [ "$OLD_BUILD" = "$NEW_BUILD" ]; then
  log "upstream unchanged; nothing to do"
  summary "Upstream unchanged; nothing to do."
  exit 0
fi
log "main $(git rev-parse --short "$OLD_MAIN")..$(git rev-parse --short "$NEW_MAIN"), build -> $(git rev-parse --short "$NEW_BUILD")"

# 3. checks, as the upstream PR template lists them.
log "running checks"
docker run --rm --network bridge -v "$PWD":/w -w /w -e CI=1 -e NODE_OPTIONS=--max-old-space-size=3072 \
  --memory 3500m "$NODE_IMAGE" sh -ec '
    corepack enable >/dev/null
    pnpm install --frozen-lockfile --reporter=silent
    pnpm typecheck
    pnpm bridge:typecheck
    pnpm cloud:typecheck
    pnpm test:emails
    pnpm listings:check
  ' || fail "checks failed on $(git rev-parse --short "$NEW_BUILD")"
# The container ran as root in this clone; give the files back before git touches them again.
docker run --rm -v "$PWD":/w alpine:3.22 chown -R "$(id -u):$(id -g)" /w

# 4. push, then tag. The tag push triggers the deploy workflow.
VERSION="$(jq -r .version package.json)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "cannot read the version from package.json"
N="$(git tag -l "v$VERSION-bitsentry.*" | sed "s/^v$VERSION-bitsentry\.//" | sort -n | tail -1)"
TAG="v$VERSION-bitsentry.$(( ${N:-0} + 1 ))"
git push -q --atomic origin "main:main" "$BUILD:$BUILD"
git tag -a "$TAG" -m "$TAG: upstream main $(git rev-parse --short "$NEW_MAIN") merged into $BUILD" "$NEW_BUILD"
git push -q origin "refs/tags/$TAG"
log "pushed $TAG"
summary "Synced upstream $(git rev-parse --short "$NEW_MAIN"); tagged \`$TAG\` (deploy follows)."
