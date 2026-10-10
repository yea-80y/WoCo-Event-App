/**
 * The organiser's order keys across generations (#186). Orders and contact lists are
 * sealed to the CURRENT generation's key; ones sealed before a passkey was removed
 * stay sealed to an older one. A box does not name its recipient, so opening tries
 * each key this device holds, newest first - a wrong key just fails its tag.
 *
 * Lazy: loads the lattice code.
 */
import type { SealContext } from "@woco/shared/crypto/sealed-box";

export interface OrderKeys {
  /** The current generation's public key: what new boxes are sealed to. */
  publicKey: Uint8Array;
  /** Every generation's secret key this device holds, newest first. */
  secretKeys: Uint8Array[];
}

export async function orderKeysOf(secrets: { current: string; all: string[] }): Promise<OrderKeys> {
  const { deriveXWingKeypairFromSeed } = await import("@woco/shared/crypto/xwing");
  return {
    publicKey: deriveXWingKeypairFromSeed(secrets.current).publicKey,
    secretKeys: [...secrets.all].reverse().map((s) => deriveXWingKeypairFromSeed(s).secretKey),
  };
}

/** Open a JSON box with whichever key it was sealed to. Throws the last failure when none opens it. */
export async function openJsonWithAnyKey<T>(secretKeys: Uint8Array[], box: unknown, ctx: SealContext): Promise<T> {
  const { openBoxJson } = await import("@woco/shared/crypto/sealed-box");
  let last: unknown = new Error("no order key on this device");
  for (const sk of secretKeys) {
    try {
      return await openBoxJson<T>(sk, box, ctx);
    } catch (e) {
      last = e;
      // A box in a format this build cannot read fails the same way for every key.
      if (e instanceof Error && e.name === "UnsupportedSealedBoxError") break;
    }
  }
  throw last;
}
