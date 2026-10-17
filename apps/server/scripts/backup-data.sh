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
# It also carries the gateway's state from PROXY_DATA_DIR (bee-proxy, default
# /opt/woco/proxy-data): whitelist.json + whitelist.json.log are DATA-PLANE
# state - the gateway serves only the hashes they list, and a client reads its
# refusal as "this chunk does not exist" - and feed-marks.json keeps feed
# answers from stepping back after a restart. Manual *.bak* copies beside them
# are left out. A failure here never costs the .data backup: it is still
# published, without proxy-data/, and the script then exits 1.
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
# BACKUP_GPG_KEY (optional) is the path to an ASCII-armoured PUBLIC key. When set,
# the archive is encrypted to it before it leaves the VM. The private key never
# sits on the VM, so neither the VM nor the backup host can read a backup.
#
# Cron example — 03:15 daily, output to syslog:
#   15 3 * * * BACKUP_DEST=user@backup-host:/srv/woco-backups BACKUP_GPG_KEY=/root/woco-backup.pub.asc /opt/woco/repo/apps/server/scripts/backup-data.sh 2>&1 | logger -t woco-backup
#
# RESTORE, on a machine that holds the private key:
#   gpg --decrypt woco-data-<stamp>.tar.gz.gpg > woco-data.tar.gz
#   tar -xzf woco-data.tar.gz && (cd snapshot && sha256sum -c ../MANIFEST.sha256)
# then copy snapshot/ over the data directory with the server STOPPED (the stores
# are authoritative in memory and would overwrite a restore made under them).
# The gateway's files, likewise with bee-proxy STOPPED (it folds its log into
# whitelist.json on stop):
#   (cd proxy-data && sha256sum -c ../MANIFEST-proxy-data.sha256)
# then copy proxy-data/ over PROXY_DATA_DIR. Restore BOTH whitelist files: the
# snapshot alone can be missing everything added since its last compaction.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/woco/woco-data}"
# Set it to empty to leave the gateway out (a host that runs none).
PROXY_DATA_DIR="${PROXY_DATA_DIR-/opt/woco/proxy-data}"
BACKUP_DEST="${BACKUP_DEST:-}"
BACKUP_GPG_KEY="${BACKUP_GPG_KEY:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"

if [[ -z "$BACKUP_DEST" ]]; then
  echo "FATAL: BACKUP_DEST is not set. Refusing to run — a backup with nowhere to go is not a backup." >&2
  exit 1
fi

if [[ ! -d "$DATA_DIR" ]]; then
  echo "FATAL: DATA_DIR '$DATA_DIR' does not exist." >&2
  exit 1
fi

if [[ -n "$BACKUP_GPG_KEY" && ! -r "$BACKUP_GPG_KEY" ]]; then
  echo "FATAL: BACKUP_GPG_KEY '$BACKUP_GPG_KEY' is not readable — refusing to fall back to an unencrypted backup." >&2
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

# A checksum per file inside the archive, so a restore proves every file came
# back byte for byte rather than only that the tar opened.
(cd "$WORK/snapshot" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$WORK/MANIFEST.sha256"

# The gateway rewrites whitelist.json by rename at each compaction and only then
# empties its log, so a copy that straddles a rename can pair the old snapshot
# with the new, emptied log - losing every add in between. The inode moves on
# every rename, so an unchanged one means the pair is consistent; otherwise copy
# again. The JSON check also catches a gateway build that still writes the file
# in place. Prints the entry count; any failure is reported on stderr.
copy_proxy_data() {
  local dest="$WORK/proxy-data" attempt before after
  if [[ ! -f "$PROXY_DATA_DIR/whitelist.json" ]]; then
    echo "'$PROXY_DATA_DIR/whitelist.json' does not exist" >&2
    return 1
  fi
  for attempt in 1 2 3 4 5; do
    rm -rf "$dest"
    before=$(stat -c %i "$PROXY_DATA_DIR/whitelist.json") || return 1
    # A file changing under rsync (the log emptied mid-copy) is the case this loop
    # exists for, so an rsync error is another attempt, not the end of the night.
    if ! rsync -a --exclude='*.bak*' --exclude='*.tmp' "$PROXY_DATA_DIR/" "$dest/"; then
      echo "proxy-data copy $attempt: rsync failed, retrying" >&2
      sleep 2
      continue
    fi
    after=$(stat -c %i "$PROXY_DATA_DIR/whitelist.json") || return 1
    if [[ "$before" == "$after" ]] && python3 -I -c '
import json, re, sys
try:
    entries = json.load(open(sys.argv[1]))
except ValueError:
    sys.exit(1)
if not isinstance(entries, list) or not entries or not all(isinstance(h, str) and re.fullmatch(r"[0-9a-fA-F]{64}", h) for h in entries):
    sys.exit(1)
print(len(entries))
' "$dest/whitelist.json"; then
      return 0
    fi
    echo "proxy-data copy $attempt was inconsistent or not a non-empty hash list, retrying" >&2
    sleep 2
  done
  echo "no consistent copy of '$PROXY_DATA_DIR' in 5 attempts" >&2
  return 1
}

PARTS=(snapshot MANIFEST.sha256)
PROXY_STATUS="proxy-data FAILED"
if [[ -z "$PROXY_DATA_DIR" ]]; then
  PROXY_STATUS="proxy-data skipped (PROXY_DATA_DIR empty)"
elif WHITELIST_ENTRIES=$(copy_proxy_data); then
  (cd "$WORK/proxy-data" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$WORK/MANIFEST-proxy-data.sha256"
  PARTS+=(proxy-data MANIFEST-proxy-data.sha256)
  PROXY_STATUS="proxy-data ok, whitelist ${WHITELIST_ENTRIES} entries"
else
  rm -rf "$WORK/proxy-data"
fi

tar -czf "$ARCHIVE" -C "$WORK" "${PARTS[@]}"

# The archive must actually read back. A truncated or corrupt tar that is only
# discovered at restore time is the same as having no backup at all.
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  echo "FATAL: archive failed its own integrity check — not publishing." >&2
  exit 1
fi

OUT="$ARCHIVE"
MODE="PLAINTEXT"
if [[ -n "$BACKUP_GPG_KEY" ]]; then
  # A throwaway keyring: nothing is imported into root's, and the key is used
  # for this one encryption only.
  mkdir -m 700 "$WORK/gnupg"
  gpg --batch --no-tty --quiet --homedir "$WORK/gnupg" --trust-model always \
    --recipient-file "$BACKUP_GPG_KEY" --output "$ARCHIVE.gpg" --encrypt "$ARCHIVE"
  if [[ ! -s "$ARCHIVE.gpg" ]]; then
    echo "FATAL: encryption produced no output — not publishing." >&2
    exit 1
  fi
  OUT="$ARCHIVE.gpg"
  MODE="encrypted"
fi

SIZE=$(stat -c%s "$OUT")

if [[ "$BACKUP_DEST" == *:* ]]; then
  rsync -az --timeout=300 "$OUT" "$BACKUP_DEST/"
else
  mkdir -p "$BACKUP_DEST"
  cp "$OUT" "$BACKUP_DEST/"
  # Retention only applies to a local destination — never prune a remote target
  # from here, where a mistyped path would delete someone else's files.
  find "$BACKUP_DEST" -name 'woco-data-*.tar.gz*' -type f -mtime "+$KEEP_DAYS" -delete
fi

if [[ "$PROXY_STATUS" == "proxy-data FAILED" ]]; then
  echo "woco-backup: PARTIAL $STAMP $MODE (${SIZE} bytes, ${FILE_COUNT} files, $PROXY_STATUS - see above) -> $BACKUP_DEST" >&2
  exit 1
fi
echo "woco-backup: ok $STAMP $MODE (${SIZE} bytes, ${FILE_COUNT} files, $PROXY_STATUS) -> $BACKUP_DEST"
