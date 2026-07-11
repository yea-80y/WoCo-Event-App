/**
 * claimed.v2 owner binding — the platform's issued-to-identity attestation.
 *
 * When a buyer already has a WoCo account at claim time, the ClaimedTicket is
 * born with `owner` (attendee ed25519 pubkey) and this EIP-191 signature over
 * the shared canonical message. Signed by the platform feed signer
 * (FEED_PRIVATE_KEY) — the same key whose address anchors the platform Swarm
 * feeds, so verifiers already have a trust root for it. Cross-protocol reuse
 * with Swarm SOC signing is safe: SOC digests are exactly 32 bytes, this
 * message never is, and the EIP-191 prefix commits to length.
 */

import { Wallet } from "ethers";
import { buildClaimedOwnerV2Message } from "@woco/shared";
import { FEED_PRIVATE_KEY, normalizePk } from "../../config/swarm.js";

let _signer: Wallet | null = null;

function getPlatformSigner(): Wallet {
  if (!_signer) _signer = new Wallet(normalizePk(FEED_PRIVATE_KEY));
  return _signer;
}

/** The address ownerSig recovers to — clients verify against this. */
export function platformBindingAddress(): string {
  return getPlatformSigner().address.toLowerCase();
}

export async function signOwnerBinding(params: {
  eventId: string;
  seriesId: string;
  edition: number;
  /** Attendee ed25519 pubkey, hex, no 0x. */
  owner: string;
  claimedAt: string;
}): Promise<`0x${string}`> {
  const message = buildClaimedOwnerV2Message(params);
  return (await getPlatformSigner().signMessage(message)) as `0x${string}`;
}
