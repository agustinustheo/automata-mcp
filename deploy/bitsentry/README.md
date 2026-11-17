# BitSentry build of Automata

This directory and the `bitsentry-*` workflows exist only on **`bitsentry/build`**
in `agustinustheo/automata-mcp`. They are deploy configuration for one server,
`bitsentry-mcp`, and are never part of an upstream contribution.

## Branches

| Branch | What it is | Who writes it |
|---|---|---|
| `main` | Exact mirror of `ju-li/automata-mcp` `main`. Never carries our commits. | fast-forwarded by the sync |
| `feature/*` | One clean feature off upstream `main` (e.g. `feature/media-download`), the upstream contribution branch. No BitSentry config, ever. | us, and upstream reviewers |
| `bitsentry/build` | `main` + merged features + this directory. The only branch deployed. The fork's default branch, so the sync workflow can be dispatched. | merges only |

Get a feature in: merge its `feature/*` branch into `bitsentry/build` (normal merge,
no squash), push, then tag a release (below). A fix requested upstream lands on the
feature branch first and is merged into `bitsentry/build` again.

## Releases and deploys

Tags `v<upstream package.json version>-bitsentry.<N>` on `bitsentry/build`, e.g.
`v1.3.2-bitsentry.3`. Pushing one (or publishing a GitHub Release for one) runs
`.github/workflows/bitsentry-deploy.yml`:

1. **build** on GitHub-hosted runners: `apps/web/Dockerfile` and
   `apps/telegram-bridge/Dockerfile`, pushed to GHCR packages
   `ghcr.io/agustinustheo/automata-mcp-web` and
   `ghcr.io/agustinustheo/automata-mcp-telegram-bridge`, each tagged `<release>`
   and `sha-<12-char commit>` (plus a `buildcache` tag for layer reuse).
2. **deploy** on the self-hosted runner `bitsentry-mcp-automata` (labels
   `self-hosted, bitsentry-mcp, automata-deploy`), which builds nothing. It logs in
   to GHCR with the job's own `GITHUB_TOKEN` (`packages: read`, valid for that job
   only, logged out afterwards) and runs `deploy.sh`:
   1. pull the release's two images
   2. back up the `automata` database (`pg_dump -Fc`), the WhatsApp session volume
      and the compose files to `/opt/deploy-backups/automata/<time>-<tag>/` (last 5 kept)
   3. install `docker-compose.yml` from the tag, `docker-compose.override.yml` from
      here, and `docker-compose.release.yml` naming the pulled images; `docker compose up -d`
   4. health: `/mcp` through Traefik answers 401 to a well-formed unknown token (gate,
      app and app database all up), `/login` renders, the bridge is healthy with
      Telegram configured
   5. any failure: restore the database and the previous compose files, start the
      previous images (still local), health-check again, fail the job
   6. keep the last 3 release tags of each image locally; prune the rest

State: `/opt/deploy-state/automata/current` and `history`. Manual deploys are
retired: to redeploy, re-run the workflow with the tag (`workflow_dispatch`).
`/opt/automata/.env` sets
`COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.release.yml`,
so plain `docker compose` there sees the deployed release.

Tag a release by hand:

```bash
git switch bitsentry/build && git pull
v=$(jq -r .version package.json); n=$(git tag -l "v$v-bitsentry.*" | sed "s/.*bitsentry\.//" | sort -n | tail -1)
git tag -a "v$v-bitsentry.$((n+1))" -m "…" && git push origin "v$v-bitsentry.$((n+1))"
```

## Upstream sync (on demand)

`.github/workflows/bitsentry-sync.yml` runs only when triggered (scheduling is done
from Grok Bot, not by GitHub or T3), on a GitHub-hosted runner:

```bash
gh workflow run bitsentry-sync.yml -R agustinustheo/automata-mcp --ref bitsentry/build
# or: POST https://api.github.com/repos/agustinustheo/automata-mcp/actions/workflows/bitsentry-sync.yml/dispatches
#     {"ref":"bitsentry/build"}   (token with Actions: write on the repo)
```

`sync.sh` fast-forwards `main` to upstream, merges it into `bitsentry/build`, runs
`pnpm typecheck`, `bridge:typecheck`, `cloud:typecheck`, `test:emails` and
`listings:check`, then pushes and tags the next release, which builds and deploys.
Nothing upstream changed: it says so and stops. A conflict or a failed check pushes
nothing and fails the run, with the reason in the run summary (GitHub mails the
person who triggered it). It pushes with the repository's write deploy key, held as
the Actions secret `SYNC_DEPLOY_KEY` (a workflow token may not push upstream's
workflow-file changes, and a tag pushed with it would not trigger the deploy).

## Runner safety

The fork is public. The runner (user `automata-ci`, in the `docker` group, so
root-equivalent on the box) runs only what `runner-job-guard.sh` allows: the deploy
workflow, on `bitsentry/build` or a release tag, from push / release / manual
events. Pull-request jobs are refused before any step runs, and fork pull requests
need approval to run workflows at all. Builds and the sync never run on it.

The packages are **public**, by decision (Theo, 2026-11-17): the fork is public and
its images hold only what the public source builds — no secrets, no `.env`; keeping
them public keeps builds on GitHub's free runners simple. The deploy job still logs
in with its read-only `GITHUB_TOKEN`, which is harmless for public packages and
keeps working if they are ever made private.

## Evolution engine

This build runs the Evolution image **upstream pins** (`evolution-api-reforged`,
by digest, in upstream's `docker-compose.yml`): the override sets no `image:` for
`evolution`, so a sync that moves upstream's pin moves ours at the next release.
Switched from stock `evoapicloud/evolution-api:v2.3.7` on 2026-11-17 (Theo: run the
most stable engine, upstream's if possible). Reforged fixes stock's dead offline
queue, the 50-minute status-stanza drops and unrecorded retried closes; see
upstream `docs/whatsapp.md` "Which Evolution".

- Its first start dedupes `"Message"` and adds `Message_instanceId_key_unique`
  (seconds on our ~22k rows; a big table needs upstream's pre-build steps first).
- It needs a custom `AUTHENTICATION_API_KEY` (ours: 64 chars), `CACHE_REDIS_ENABLED`
  and a persistent Redis (`--appendonly yes`, `noeviction` here).
- `message_instance_key_id_idx` exists on `"Message"` (created 2026-11-17), which
  media downloads need on reforged (501 without it).
- Rolling back = pin `image: evoapicloud/evolution-api:v2.3.7` here again and
  release; upstream rehearsed stock on the migrated schema (fork #33).

## Reusing this for the Odoo MCP fork

Same layout: mirror `main`, `feature/*` for contributions, a build branch with
`deploy/bitsentry/` and the two workflows; images built on GitHub-hosted runners into
GHCR; a second runner (or the same one with its own labels and a guard entry)
that only pulls and deploys, with its own `APP_DIR`, images, DB step and health probes
in `deploy.sh`.
