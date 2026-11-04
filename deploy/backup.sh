#!/bin/bash
# Nightly backup of the database and uploaded files. Keeps 14 days. Copy the backups off this server as well.
set -euo pipefail
umask 077
DIR=/var/backups/supercars
STAMP=$(date +%F)
mkdir -p "$DIR"
cd "$(dirname "$0")/.."
docker compose exec -T db pg_dump -U supercars -Fc supercars > "$DIR/db-$STAMP.dump"
docker run --rm -v supercars_uploads:/files/uploads:ro -v supercars_private_uploads:/files/private-uploads:ro \
  alpine tar -czf - -C /files uploads private-uploads > "$DIR/files-$STAMP.tar.gz"
find "$DIR" -type f -mtime +14 -delete
