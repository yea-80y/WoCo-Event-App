/**
 * The web side of the derived ISSUING key (issuer-curve migration PR 4).
 *
 * A THIN WRAPPER and nothing more: ensure the POD identity exists, read the
 * seed back, derive. No ceremony, no store writes, no escrow changes — the
 * seed is already escrowed, so recovery restores the issuing key byte-identical
 * at every generation (design record: HANDOVER-pod-curve-migration.md).
 *
 * FAIL LOUD, NEVER FALL THROUGH. If no seed is available this THROWS — it must
 * never quietly hand back some other signer (the feed key, the session key, a
 * fresh random key). Every one of those "works" at signing time and produces
 * credentials that verify against nothing, discovered at a door. The one
 * legitimate no-seed state is a recovered account whose escrow restore has not
 * run (auth-store refuses to re-derive a divergent seed there, #149/#174), and
 * the error says exactly that.
 */

import { deriveIssuingKey, type IssuerAddress } from "@woco/shared";
import { auth } from "./auth-store.svelte.js";
import { restorePodSeed } from "./pod-identity.js";

export interface IssuingKey {
  privateKey: Uint8Array;
  address: IssuerAddress;
}

/**
 * Ensure the signed-in account's generation-`gen` issuing key.
 *
 * Runs `ensurePodIdentity` first (a no-op when the identity exists, the usual
 * case — every calling surface gates on it before building anything), then
 * derives from the stored seed. Throws when no seed can be produced.
 */
export async function ensureIssuingKey(gen = 0): Promise<IssuingKey> {
  const pod = await auth.ensurePodIdentity();
  const podAddr = auth.podAddress;
  const seed = pod && podAddr ? await restorePodSeed(podAddr) : null;
  if (!seed) {
    throw new Error("issuing key unavailable — restore from recovery escrow");
  }
  return deriveIssuingKey(seed, gen);
}
