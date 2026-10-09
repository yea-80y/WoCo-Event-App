/**
 * Take the account's current key ring on this device (#186).
 *
 * Run while this passkey's PRF output is in memory (a sign-in or an unlock): the ring's
 * entry for this passkey opens only with the box key the PRF gives. What the chain
 * names is the ring; what this device already holds is never stepped back from:
 *
 *   - the anchor unreadable           -> keep what is held, say so
 *   - no ring                         -> generation 0 (the seed)
 *   - the ring already held           -> nothing to do
 *   - a LOWER generation than held    -> a lagging RPC: keep what is held
 *   - no entry for this passkey       -> keyless: another passkey has to give it keys
 *   - its generation 0 is missing or not our seed -> another lineage: refused, logged
 *   - otherwise                       -> the new chain, to store locked and use
 *
 * Pure: the chain read, the fetch and the box key are passed in.
 */
import type { KeyRing } from "@woco/shared/keyring/ring";
import type { AccountChain } from "../auth/account-chain.js";

export type AdoptResult =
  | { status: "none" }
  | { status: "current" }
  | { status: "adopted"; chain: AccountChain; ring: KeyRing }
  | { status: "keyless"; ring: KeyRing; ref: string }
  | { status: "older"; ringGen: number }
  | { status: "foreign" }
  | { status: "unreadable"; reason: string };

export interface AdoptInput {
  /** The account (Kernel). */
  parent: string;
  /** This passkey's own address - its key on the co-owner list. */
  coOwner: string;
  /** This passkey's box secret key (from its PRF). */
  boxSecretKey: Uint8Array;
  /** The account's identity seed, 0x-hex: generation 0. */
  seed: string;
  /** What this device holds now, if anything. */
  held: AccountChain | null;
  readAnchor(account: string): Promise<string | null | "error">;
  fetchRing(ref: string): Promise<KeyRing>;
}

function hex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function adoptKeyRing(input: AdoptInput): Promise<AdoptResult> {
  const parent = input.parent.toLowerCase();
  const ref = await input.readAnchor(parent);
  if (ref === "error") return { status: "unreadable", reason: "the account's key ring could not be read from the chain" };
  // The contract never clears an entry: "none" with a ring held is a lagging read.
  if (ref === null) return input.held ? { status: "older", ringGen: -1 } : { status: "none" };
  if (input.held?.ringRef === ref) return { status: "current" };

  let ring: KeyRing;
  try {
    ring = await input.fetchRing(ref);
  } catch (e) {
    return { status: "unreadable", reason: `ring ${ref}: ${(e as Error)?.message ?? String(e)}` };
  }
  if (ring.parent !== parent) return { status: "unreadable", reason: `ring ${ref} names another account` };
  if (input.held && ring.gen < input.held.gen) return { status: "older", ringGen: ring.gen };

  const { openKeyRing, KeyRingOpenError } = await import("@woco/shared/keyring/ring");
  let opened;
  try {
    opened = await openKeyRing(ring, { expectedParent: parent, coOwner: input.coOwner, boxSecretKey: input.boxSecretKey });
  } catch (e) {
    if (e instanceof KeyRingOpenError && (e.reason === "not-enrolled" || e.reason === "wrong-key")) {
      return { status: "keyless", ring, ref };
    }
    return { status: "unreadable", reason: `ring ${ref} did not open: ${(e as Error)?.message ?? String(e)}` };
  }
  try {
    const gen0 = ring.gen === 0 ? opened.secret : opened.prior[0];
    // Generation 0 is this account's seed, always: missing or different is another
    // lineage (the parser already refuses a hole there - checked again, not assumed).
    if (!gen0 || hex(gen0) !== input.seed.toLowerCase()) return { status: "foreign" };

    const secrets: string[] = [];
    for (let g = 1; g < ring.gen; g++) {
      const s = opened.prior[g];
      // A hole in the ring that this device itself already had stays filled.
      secrets.push(s ? hex(s) : (input.held?.secrets[g - 1] ?? ""));
    }
    if (ring.gen > 0) secrets.push(hex(opened.secret));
    return { status: "adopted", chain: { ringRef: ref, gen: ring.gen, secrets }, ring };
  } finally {
    opened.secret.fill(0);
    for (const s of opened.prior) s?.fill(0);
  }
}
