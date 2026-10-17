#!/usr/bin/env bash
# Copy the ledger's data (db.json, photos, daily copies, and the sign-in accounts, sessions and
# guest log, which the app's own copies never hold) out of the Docker volume into a dated archive
# on the host, keeping the newest $KEEP. Run from the repository root, e.g. from cron:
#   0 3 * * * cd ~/pokemon-card-organizer && deploy/backup.sh >> ~/binder-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/binder-backups}"
KEEP="${KEEP:-14}"
# Archives hold the collection and the sign-in accounts: only the owner may read them. Also tightens
# the folder and archives written before this was set (best effort: something we don't own never
# stops the new backup).
umask 077
mkdir -p "$DEST"
chmod 700 "$DEST" 2>/dev/null || true
find "$DEST" -maxdepth 1 -name 'binder-*.tar.gz*' -type f -exec chmod 600 {} + 2>/dev/null || true
file="$DEST/binder-$(date -u +%Y%m%d-%H%M%S).tar.gz"
# Secrets (PriceCharting's token) live in their own volume; never copy them should they be under /data.
docker compose exec -T binder tar czf - --exclude=./secrets -C /data . > "$file.partial"
mv "$file.partial" "$file"
echo "Wrote $file ($(du -h "$file" | cut -f1))"
ls -1t "$DEST"/binder-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
