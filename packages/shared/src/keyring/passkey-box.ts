/**
 * A passkey's box key (#186) from its PRF output - for the tests and vectors only. The app
 * holds the box SEED the sign-in window hands over (`passkeyBoxKeypairFromSeed`,
 * account-secret.ts) and never loads this module: the shared index does not export it, so
 * no app or site bundle carries a PRF-taking derivation (app-holds-no-prf.test.ts), and
 * neither the window nor the door scanner's start-up path pulls in X-Wing for it.
 */
import { passkeyBoxSeed } from "../crypto/passkey-prf.js";
import type { XWingKeypair } from "../crypto/xwing.js";
import { passkeyBoxKeypairFromSeed } from "./account-secret.js";

export function passkeyBoxKeypair(prfSecret: string | Uint8Array): XWingKeypair {
  const seed = passkeyBoxSeed(prfSecret);
  try {
    return passkeyBoxKeypairFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}
