/**
 * Whether to suggest "Back up your account" — one rule for the studio's safety
 * panel and the member Home.
 *
 * Only passkey and email (Web3Auth) accounts can install recovery; a wallet
 * already recovers from its own seed phrase. And only an inventory read that
 * ANSWERED may produce the suggestion: an unreadable inventory is not "no
 * backups" (#166 item 4), so it stays quiet rather than nag a protected account.
 */

export function canProtectAccount(kind: string | null | undefined): boolean {
  return kind === "passkey" || kind === "web3auth";
}

export function needsBackupPrompt(
  kind: string | null | undefined,
  read: { status: "known"; backups: readonly unknown[] } | { status: "unavailable" } | null,
): boolean {
  return canProtectAccount(kind) && read?.status === "known" && read.backups.length === 0;
}
