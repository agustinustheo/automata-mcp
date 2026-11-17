#!/usr/bin/env bash
# Job-started hook for the self-hosted runner on bitsentry-mcp
# (ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's .env). The installed copy is
# /opt/actions-guard/automata-job-guard.sh, owned by root; this file is its
# reference copy.
#
# The fork is public, and a self-hosted runner on a public repository would run
# whatever a pull request's workflow asks for. This refuses every job that is
# not one of our two workflows, on our branch or a release tag, from an event
# only people with write access can cause (no schedules: syncs are triggered externally). A non-zero exit fails the job before
# any step runs.
set -u

REPO=agustinustheo/automata-mcp
deny() { echo "runner guard: refused ($*)" >&2; exit 1; }

[ "${GITHUB_REPOSITORY:-}" = "$REPO" ] || deny "repository ${GITHUB_REPOSITORY:-?}"

case "${GITHUB_EVENT_NAME:-}" in
  push|release|workflow_dispatch) ;;
  *) deny "event ${GITHUB_EVENT_NAME:-?}" ;;
esac

case "${GITHUB_WORKFLOW_REF:-}" in
  "$REPO/.github/workflows/bitsentry-deploy.yml@"*|"$REPO/.github/workflows/bitsentry-sync.yml@"*) ;;
  *) deny "workflow ${GITHUB_WORKFLOW_REF:-?}" ;;
esac

case "${GITHUB_REF:-}" in
  refs/heads/bitsentry/build) ;;
  refs/tags/v*-bitsentry.*) ;;
  *) deny "ref ${GITHUB_REF:-?}" ;;
esac

exit 0
