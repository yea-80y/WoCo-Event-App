/**
 * A real key ring at the anchor for one account (#186): built with the shared
 * primitives, served chunk by chunk, so the server's read is exercised end to end.
 */
import { Wallet } from "ethers";
import { buildKeyRing, encodeKeyRing, NO_RING, boxKeyRefOf } from "@woco/shared/keyring/ring";
import { accountKeysOf, newAccountSecret, passkeyBoxKeypair } from "@woco/shared/keyring/account-secret";
import { signBoxKeyStatement } from "@woco/shared/keyring/box-key";
import { bytesTreeChunks, bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import { _setCurrentRingDepsForTests } from "../../src/lib/keyring/current-ring.js";

export async function installRing(account: string, gen = 1): Promise<{ ref: string; feedSigner: string; orderKeyRef: string }> {
  const priv = new Uint8Array(32).fill(3);
  const coOwner = new Wallet(`0x${"03".repeat(32)}`).address.toLowerCase();
  const box = passkeyBoxKeypair(new Uint8Array(32).fill(5));
  const secret = newAccountSecret();
  const ring = await buildKeyRing({
    parent: account,
    gen,
    prev: NO_RING,
    secret,
    prior: Array.from({ length: gen }, () => newAccountSecret()),
    members: [
      {
        statement: signBoxKeyStatement({ parent: account, coOwner, boxKeyRef: boxKeyRefOf(box.publicKey), issuedAt: 1 }, priv),
        boxPublicKey: box.publicKey,
      },
    ],
  });
  const bytes = encodeKeyRing(ring);
  const chunks = new Map(bytesTreeChunks(bytes).map((c) => [c.address, c.chunk]));
  const ref = bytesTreeRoot(bytes);
  _setCurrentRingDepsForTests({
    readAnchor: async (a) => (a === account ? `0x${ref}` : NO_RING),
    fetchChunk: async (addr) => chunks.get(addr) ?? Promise.reject(new Error("absent")),
  });
  const k = accountKeysOf(secret);
  return { ref, feedSigner: k.feedSigner.address, orderKeyRef: k.orderKeyRef };
}

/** No account has a ring; or, with `down`, the chain cannot be read. */
export function noRings(opts: { down?: boolean } = {}): void {
  _setCurrentRingDepsForTests({
    readAnchor: async () => {
      if (opts.down) throw new Error("rpc down");
      return NO_RING;
    },
  });
}
