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
`v1.3.2-bitsentry.1`. Pushing one (or publishing a GitHub Release for one) runs
`.github/workflows/bitsentry-deploy.yml` on the self-hosted runner `bitsentry-mcp-automata`
(labels `self-hosted, bitsentry-mcp, automata-deploy`), which runs `deploy.sh`:

1. build `local/automata-web:<tag>` and `local/automata-bridge:<tag>` from the tag
2. back up the `automata` database (`pg_dump -Fc`), the WhatsApp session volume and
   the compose files to `/opt/deploy-backups/automata/<time>-<tag>/` (last 5 kept)
3. install `docker-compose.yml` from the tag, `docker-compose.override.yml` from here,
   and `docker-compose.release.yml` naming the new images; `docker compose up -d`
4. health: `/mcp` through Traefik answers 401 to a well-formed unknown token (gate,
   app and app database all up), `/login` renders, the bridge is healthy with
   Telegram configured
5. any failure: restore the database and the previous compose files, start the
   previous images, health-check again, fail the job

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
from Grok Bot, not by GitHub or T3):

```bash
gh workflow run bitsentry-sync.yml -R agustinustheo/automata-mcp --ref bitsentry/build
# or: POST https://api.github.com/repos/agustinustheo/automata-mcp/actions/workflows/bitsentry-sync.yml/dispatches
#     {"ref":"bitsentry/build"}   (token with Actions: write on the repo)
```

On the self-hosted runner, `sync.sh` fast-forwards `main` to upstream, merges it into
`bitsentry/build`, runs `pnpm typecheck`, `bridge:typecheck`, `cloud:typecheck`,
`test:emails` and `listings:check`, then pushes and tags the next release, which
deploys. Nothing upstream changed: it says so and stops. A conflict or a failed check
pushes nothing and fails the run, with the reason in the run summary (GitHub mails
the person who triggered it). It pushes over the repository's deploy key
(`github-automata` in the runner user's SSH config), since a workflow token may not
push upstream's workflow-file changes.

## Runner safety

The fork is public. The runner (user `automata-ci`, in the `docker` group, so
root-equivalent on the box) runs only what `runner-job-guard.sh` allows: our two
workflows, on `bitsentry/build` or a release tag, from push / release / manual
events. Pull-request jobs are refused before any step runs, and fork pull
requests need approval to run workflows at all.

## Evolution engine

Upstream `main` runs `evolution-api-reforged` 3.1.0. This build pins stock
`evoapicloud/evolution-api:v2.3.7` (in `docker-compose.override.yml`), which upstream
still supports, because the fork rewrites `"Message"` (dedupe + unique index) on its
first start. Switching is a separate decision: follow upstream's
`docs/whatsapp.md` "Moving from stock Evolution 2.3.7", then remove the pin.

## Reusing this for the Odoo MCP fork

Same layout: mirror `main`, `feature/*` for contributions, a build branch with
`deploy/bitsentry/` and the two workflows; a second runner (or the same one with its
own labels and a guard entry) and its own `APP_DIR`, images, DB step and health
probes in `deploy.sh`.
