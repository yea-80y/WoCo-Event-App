/**
 * Putting passkeys into the account's key ring (#186). Lazy: loads the lattice code.
 *
 * A member is a passkey's box key (from its PRF output) with a statement signed by
 * that passkey's own key - so only the device holding a passkey can make its member,
 * and nobody can enrol a key in another passkey's name.
 */
import type { KeyRing, KeyRingMember } from "@woco/shared/keyring/ring";
import type { AccountChain } from "../auth/account-chain.js";

/** The key material one passkey ceremony yields: its owner key (keccak256(prf)) and its PRF output. */
export interface PasskeyKeys {
  address: string;
  privateKey: string;
  prfSecret: string;
}

function bytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** This passkey as a ring member of `parent`. */
export async function memberOf(parent: string, key: PasskeyKeys): Promise<KeyRingMember> {
  const [{ passkeyBoxKeypair }, { signBoxKeyStatement }, { boxKeyRefOf }] = await Promise.all([
    import("@woco/shared/keyring/account-secret"),
    import("@woco/shared/keyring/box-key"),
    import("@woco/shared/keyring/ring"),
  ]);
  const box = passkeyBoxKeypair(key.prfSecret);
  box.secretKey.fill(0);
  const owner = bytes(key.privateKey);
  try {
    const statement = signBoxKeyStatement(
      {
        parent: parent.toLowerCase(),
        coOwner: key.address.toLowerCase(),
        boxKeyRef: boxKeyRefOf(box.publicKey),
        issuedAt: Math.floor(Date.now() / 1000),
      },
      owner,
    );
    return { statement, boxPublicKey: box.publicKey };
  } finally {
    owner.fill(0);
  }
}

/** S_0..S_{gen-1} for a ring at `gen`, from the seed and what this device holds (null = a hole). */
function priorSecrets(seed: string, chain: AccountChain | null, gen: number): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = [bytes(seed)];
  for (let g = 1; g < gen; g++) {
    const s = chain?.secrets[g - 1] ?? "";
    out.push(s ? bytes(s) : null);
  }
  return out.slice(0, gen);
}

/**
 * The account's ring with `add` put in, at the SAME generation - or, with no ring yet,
 * its first (generation 0: the seed). Members the ring already has stay only while their
 * key is still on the account's co-owner list (`onChain`, read from chain), so a ring
 * never re-seals to a passkey that was taken off. A member in `add` replaces any entry
 * for the same passkey.
 */
export async function ringWithMembers(args: {
  parent: string;
  seed: string;
  chain: AccountChain | null;
  current: { ref: string; ring: KeyRing } | null;
  onChain: readonly string[];
  add: KeyRingMember[];
}): Promise<KeyRing> {
  const { buildKeyRing, keyRingMembers, NO_RING } = await import("@woco/shared/keyring/ring");
  const parent = args.parent.toLowerCase();
  const gen = args.current?.ring.gen ?? 0;
  if ((args.chain?.gen ?? 0) !== gen) throw new Error("This device's keys are not the account's current ones - reload and try again.");
  const keep = new Set(args.onChain.map((a) => a.toLowerCase()));
  const adding = new Set(args.add.map((m) => m.statement.coOwner));
  const members = [
    ...(args.current ? keyRingMembers(args.current.ring) : []).filter(
      (m) => keep.has(m.statement.coOwner) && !adding.has(m.statement.coOwner),
    ),
    ...args.add,
  ];
  const secret = bytes(gen === 0 ? args.seed : args.chain!.secrets[gen - 1]!);
  const prior = priorSecrets(args.seed, args.chain, gen);
  try {
    return await buildKeyRing({
      parent,
      gen,
      prev: args.current ? `0x${args.current.ref}` : NO_RING,
      secret,
      prior,
      members,
    });
  } finally {
    secret.fill(0);
    for (const p of prior) p?.fill(0);
  }
}

/** Store a ring for the account to name onchain; returns its reference, checked against its own bytes. */
export async function storeKeyRing(ring: KeyRing): Promise<string> {
  const [{ encodeKeyRing }, { bytesTreeRoot }, { authPost }] = await Promise.all([
    import("@woco/shared/keyring/ring"),
    import("@woco/shared/swarm/bytes-tree"),
    import("../api/client.js"),
  ]);
  const encoded = encodeKeyRing(ring);
  const expected = bytesTreeRoot(encoded);
  let b64 = "";
  for (let i = 0; i < encoded.length; i += 0x8000) b64 += String.fromCharCode(...encoded.subarray(i, i + 0x8000));
  const res = await authPost<{ ref: string }>("/api/keyring/ring", { dataB64: btoa(b64) });
  if (!res.ok || !res.data) throw new Error(res.error ?? "Couldn't save your account's keys - try again.");
  if (res.data.ref !== expected) throw new Error("Your account's keys were not stored as sent - try again.");
  return expected;
}
