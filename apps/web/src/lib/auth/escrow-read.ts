/**
 * What the recovery ceremony does with its escrow read - the one place a
 * locked-out user is told whether their account can come back (#228, #689).
 *
 * Pure apart from the `open` it is handed, so every branch runs under test; the
 * ceremony (`recoverAndRekey` in auth-store) only reads the feed and supplies the
 * guardian's key.
 *
 * Three rules, each a message someone acts on:
 *  - "No backup found" is terminal-sounding, so it answers ONLY a read that every
 *    store answered with "nothing here" - never a read that could not ask one.
 *  - A RETIRED envelope (#642) means "set recovery up again", which a locked-out
 *    user cannot do. It is only that when the scan that chose it was conclusive:
 *    otherwise a newer envelope may sit above it, unseen, and the honest answer is
 *    to try again.
 *  - An envelope from a NEWER app is always that: the fix is to update the app.
 */

import type { RecoveryEnvelope } from "@woco/shared";
import type { ContentFeedResult } from "../swarm/content-feed.js";
import {
  RetiredRecoveryEnvelopeVersionError,
  UnknownRecoveryEnvelopeVersionError,
} from "./recovery-aad.js";

export const ESCROW_UNREACHABLE =
  "We couldn't reach your backup right now — this doesn't mean it's missing. " +
  "Check your connection and try again in a moment.";
export const ESCROW_NONE = "No backup found for that account — recovery isn't possible.";
export const ESCROW_WRONG_WALLET =
  "That backup wallet can't unlock this account. Check you connected the right backup wallet and chose the right account.";

/**
 * Open the escrow the read found and return the account's identity seed, or throw
 * the error the user should see. `open` decrypts one envelope and returns its seed
 * (throwing on anything else).
 */
export async function openEscrow(
  read: ContentFeedResult<RecoveryEnvelope>,
  open: (envelope: RecoveryEnvelope) => Promise<string>,
): Promise<string> {
  if (read.status === "unavailable") throw new Error(ESCROW_UNREACHABLE);
  if (read.status === "absent") throw new Error(ESCROW_NONE);
  try {
    return await open(read.value);
  } catch (e) {
    // The version is public metadata on a public feed, so naming it leaks nothing,
    // and the generic message would send the user hunting through wallets.
    if (e instanceof UnknownRecoveryEnvelopeVersionError) throw e;
    if (e instanceof RetiredRecoveryEnvelopeVersionError) {
      if (!read.scanClean) throw new Error(ESCROW_UNREACHABLE);
      throw e;
    }
    // Don't leak whether it was a wrong account or a corrupt blob.
    throw new Error(ESCROW_WRONG_WALLET);
  }
}
