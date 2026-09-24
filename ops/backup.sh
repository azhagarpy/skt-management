#!/usr/bin/env bash
#
# Nightly backup of the payroll database and the uploaded documents.
#
# Produces two files per run, then optionally encrypts them and copies them
# off the server with rclone. Keeps the last KEEP_DAYS locally so a restore
# does not depend on the off-site copy being reachable.
#
# Settings live in /opt/skt/backup.env (not in git, because it holds the
# passphrase). Every one of them is optional:
#
#   BACKUP_PASSPHRASE   Encrypt each archive with AES256 before it leaves the
#                       server. Strongly recommended: these files contain
#                       Aadhaar, PAN, bank accounts and wages for every
#                       employee, and an off-site copy is outside your control.
#   RCLONE_REMOTE       An rclone remote and path, e.g. "gdrive:SKT Backups".
#                       Nothing is uploaded when this is unset.
#   KEEP_DAYS           Local copies to retain (default 14).
#
set -uo pipefail

DB_NAME=skt_payroll
STORAGE_DIR=/opt/skt/storage
BACKUP_DIR=/opt/skt/backups
LOG=/var/log/skt-backup.log
CONFIG=/opt/skt/backup.env

[ -f "$CONFIG" ] && . "$CONFIG"
KEEP_DAYS="${KEEP_DAYS:-14}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"

stamp=$(date +%Y%m%d-%H%M%S)
log() { echo "$(date -Is) $*" >> "$LOG"; }
fail() { log "FAILED: $*"; exit 1; }

mkdir -p "$BACKUP_DIR"
log "=== backup $stamp starting ==="

# --- database -------------------------------------------------------------
# Custom format: compressed, and restorable table-by-table with pg_restore.
db_file="$BACKUP_DIR/skt-db-$stamp.dump"
sudo -u postgres pg_dump -Fc -d "$DB_NAME" -f "$db_file" 2>>"$LOG" || fail "pg_dump"
[ -s "$db_file" ] || fail "pg_dump produced an empty file"

# Verify the dump is readable before trusting it. A backup nobody has opened
# is a guess, not a backup.
sudo -u postgres pg_restore --list "$db_file" >/dev/null 2>>"$LOG" || fail "dump is not readable by pg_restore"
log "database: $(du -h "$db_file" | cut -f1) ($(sudo -u postgres pg_restore --list "$db_file" | grep -c 'TABLE DATA') tables with data)"

# --- uploaded documents ---------------------------------------------------
store_file="$BACKUP_DIR/skt-storage-$stamp.tar.gz"
tar -czf "$store_file" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")" 2>>"$LOG" \
  || fail "tar of $STORAGE_DIR"
log "documents: $(du -h "$store_file" | cut -f1)"

files=("$db_file" "$store_file")

# --- encryption -----------------------------------------------------------
if [ -n "$BACKUP_PASSPHRASE" ]; then
  encrypted=()
  for f in "${files[@]}"; do
    printf '%s' "$BACKUP_PASSPHRASE" \
      | gpg --batch --yes --quiet --passphrase-fd 0 --cipher-algo AES256 --symmetric -o "$f.gpg" "$f" 2>>"$LOG" \
      || fail "gpg encrypt of $(basename "$f")"
    rm -f "$f"
    encrypted+=("$f.gpg")
  done
  files=("${encrypted[@]}")
  log "encrypted with AES256"
else
  log "WARNING: BACKUP_PASSPHRASE is not set - archives hold unencrypted personal data"
fi

# --- off-site copy --------------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if ! command -v rclone >/dev/null; then
    log "WARNING: RCLONE_REMOTE is set but rclone is not installed; skipping upload"
  else
    for f in "${files[@]}"; do
      rclone copy "$f" "$RCLONE_REMOTE" --log-file "$LOG" --log-level INFO \
        || { log "WARNING: upload of $(basename "$f") failed; local copy kept"; continue; }
      log "uploaded $(basename "$f")"
    done
    # Mirror the local retention window remotely so the folder does not grow
    # without limit.
    rclone delete "$RCLONE_REMOTE" --min-age "${KEEP_DAYS}d" --log-file "$LOG" --log-level INFO \
      || log "WARNING: remote prune failed"
  fi
else
  log "no RCLONE_REMOTE configured - local copies only"
fi

# --- retention ------------------------------------------------------------
removed=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'skt-*' -mtime "+$KEEP_DAYS" -print -delete | wc -l)
log "pruned $removed local file(s) older than $KEEP_DAYS days"
log "=== backup $stamp done: $(ls -1 "$BACKUP_DIR" | wc -l) file(s), $(du -sh "$BACKUP_DIR" | cut -f1) on disk ==="
