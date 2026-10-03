#!/usr/bin/env bash
# Copy the ledger's data (db.json, photos, daily copies) out of the Docker volume into a
# dated archive on the host, keeping the newest $KEEP. Run from the repository root, e.g. from cron:
#   0 3 * * * cd ~/pokemon-card-organizer && deploy/backup.sh >> ~/binder-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/binder-backups}"
KEEP="${KEEP:-14}"
mkdir -p "$DEST"
file="$DEST/binder-$(date -u +%Y%m%d-%H%M%S).tar.gz"
docker compose exec -T binder tar czf - -C /data . > "$file.partial"
mv "$file.partial" "$file"
echo "Wrote $file ($(du -h "$file" | cut -f1))"
ls -1t "$DEST"/binder-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
