#!/usr/bin/env bash
# Copies the admin code to the box, mirroring the repo layout:
#   /opt/iceberg-admin/admin-panel/
#   /opt/iceberg-admin/web-api/src/admin/
#   /opt/iceberg-admin/smartfox-server/src/admin/
# root-owned and read-only to the services. Never copies .git, tests or
# databases. Never restarts anything: it prints the commands instead.
#
#   bash admin-panel/deploy-admin.sh --dry-run   # list what would be sent
#   bash admin-panel/deploy-admin.sh             # send it (ssh alias: iceberg)
set -euo pipefail
SSH_HOST="${ICEBERG_SSH:-iceberg}"
DEST=/opt/iceberg-admin
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT

copy() { # <repo-relative dir>
  mkdir -p "$STAGE/$1"
  # .env files: Bun auto-loads .env from the working directory, so a stray
  # dev one (NODE_ENV=test, test keys) must never reach the box.
  rsync -a --exclude '.git' --exclude 'tests/' --exclude '*.db' --exclude '*.db-*' --exclude 'node_modules/' --exclude '.env*' \
    --exclude 'deploy-admin.sh' "$ROOT/$1/" "$STAGE/$1/"
}
copy admin-panel
copy web-api/src/admin
copy smartfox-server/src/admin

bad=$(cd "$STAGE" && find . \( -name .git -o -name tests -o -name '*.db' -o -name '*.db-*' -o -name '.env*' \) -print)
if [ -n "$bad" ]; then echo "refusing: staged copy contains $bad" >&2; exit 1; fi

if [ "$DRY" = 1 ]; then
  (cd "$STAGE" && find . -type f | sort)
  echo "(dry run: nothing sent to $SSH_HOST:$DEST)"
  exit 0
fi

REMOTE_TMP=$(ssh "$SSH_HOST" mktemp -d)
trap 'rm -rf "$STAGE"; ssh "$SSH_HOST" "rm -rf '"'"'$REMOTE_TMP'"'"'" || true' EXIT
rsync -a --delete "$STAGE/" "$SSH_HOST:$REMOTE_TMP/"
# Not atomic: during the copy a restart could see a mix of old and new
# files. The preload shims log that and the servers run as plain iceberg;
# restart again after the copy finishes.
ssh "$SSH_HOST" "sudo -n rsync -a --delete --chown=root:root --chmod=D0755,F0644 '$REMOTE_TMP/' '$DEST/'"
echo "Copied to $SSH_HOST:$DEST. Restart what changed (on the box):"
echo "  sudo systemctl restart iceberg-admin          # panel"
echo "  sudo systemctl restart iceberg-web-api        # web-api admin module (back up first: sudo systemctl start iceberg-backup.service)"
echo "  :admin-swre-restart 120 in game, or sudo systemctl restart iceberg-game   # game-server admin module"
