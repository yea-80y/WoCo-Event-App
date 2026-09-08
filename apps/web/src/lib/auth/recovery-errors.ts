/**
 * What a recovery failure says to the user.
 *
 * WHY THIS EXISTS (#489). The recovery ceremonies are the only two things a
 * WoCo account still does through ZeroDev — installing a guardian and rotating
 * to a new owner both need the ACCOUNT's own signature, which the sponsor
 * wallet cannot give. The sponsorship plan has a hard monthly cap, and once it
 * is reached the bundler refuses every userOp until the month rolls.
 *
 * The refusal is invisible to the server: userOps go from the browser to
 * ZeroDev directly, so nothing here can count them or warn ahead of time. What
 * the three recovery screens CAN do is stop rendering the bundler's own words.
 * They used to print `e.message` raw, so a paymaster refusal reached a user as
 * "UserOperation reverted ... AA33 paymaster" — text that reads like their
 * account is broken, at the exact moment they are trying to protect or rescue
 * it. It is a platform funding problem and it is temporary, so it says so.
 *
 * Anything that is NOT an account-abstraction failure is the user's own error
 * (a wallet they cancelled, a backup that is already installed) and is passed
 * through unchanged — those messages are written for them and are actionable.
 *
 * Pure: no I/O, no runes. The raw error still goes to the console at each call
 * site, because that is where a developer looks and a user never does.
 */

import { isAccountAbstractionFailure } from "./aa-failure.js";

export type RecoveryErrorMode = "setup" | "recover";

/**
 * Refusing to write because the chain contradicted what the user was just shown
 * (#505) — the add-a-backup preflight in `guardian-hook.checkAddAgainstPriorProtection`.
 *
 * Typed rather than a bare `Error` so the sentence is decided HERE, once, and can
 * never be reworded by a caller or matched by accident: `describeRecoveryError`
 * answers it before the account-abstraction check, because a refusal that never
 * reached a bundler must not be explained as a sponsorship problem. The machine
 * detail rides along in `detail` for the console and stays out of the sentence.
 */
export const STALE_BACKUP_READ_SENTENCE =
  "Couldn't confirm your current backups, so nothing was changed. Try again in a moment.";

export class StaleBackupReadError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(STALE_BACKUP_READ_SENTENCE);
    this.name = "StaleBackupReadError";
    this.detail = detail;
  }
}

export function isStaleBackupRead(e: unknown): e is StaleBackupReadError {
  return e instanceof StaleBackupReadError;
}

const AA_SENTENCE: Record<RecoveryErrorMode, string> = {
  // Setup: nothing has changed on-chain, and saying so is the point — a user who
  // thinks the attempt half-worked will not try again.
  setup: "Recovery setup is temporarily unavailable — your account is fine, try again later",
  // Recover: the user is locked out, so "your account is fine" would be a lie
  // about the thing they are worried about.
  recover: "Recovery is temporarily unavailable — try again later",
};

/**
 * @param fallback what to say when the thrown value is not an `Error` at all —
 *   each screen has its own wording for the step the user was on.
 */
export function describeRecoveryError(
  e: unknown,
  mode: RecoveryErrorMode,
  fallback = "Something went wrong — please try again",
): string {
  if (isStaleBackupRead(e)) return e.message;
  if (isAccountAbstractionFailure(e)) return AA_SENTENCE[mode];
  return e instanceof Error ? e.message : fallback;
}
