#!/usr/bin/env bash
# Restores a dump produced by scripts/db-dump-remote.sh into the local
# Docker MongoDB container, for testing against real data.
#
# Usage:
#   scripts/db-restore-local.sh --dump <path-to-dump-dir> [options]
#
# Options:
#   --dump <dir>        Required. Path to the dumped database directory
#                        (the one containing *.bson files, e.g. .../Synapse)
#   --container <name>  Docker container running MongoDB (default: chat-mongodb)
#   --target-db <name>  Database name to restore into locally (default: SynapseProd)
#   --drop               Drop the target database's existing collections first
#   -y, --yes            Skip confirmation prompts
#
# By default this restores into a SEPARATE database (SynapseProd) so it never
# touches your normal local LibreChat/dev database. Point MONGO_URI at the
# target DB afterwards to actually use it:
#   MONGO_URI=mongodb://127.0.0.1:27017/SynapseProd?replicaSet=rs0

set -euo pipefail

DUMP_DIR=""
CONTAINER="chat-mongodb"
TARGET_DB="SynapseProd"
DROP=0
ASSUME_YES=0

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP_DIR="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --drop) DROP=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1"; usage ;;
  esac
done

if [ -z "$DUMP_DIR" ]; then
  echo "Error: --dump <path> is required."
  usage
fi

if [ ! -d "$DUMP_DIR" ] || ! compgen -G "$DUMP_DIR/*.bson" >/dev/null; then
  echo "Error: '$DUMP_DIR' doesn't look like a mongodump database directory (no *.bson files)."
  exit 1
fi

command -v docker >/dev/null || { echo "Error: docker is required."; exit 1; }

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Error: container '$CONTAINER' is not running. Check with: docker ps"
  exit 1
fi

EXISTING_COUNT="$(docker exec "$CONTAINER" mongosh "$TARGET_DB" --quiet --eval \
  'db.getCollectionNames().length' 2>/dev/null || echo 0)"

echo "About to restore into local Docker MongoDB"
echo "  Container:   $CONTAINER"
echo "  Source dump: $DUMP_DIR"
echo "  Target DB:   $TARGET_DB"
echo "  Mode:        $([ "$DROP" -eq 1 ] && echo 'DROP existing collections first' || echo 'merge (no drop)')"
if [ "$EXISTING_COUNT" != "0" ]; then
  echo "  Warning: '$TARGET_DB' already has $EXISTING_COUNT collection(s) in this container."
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

REMOTE_TMP="/tmp/restore-$(date +%Y%m%d-%H%M%S)"

echo "[1/3] Copying dump into container ..."
docker cp "$DUMP_DIR" "$CONTAINER:$REMOTE_TMP"

echo "[2/3] Running mongorestore ..."
RESTORE_ARGS=(--db="$TARGET_DB")
if [ "$DROP" -eq 1 ]; then
  RESTORE_ARGS+=(--drop)
fi
docker exec "$CONTAINER" mongorestore "${RESTORE_ARGS[@]}" "$REMOTE_TMP"

echo "[3/3] Cleaning up ..."
docker exec "$CONTAINER" rm -rf "$REMOTE_TMP"

echo ""
echo "Done. Restored into database: $TARGET_DB"
echo "Verify with:"
echo "  docker exec $CONTAINER mongosh $TARGET_DB --quiet --eval 'db.getCollectionNames()'"
echo ""
echo "Point your local .env at it to test:"
echo "  MONGO_URI=mongodb://127.0.0.1:27017/$TARGET_DB?replicaSet=rs0"
