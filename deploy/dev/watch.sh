#!/usr/bin/env bash
# Run from cron every two minutes. Deploys the tip of the dev branch once its
# GitHub checks have passed. Does nothing when the tip is already live, when CI
# is still running, or when that commit already failed to deploy.
set -Eeuo pipefail

ROOT=${DEV_ROOT:-/opt/synapse-dev}
CONFIG="$ROOT/shared/deploy.env"
# shellcheck source=/dev/null
[[ -f "$CONFIG" ]] && source "$CONFIG"

GH_REPO=${GH_REPO:-nafew0/synapse}
BRANCH=${BRANCH:-bdren-dev}
REQUIRED_CHECKS=${REQUIRED_CHECKS:-"Build and type check|Unit tests"}
SKIP_CI_GATE=${SKIP_CI_GATE:-0}
STATE="$ROOT/state"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

log() { printf '%s [watch] %s\n' "$(date '+%F %T')" "$*"; }

remote_tip() {
  git ls-remote "${REPO_URL:-https://github.com/$GH_REPO.git}" "refs/heads/$BRANCH" | cut -f1
}

# Prints success, pending or failure for the required check runs of a commit.
ci_state() {
  local sha=$1 auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsS --max-time 20 ${auth[@]+"${auth[@]}"} -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$GH_REPO/commits/$sha/check-runs?per_page=100" |
    REQUIRED_CHECKS="$REQUIRED_CHECKS" node -e '
      const runs = JSON.parse(require("fs").readFileSync(0, "utf8")).check_runs ?? [];
      const required = process.env.REQUIRED_CHECKS.split("|").map((name) => name.trim()).filter(Boolean);
      const latest = new Map();
      for (const run of runs) {
        const seen = latest.get(run.name);
        if (!seen || run.id > seen.id) latest.set(run.name, run);
      }
      const passed = (run) => ["success", "skipped", "neutral"].includes(run.conclusion);
      const states = required.map((name) => {
        const matching = [...latest.values()].filter((r) => r.name === name || r.name.startsWith(`${name} (`));
        if (matching.some((r) => r.status === "completed" && !passed(r))) return "failure";
        if (matching.length === 0 || matching.some((r) => r.status !== "completed")) return "pending";
        return "success";
      });
      console.log(states.includes("failure") ? "failure" : states.includes("pending") ? "pending" : "success");
    '
}

main() {
  mkdir -p "$STATE"
  exec 9>"$ROOT/deploy.lock"
  flock -n 9 || exit 0
  export DEPLOY_LOCKED=1

  local sha state
  sha=$(remote_tip)
  [[ -z "$sha" ]] && { log "branch $BRANCH not found"; exit 1; }
  [[ "$sha" == "$(cat "$STATE/deployed" 2>/dev/null)" ]] && exit 0
  [[ -e "$STATE/failed-$sha" ]] && exit 0

  if [[ "$SKIP_CI_GATE" != 1 ]]; then
    state=$(ci_state "$sha") || { log "could not read CI for $sha"; exit 0; }
    if [[ "$state" == pending ]]; then
      exit 0
    fi
    if [[ "$state" == failure ]]; then
      [[ -e "$STATE/ci-failed-$sha" ]] || log "CI failed for $sha; not deploying it"
      touch "$STATE/ci-failed-$sha"
      exit 0
    fi
  fi

  log "deploying $sha"
  "$HERE/deploy.sh" "$sha"
}

main "$@"
