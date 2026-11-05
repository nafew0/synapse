#!/usr/bin/env bash
# Builds one commit of the dev branch into its own release folder, switches
# /opt/synapse-dev/current to it, restarts the app and rolls back if it does
# not come up healthy.
#
#   deploy.sh            deploy the tip of the dev branch
#   deploy.sh <sha>      deploy (or roll back to) a specific commit
set -Eeuo pipefail

ROOT=${DEV_ROOT:-/opt/synapse-dev}
CONFIG="$ROOT/shared/deploy.env"
# shellcheck source=/dev/null
[[ -f "$CONFIG" ]] && source "$CONFIG"

REPO_URL=${REPO_URL:-https://github.com/nafew0/synapse.git}
GH_REPO=${GH_REPO:-nafew0/synapse}
BRANCH=${BRANCH:-bdren-dev}
APP=${APP:-synapse-dev}
KEEP_RELEASES=${KEEP_RELEASES:-3}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3080/health}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
SHARED_PATHS=${SHARED_PATHS:-".env uploads logs api/logs client/public/images api/data"}
INSTALL_CMD=${INSTALL_CMD:-"npm ci --prefer-offline --no-audit --no-fund"}
BUILD_CMD=${BUILD_CMD:-"npx turbo run build --force"}
ECOSYSTEM=${ECOSYSTEM:-deploy/dev/ecosystem.config.js}
PUBLIC_URL=${PUBLIC_URL:-}

MIRROR="$ROOT/repo.git"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
CURRENT="$ROOT/current"
STATE="$ROOT/state"

export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=6144}

log() { printf '%s [deploy] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

lock() {
  [[ -n "${DEPLOY_LOCKED:-}" ]] && return
  exec 9>"$ROOT/deploy.lock"
  flock -n 9 || die "another deploy is running"
  export DEPLOY_LOCKED=1
}

commit_status() {
  local sha=$1 state=$2 description=$3
  [[ -z "${GITHUB_TOKEN:-}" ]] && return 0
  curl -fsS -o /dev/null -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$GH_REPO/statuses/$sha" \
    -d "{\"state\":\"$state\",\"context\":\"dev-server deploy\",\"description\":\"$description\",\"target_url\":\"$PUBLIC_URL\"}" \
    || log "could not post commit status (ignored)"
}

fetch() {
  if [[ ! -d "$MIRROR" ]]; then
    git clone --bare --single-branch --branch "$BRANCH" "$REPO_URL" "$MIRROR"
  fi
  git --git-dir="$MIRROR" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/heads/$BRANCH"
}

link_shared() {
  local release=$1 item
  for item in $SHARED_PATHS; do
    [[ -e "$SHARED/$item" ]] || continue
    mkdir -p "$(dirname "$release/$item")"
    rm -rf "${release:?}/$item"
    ln -s "$SHARED/$item" "$release/$item"
  done
}

build() {
  local sha=$1 release=$2
  log "building $sha in $release"
  # Called from `if !`, where bash ignores set -e, so every step checks itself.
  rm -rf "$release"
  git --git-dir="$MIRROR" worktree prune
  git --git-dir="$MIRROR" worktree add --quiet --detach "$release" "$sha" || return 1
  link_shared "$release" || return 1
  (cd "$release" && eval "$INSTALL_CMD") || return 1
  (cd "$release" && eval "$BUILD_CMD") || return 1
  if [[ -x "$SHARED/post-build.sh" ]]; then
    log "running shared/post-build.sh"
    "$SHARED/post-build.sh" "$release" || return 1
  fi
  touch "$release/.built"
}

switch_to() {
  local release=$1
  ln -sfn "$release" "$CURRENT.next"
  mv -Tf "$CURRENT.next" "$CURRENT"
}

restart() {
  # 9>&- keeps the deploy lock out of the PM2 daemon, which outlives this script.
  pm2 delete "$APP" >/dev/null 2>&1 9>&- || true
  pm2 start "$CURRENT/$ECOSYSTEM" 9>&-
  pm2 save >/dev/null 9>&-
}

healthy() {
  local waited=0
  while (( waited < HEALTH_TIMEOUT )); do
    curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL" && return 0
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

prune() {
  local keep_current keep_previous release
  keep_current=$(readlink -f "$CURRENT" || true)
  keep_previous=$(cat "$STATE/previous" 2>/dev/null || true)
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r release; do
    release=${release%/}
    [[ "$release" == "$keep_current" || "$release" == "$keep_previous" ]] && continue
    log "removing old release $release"
    git --git-dir="$MIRROR" worktree remove --force "$release" 2>/dev/null || rm -rf "$release"
  done
  git --git-dir="$MIRROR" worktree prune
}

main() {
  mkdir -p "$RELEASES" "$SHARED" "$STATE"
  lock
  fetch

  local sha release previous
  sha=$(git --git-dir="$MIRROR" rev-parse --verify "${1:-refs/heads/$BRANCH}^{commit}")
  release="$RELEASES/$sha"
  previous=$(readlink -f "$CURRENT" 2>/dev/null || true)

  [[ "$previous" == "$release" ]] && { log "$sha is already live"; exit 0; }

  commit_status "$sha" pending "Deploying to the dev server"
  if [[ ! -f "$release/.built" ]]; then
    if ! build "$sha" "$release"; then
      touch "$STATE/failed-$sha"
      commit_status "$sha" failure "Build failed on the dev server"
      die "build of $sha failed; still serving ${previous:-nothing}"
    fi
  else
    link_shared "$release"
  fi

  switch_to "$release"
  restart

  if ! healthy; then
    touch "$STATE/failed-$sha"
    commit_status "$sha" failure "App did not become healthy; rolled back"
    if [[ -n "$previous" && -d "$previous" ]]; then
      log "$sha is unhealthy, rolling back to $previous"
      switch_to "$previous"
      restart
      healthy || log "previous release is not healthy either; check pm2 logs $APP"
    fi
    die "$sha did not pass $HEALTH_URL within ${HEALTH_TIMEOUT}s"
  fi

  [[ -n "$previous" ]] && echo "$previous" > "$STATE/previous"
  echo "$sha" > "$STATE/deployed"
  rm -f "$STATE/failed-$sha"
  commit_status "$sha" success "Live on the dev server"
  log "$sha is live"
  prune
}

main "$@"
