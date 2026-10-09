/**
 * A passkey's BOX KEY statement (#186): "the X-Wing key at `boxKeyRef` is mine,
 * co-owner `coOwner` of account `parent`". Other passkeys of the account seal the
 * account secret to that key when one is removed (`ring.ts`).
 *
 * Signed RAW (EIP-712) by the passkey's own key - the address on the account's
 * onchain co-owner list - never by the account (no ERC-1271). So nobody can state a
 * box key in another passkey's name: a co-owner that is later removed can only ever
 * have published its OWN key, and the ring writer refuses statements whose signer is
 * not on the list it is writing. `parent` stops a statement being replayed on another
 * account. The domain carries the Kernel chain id: the list it is checked against
 * lives there.
 *
 * The box key itself is X-Wing.keygen(HKDF(prf, "", PASSKEY_BOX_INFO, 32))
 * (`crypto/passkey-prf.ts`), published as a content-addressed chunk; `boxKeyRef` is
 * its address, exactly as an order key's (`event/order-key.ts`).
 *
 * Deliberately NOT here: the credential id or a hash of it. The signer already names
 * the passkey, and the statement is public.
 *
 * FROZEN once a statement exists: change the domain or the type and every ring entry
 * written so far names a statement that no longer verifies. `issuedAt` is uint256 on the
 * wire but read as a safe integer (0..2^53-1). A statement carries no freshness and is
 * reused across rings and generations - it names a key, it grants nothing. The 0x1901
 * EIP-712 envelope keeps its digest apart from userOps (personal-sign) and sessions
 * (another domain).
 */

import { KERNEL_CHAIN_ID } from "../kernel/chain.js";
import { recoverTypedStatementSigner, signTypedStatement, type TypedStatement } from "../crypto/digest-signature.js";

export const BOX_KEY_DOMAIN = {
  name: "WoCo Box Key",
  version: "1",
  chainId: KERNEL_CHAIN_ID,
  salt: "0x34b468d42a01f3c5e4454207aced58d78bdb2859507db8fca3de40f58d5277ad",
} as const;

export const BOX_KEY_TYPES = {
  BoxKey: [
    { name: "parent", type: "address" },
    { name: "coOwner", type: "address" },
    { name: "boxKeyRef", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export interface BoxKeyMessage {
  /** The account (Kernel). Lowercase. */
  parent: string;
  /** The passkey's own address - what the onchain co-owner list holds. Lowercase. */
  coOwner: string;
  /** Content address of the 1216-byte X-Wing public key. Lowercase 0x hex. */
  boxKeyRef: string;
  /** Unix seconds, self-declared. Display only. */
  issuedAt: number;
}

export interface BoxKeyStatement extends BoxKeyMessage {
  /** 65-byte signature by `coOwner`, 0x hex. */
  sig: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const SIG = /^0x[0-9a-f]{130}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FIELDS = ["boxKeyRef", "coOwner", "issuedAt", "parent", "sig"];

function typed(m: BoxKeyMessage): TypedStatement {
  return {
    domain: BOX_KEY_DOMAIN,
    primaryType: "BoxKey",
    fields: BOX_KEY_TYPES.BoxKey,
    message: { parent: m.parent, coOwner: m.coOwner, boxKeyRef: m.boxKeyRef, issuedAt: m.issuedAt },
  };
}

/** A box-key statement from untrusted JSON: exact fields, lowercase hex, or null. */
export function parseBoxKeyStatement(x: unknown): BoxKeyStatement | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== FIELDS.join(",")) return null;
  const { parent, coOwner, boxKeyRef, issuedAt, sig } = o;
  if (typeof parent !== "string" || !ADDRESS.test(parent) || parent === ZERO_ADDRESS) return null;
  if (typeof coOwner !== "string" || !ADDRESS.test(coOwner) || coOwner === ZERO_ADDRESS || coOwner === parent) return null;
  if (typeof boxKeyRef !== "string" || !BYTES32.test(boxKeyRef)) return null;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  if (typeof sig !== "string" || !SIG.test(sig)) return null;
  return { parent, coOwner, boxKeyRef, issuedAt, sig };
}

/** Sign a statement with the passkey's own key. The caller zeroes the key. */
export function signBoxKeyStatement(m: BoxKeyMessage, coOwnerPrivateKey: Uint8Array): BoxKeyStatement {
  const msg: BoxKeyMessage = {
    parent: m.parent.toLowerCase(),
    coOwner: m.coOwner.toLowerCase(),
    boxKeyRef: m.boxKeyRef.toLowerCase(),
    issuedAt: m.issuedAt,
  };
  const statement = parseBoxKeyStatement({ ...msg, sig: signTypedStatement(typed(msg), coOwnerPrivateKey) });
  if (!statement) throw new Error("box key statement: malformed fields");
  if (recoverTypedStatementSigner(typed(statement), statement.sig) !== statement.coOwner) {
    throw new Error("box key statement: the signing key is not the stated co-owner");
  }
  return statement;
}

/**
 * The statement, if it parses and its signature recovers to `coOwner`. Says nothing
 * about whether `coOwner` is on the account's list: the caller checks that against
 * the chain at the moment it relies on the key.
 */
export function verifyBoxKeyStatement(x: unknown): BoxKeyStatement | null {
  const s = parseBoxKeyStatement(x);
  if (!s) return null;
  return recoverTypedStatementSigner(typed(s), s.sig) === s.coOwner ? s : null;
}
