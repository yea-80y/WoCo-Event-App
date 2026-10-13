/**
 * Whether to suggest "Back up your account" — one rule for the dashboard's safety
 * panel and the member Home.
 *
 * Only passkey and email (Web3Auth) accounts can install recovery; a wallet
 * already recovers from its own seed phrase. And only an inventory read that
 * ANSWERED may produce the suggestion: an unreadable inventory is not "no
 * backups" (#166 item 4), so it stays quiet rather than nag a protected account.
 */

import { FEATURES } from "@woco/shared";

export function canProtectAccount(kind: string | null | undefined): boolean {
  if (kind === "web3auth") return FEATURES.accountBackupsAllowed;
  return kind === "passkey";
}

export function needsBackupPrompt(
  kind: string | null | undefined,
  read: { status: "known"; backups: readonly unknown[] } | { status: "unavailable" } | null,
): boolean {
  // A passkey account adds no backup on Protect (#746 step 5): its way back is the
  // devices it links, which Your passkeys will report once it can say whether one
  // of them can recover the account. Until then it is not asked.
  if (kind === "passkey") return false;
  return canProtectAccount(kind) && read?.status === "known" && read.backups.length === 0;
}

/**
 * Where "back up your account" goes. A passkey account backs up by linking another
 * device and letting it recover the account (#746 step 5): an email or wallet
 * backup would hold a copy of keys that attendee data may later be sealed to.
 */
export function backupPath(kind: string | null | undefined): "/passkeys" | "/protect" {
  return kind === "passkey" ? "/passkeys" : "/protect";
}
