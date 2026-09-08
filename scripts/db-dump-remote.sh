#!/usr/bin/env bash
# Dumps a MongoDB database on a remote server (via SSH) and pulls the dump
# down to this machine, ready for scripts/db-restore-local.sh.
#
# Usage:
#   scripts/db-dump-remote.sh --host user@prod-server [options]
#
# Options:
#   --host <ssh-target>     Required. SSH target, e.g. deploy@prod.example.com
#   --db <name>             Remote database name (default: Synapse)
#   --uri <mongo-uri>       Full remote mongodump --uri, overrides --db
#   --out <dir>             Local directory to save the dump under (default: ~/Downloads)
#   --exclude <collection>  Repeatable. Collection to skip (e.g. --exclude messages)
#   -y, --yes               Skip the confirmation prompt
#
# Example:
#   scripts/db-dump-remote.sh --host deploy@prod.example.com \
#     --exclude messages --exclude conversations

set -euo pipefail

DB_NAME="Synapse"
MONGO_URI=""
OUT_DIR="$HOME/Downloads"
SSH_HOST=""
ASSUME_YES=0
EXCLUDES=()

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) SSH_HOST="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --uri) MONGO_URI="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --exclude) EXCLUDES+=("$2"); shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1"; usage ;;
  esac
done

if [ -z "$SSH_HOST" ]; then
  echo "Error: --host is required (e.g. --host deploy@prod.example.com)"
  usage
fi

for cmd in ssh scp; do
  command -v "$cmd" >/dev/null || { echo "Error: $cmd is required locally."; exit 1; }
done

STAMP="$(date +%Y%m%d-%H%M%S)"
REMOTE_TMP_DIR="/tmp/db-dump-$STAMP"
REMOTE_TARBALL="$REMOTE_TMP_DIR.tar.gz"
LOCAL_TARBALL="$OUT_DIR/synapse-dump-$STAMP.tar.gz"
LOCAL_DUMP_DIR="$OUT_DIR/synapse-dump-$STAMP"

DUMP_TARGET_ARGS=(--uri="${MONGO_URI:-mongodb://localhost:27017/$DB_NAME}")
for coll in "${EXCLUDES[@]:-}"; do
  [ -n "$coll" ] && DUMP_TARGET_ARGS+=(--excludeCollection="$coll")
done

echo "About to dump the LIVE database on $SSH_HOST"
echo "  Database:        ${MONGO_URI:-$DB_NAME}"
echo "  Excluded:         ${EXCLUDES[*]:-(none)}"
echo "  Remote temp path: $REMOTE_TMP_DIR"
echo "  Local destination: $LOCAL_DUMP_DIR"
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

echo "[1/4] Running mongodump on $SSH_HOST ..."
ssh "$SSH_HOST" "command -v mongodump >/dev/null || { echo 'mongodump not found on remote host'; exit 1; }"
ssh "$SSH_HOST" mongodump "${DUMP_TARGET_ARGS[@]}" --out="$REMOTE_TMP_DIR"

echo "[2/4] Compressing remote dump ..."
ssh "$SSH_HOST" "tar czf '$REMOTE_TARBALL' -C '$(dirname "$REMOTE_TMP_DIR")' '$(basename "$REMOTE_TMP_DIR")'"

echo "[3/4] Copying dump to $LOCAL_TARBALL ..."
mkdir -p "$OUT_DIR"
scp "$SSH_HOST:$REMOTE_TARBALL" "$LOCAL_TARBALL"

echo "[4/4] Cleaning up remote temp files ..."
ssh "$SSH_HOST" "rm -rf '$REMOTE_TMP_DIR' '$REMOTE_TARBALL'"

echo "Extracting locally ..."
mkdir -p "$LOCAL_DUMP_DIR"
tar xzf "$LOCAL_TARBALL" -C "$LOCAL_DUMP_DIR" --strip-components=1
rm -f "$LOCAL_TARBALL"

echo ""
echo "Done. Dump saved to: $LOCAL_DUMP_DIR/$DB_NAME"
echo "Next step:"
echo "  scripts/db-restore-local.sh --dump '$LOCAL_DUMP_DIR/$DB_NAME'"
