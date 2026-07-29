#!/usr/bin/env bash
#
# Nightly off-VM backup of the server's .data directory (#81).
#
# WHY THIS EXISTS: every durable record the platform cannot rebuild lives as a
# single JSON file on one VM with no redundancy —
#
#   marketing-suppression.json   losing it means emailing people who unsubscribed (a legal breach)
#   marketing-consent.json       Art. 7(1) evidence for every opt-in
#   stripe-payout-ledger.json    what each organiser is owed and when it releases
#   stripe-payout-intents.json   the journal that makes releases exactly-once
#   revoked-sessions.json        losing it un-revokes every revoked session
#   consumed-*.json              replay guards; losing them re-opens double-spend windows
#
# The stores are written atomically (lib/marketing/persist.ts), so a snapshot
# taken mid-write reads whole files rather than a truncated one. The tar is
# still taken from a filesystem-level copy first, so a long upload cannot see
# files from two different moments.
#
# USAGE (on the VM, from cron):
#   BACKUP_DEST=/path/or/rsync/target /opt/woco/repo/apps/server/scripts/backup-data.sh
#
# BACKUP_DEST may be a local path (mounted volume, attached storage) or any
# rsync target (user@host:/path). Off-VM is the point: a backup on the same disk
# does not survive the failure it exists for.
#
# Cron example — 03:15 daily, output to syslog:
#   15 3 * * * BACKUP_DEST=user@backup-host:/srv/woco-backups /opt/woco/repo/apps/server/scripts/backup-data.sh 2>&1 | logger -t woco-backup

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/woco/woco-data}"
BACKUP_DEST="${BACKUP_DEST:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [[ -z "$BACKUP_DEST" ]]; then
  echo "FATAL: BACKUP_DEST is not set. Refusing to run — a backup with nowhere to go is not a backup." >&2
  exit 1
fi

if [[ ! -d "$DATA_DIR" ]]; then
  echo "FATAL: DATA_DIR '$DATA_DIR' does not exist." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCHIVE="$WORK/woco-data-$STAMP.tar.gz"

# Snapshot first, then archive: a direct tar of a live directory can capture
# files written minutes apart, which is how you end up with a ledger that
# disagrees with the intent journal.
cp -a "$DATA_DIR" "$WORK/snapshot"

# Fail loudly on an empty source rather than quietly shipping nothing and
# reporting success for months. Counted on FILES, not on compressed bytes:
# these stores are small, repetitive JSON and gzip takes a perfectly valid
# backup well under any plausible byte threshold.
FILE_COUNT=$(find "$WORK/snapshot" -type f | wc -l)
if (( FILE_COUNT == 0 )); then
  echo "FATAL: '$DATA_DIR' contains no files — refusing to publish an empty backup." >&2
  exit 1
fi

tar -czf "$ARCHIVE" -C "$WORK" snapshot

# The archive must actually read back. A truncated or corrupt tar that is only
# discovered at restore time is the same as having no backup at all.
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  echo "FATAL: archive failed its own integrity check — not publishing." >&2
  exit 1
fi

SIZE=$(stat -c%s "$ARCHIVE")

if [[ "$BACKUP_DEST" == *:* ]]; then
  rsync -az --timeout=300 "$ARCHIVE" "$BACKUP_DEST/"
else
  mkdir -p "$BACKUP_DEST"
  cp "$ARCHIVE" "$BACKUP_DEST/"
  # Retention only applies to a local destination — never prune a remote target
  # from here, where a mistyped path would delete someone else's files.
  find "$BACKUP_DEST" -name 'woco-data-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -delete
fi

echo "woco-backup: ok $STAMP (${SIZE} bytes) -> $BACKUP_DEST"
