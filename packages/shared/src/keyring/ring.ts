/**
 * The account's KEY RING (#186): the current account secret, sealed to every passkey
 * that should hold it, plus every earlier secret under the current one.
 *
 *   ring    = { v: 1, parent, gen, prev, feedSigner, orderKeyRef, entries, back }
 *   entry   = { statement: BoxKeyStatement, boxKey, box: sealBox(S_g, boxKey, entry context) }
 *   back    = AES-256-GCM(HKDF(S_g, "", "woco/keyring/back/v1"), S_0 ‖ … ‖ S_{g-1})
 *
 * WHERE ITS AUTHORITY COMES FROM. The ring is stored as content-addressed bytes, and
 * the account itself records that address onchain (the key-ring anchor contract), in
 * the same operation that adds or removes a passkey. Only a passkey on the account's
 * co-owner list can make the account do that, so the ring carries no signature of its
 * own: a reader trusts exactly the ring the chain names, and the bytes are checked
 * against that address before they are parsed. `prev` names the anchor value this ring
 * replaced, so a device sees when the ring moved past one it never opened.
 *
 * Every entry is a box-key statement signed by its passkey, with the key itself, so the
 * writer seals only to keys their own passkeys stated, and the next writer can seal to the
 * same members from this ring alone - nothing else to fetch; the AAD binds the entry to the account, generation,
 * passkey and key, so an entry moved to another slot fails its tag. The back blob makes
 * the newest ring enough on its own: one entry opened gives every generation's keys,
 * which is what reading older orders needs. A generation the writer could not open
 * (a ring it was left out of) is a HOLE: 32 zero bytes, listed in `holes`.
 *
 * Generation 0 is the identity seed, so a ring at gen 0 has an empty back. Adding a
 * passkey writes a new ring at the SAME generation (same secret, one more entry);
 * removing one writes gen + 1 with a fresh secret and no entry for it.
 *
 * Import by subpath, lazily in the browser: this loads the lattice code.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { MAX_CO_OWNERS } from "../kernel/co-owners.js";
import { isOrderKeyRef, orderKeyRef } from "../event/order-key.js";
import { openBox, sealBox, type SealContext } from "../crypto/sealed-box.js";
import { isSealedBoxV2, type SealedBoxV2 } from "../crypto/sealed-box-shape.js";
import { XWING_PUBLIC_KEY_BYTES } from "../crypto/xwing.js";
import { accountKeysOf, assertAccountSecret, ACCOUNT_SECRET_BYTES } from "./account-secret.js";
import { verifyBoxKeyStatement, type BoxKeyStatement } from "./box-key.js";

/** Current ring format. Any other `v` is refused, never read as v1 or written over. */
export const KEY_RING_VERSION = 1 as const;

/** HPKE info for a ring entry. FROZEN: change it and no entry sealed so far opens. */
export const KEY_RING_ENTRY_INFO = "woco/keyring/entry/v1";

/** HKDF info for the back blob's key, also the prefix of its AAD. FROZEN. */
export const KEY_RING_BACK_INFO = "woco/keyring/back/v1";

/** The anchor value of an account that has never had a ring. */
export const NO_RING = `0x${"0".repeat(64)}`;

/** The largest generation a ring may name: keeps the back blob small and every count exact. */
export const MAX_KEY_RING_GEN = 1000;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]*$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const RING_FIELDS = ["back", "entries", "feedSigner", "gen", "orderKeyRef", "parent", "prev", "v"];
const ENTRY_FIELDS = ["box", "boxKey", "statement"];
const BOX_KEY_HEX = XWING_PUBLIC_KEY_BYTES * 2;
const BACK_FIELDS = ["ct", "holes", "iv"];

export interface KeyRingEntry {
  statement: BoxKeyStatement;
  /** The 1216-byte X-Wing public key the statement names, hex. */
  boxKey: string;
  box: SealedBoxV2;
}

export interface KeyRingBack {
  iv: string;
  ct: string;
  /** Generations below `gen` whose secret the writer did not have, ascending. */
  holes: number[];
}

export interface KeyRing {
  v: typeof KEY_RING_VERSION;
  parent: string;
  gen: number;
  /** The anchor value this ring replaced (`NO_RING` for the first). */
  prev: string;
  /** The content-feed signer of this generation's secret. */
  feedSigner: string;
  /** The order key of this generation's secret (64 hex, as events name it). */
  orderKeyRef: string;
  entries: KeyRingEntry[];
  back: KeyRingBack;
}

/** A ring of a version this build does not read. Say "update the app"; never write. */
export class UnsupportedKeyRingError extends Error {
  constructor(v: unknown) {
    super(`unsupported key ring version: ${String(v)}`);
    this.name = "UnsupportedKeyRingError";
  }
}

/** Bytes that claim to be a v1 ring and are not one. */
export class MalformedKeyRingError extends Error {
  constructor(detail: string) {
    super(`malformed key ring: ${detail}`);
    this.name = "MalformedKeyRingError";
  }
}

/**
 * Why a ring did not open for this passkey.
 * - `other-account`: the ring names a different account.
 * - `not-enrolled`: no entry for this passkey (it was left out, or removed).
 * - `wrong-key`: an entry is there but this box key does not open it.
 * - `key-mismatch`: it opened, but not to the secret whose keys the ring states.
 */
export type KeyRingOpenFailure = "other-account" | "not-enrolled" | "wrong-key" | "key-mismatch";

export class KeyRingOpenError extends Error {
  constructor(readonly reason: KeyRingOpenFailure) {
    super(`key ring did not open: ${reason}`);
    this.name = "KeyRingOpenError";
  }
}

function assertGen(gen: number): number {
  if (!Number.isSafeInteger(gen) || gen < 0 || gen > MAX_KEY_RING_GEN) {
    throw new Error(`key ring: gen must be an integer 0..${MAX_KEY_RING_GEN}`);
  }
  return gen;
}

function assertAddress(a: string, what: string): string {
  if (!ADDRESS.test(a)) throw new Error(`key ring: ${what} must be a lowercase 20-byte address`);
  return a;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * The context an entry is sealed under. Addresses and refs are lowercase hex, so ":"
 * cannot occur inside a part and the string is unambiguous.
 */
export function keyRingEntryContext(parent: string, gen: number, coOwner: string, boxKeyRef: string): SealContext {
  assertAddress(parent, "parent");
  assertGen(gen);
  assertAddress(coOwner, "coOwner");
  if (!BYTES32.test(boxKeyRef)) throw new Error("key ring: boxKeyRef must be lowercase bytes32 hex");
  return { info: KEY_RING_ENTRY_INFO, aad: `${KEY_RING_ENTRY_INFO}:${parent}:${gen}:${coOwner}:${boxKeyRef}` };
}

/** The AAD of a ring's back blob. */
export function keyRingBackAad(parent: string, gen: number): string {
  return `${KEY_RING_BACK_INFO}:${assertAddress(parent, "parent")}:${assertGen(gen)}`;
}

/** The `boxKeyRef` a statement names for a box public key (bytes32 form of its chunk address). */
export function boxKeyRefOf(publicKey: Uint8Array): string {
  return `0x${orderKeyRef(publicKey)}`;
}

async function backKey(secret: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const raw = hkdf(sha256, assertAccountSecret(secret), new Uint8Array(0), utf8ToBytes(KEY_RING_BACK_INFO), 32);
  try {
    return await crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/** Seal the earlier secrets under this generation's. `prior[i]` is S_i; null = a hole. */
async function sealBack(secret: Uint8Array, parent: string, gen: number, prior: (Uint8Array | null)[]): Promise<KeyRingBack> {
  if (prior.length !== gen) throw new Error(`key ring: gen ${gen} needs exactly ${gen} earlier secrets`);
  const plain = new Uint8Array(gen * ACCOUNT_SECRET_BYTES);
  const holes: number[] = [];
  prior.forEach((s, i) => {
    if (s === null) holes.push(i);
    else plain.set(assertAccountSecret(s), i * ACCOUNT_SECRET_BYTES);
  });
  if (gen > 0 && holes.length === gen) throw new Error("key ring: every earlier generation is a hole");
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8ToBytes(keyRingBackAad(parent, gen))) },
      await backKey(secret, "encrypt"),
      buf(plain),
    );
    return { iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)), holes };
  } finally {
    plain.fill(0);
  }
}

async function openBack(secret: Uint8Array, ring: KeyRing): Promise<(Uint8Array | null)[]> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buf(hexToBytes(ring.back.iv)),
          additionalData: buf(utf8ToBytes(keyRingBackAad(ring.parent, ring.gen))),
        },
        await backKey(secret, "decrypt"),
        buf(hexToBytes(ring.back.ct)),
      ),
    );
  } catch {
    throw new KeyRingOpenError("key-mismatch");
  }
  const holes = new Set(ring.back.holes);
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < ring.gen; i++) {
    out.push(holes.has(i) ? null : plain.slice(i * ACCOUNT_SECRET_BYTES, (i + 1) * ACCOUNT_SECRET_BYTES));
  }
  plain.fill(0);
  return out;
}

export interface KeyRingMember {
  /** The passkey's verified statement. */
  statement: BoxKeyStatement;
  /** The 1216-byte public key the statement's `boxKeyRef` names. */
  boxPublicKey: Uint8Array;
}

/**
 * A ring for `secret` at `gen`, sealed to `members`. `prior` are the earlier
 * secrets S_0..S_{gen-1} (null where the writer has none). The caller decides WHO the
 * members are - the account's co-owner list read from chain, less any being removed -
 * and refuses statements whose signer is not on it; this checks each statement's own
 * signature, that it names this account, and that the key matches its ref.
 */
export async function buildKeyRing(args: {
  parent: string;
  gen: number;
  prev: string;
  secret: Uint8Array;
  prior: (Uint8Array | null)[];
  members: KeyRingMember[];
}): Promise<KeyRing> {
  const parent = assertAddress(args.parent.toLowerCase(), "parent");
  const gen = assertGen(args.gen);
  if (!BYTES32.test(args.prev)) throw new Error("key ring: prev must be lowercase bytes32 hex");
  const keys = accountKeysOf(args.secret);
  const entries: KeyRingEntry[] = [];
  for (const m of args.members) {
    const statement = verifyBoxKeyStatement(m.statement);
    if (!statement) throw new Error("key ring: a member's box key statement does not verify");
    if (boxKeyRefOf(m.boxPublicKey) !== statement.boxKeyRef) throw new Error("key ring: a member's box key does not match its statement");
    const box = await sealBox(m.boxPublicKey, args.secret, keyRingEntryContext(parent, gen, statement.coOwner, statement.boxKeyRef));
    entries.push({ statement, boxKey: bytesToHex(m.boxPublicKey), box });
  }
  const ring: KeyRing = {
    v: KEY_RING_VERSION,
    parent,
    gen,
    prev: args.prev,
    feedSigner: keys.feedSigner.address,
    orderKeyRef: keys.orderKeyRef,
    entries,
    back: await sealBack(args.secret, parent, gen, args.prior),
  };
  // Round-trip through the parser: what is written is exactly what readers accept.
  return parseKeyRing(JSON.parse(JSON.stringify(ring)));
}

/** The bytes a ring is stored as. */
export function encodeKeyRing(ring: KeyRing): Uint8Array {
  return utf8ToBytes(JSON.stringify(parseKeyRing(ring)));
}

function malformed(detail: string): never {
  throw new MalformedKeyRingError(detail);
}

function exactFields(o: Record<string, unknown>, fields: string[], what: string): void {
  if (Object.keys(o).sort().join(",") !== fields.join(",")) malformed(`${what} must have exactly ${fields.join(", ")}`);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * A v1 ring from untrusted JSON (or its bytes), or a throw. Closed schema, lowercase
 * hex, 1..MAX_CO_OWNERS entries, one per passkey, every statement verifying and naming
 * this account, the back blob exactly as long as `gen` secrets. Any other `v` is
 * `UnsupportedKeyRingError`.
 */
export function parseKeyRing(x: unknown): KeyRing {
  if (x instanceof Uint8Array) {
    try {
      x = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(x));
    } catch {
      malformed("not UTF-8 JSON");
    }
  }
  if (!isPlainObject(x)) malformed("not an object");
  const o = x;
  if (o.v !== KEY_RING_VERSION) throw new UnsupportedKeyRingError(o.v);
  exactFields(o, RING_FIELDS, "ring");
  const { parent, gen, prev, feedSigner, orderKeyRef: okr, entries, back } = o;
  if (typeof parent !== "string" || !ADDRESS.test(parent)) malformed("parent");
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0 || gen > MAX_KEY_RING_GEN) malformed("gen");
  if (typeof prev !== "string" || !BYTES32.test(prev)) malformed("prev");
  if (typeof feedSigner !== "string" || !ADDRESS.test(feedSigner)) malformed("feedSigner");
  if (!isOrderKeyRef(okr)) malformed("orderKeyRef");

  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_CO_OWNERS) {
    malformed(`entries must hold 1..${MAX_CO_OWNERS}`);
  }
  const seen = new Set<string>();
  const parsedEntries: KeyRingEntry[] = entries.map((e) => {
    if (!isPlainObject(e)) malformed("entry");
    exactFields(e, ENTRY_FIELDS, "entry");
    const statement = verifyBoxKeyStatement(e.statement);
    if (!statement) malformed("an entry's statement does not verify");
    if (statement.parent !== parent) malformed("an entry's statement names another account");
    if (seen.has(statement.coOwner)) malformed("two entries for one passkey");
    seen.add(statement.coOwner);
    if (typeof e.boxKey !== "string" || e.boxKey.length !== BOX_KEY_HEX || !HEX.test(e.boxKey)) malformed("an entry's box key");
    if (boxKeyRefOf(hexToBytes(e.boxKey)) !== statement.boxKeyRef) malformed("an entry's box key is not the one its statement names");
    if (!isSealedBoxV2(e.box) || e.box.ct.length !== (ACCOUNT_SECRET_BYTES + TAG_BYTES) * 2) malformed("an entry's box");
    if (!HEX.test(e.box.enc) || !HEX.test(e.box.ct)) malformed("an entry's box is not lowercase hex");
    return { statement, boxKey: e.boxKey, box: { v: e.box.v, enc: e.box.enc, ct: e.box.ct } };
  });

  if (!isPlainObject(back)) malformed("back");
  exactFields(back, BACK_FIELDS, "back");
  const { iv, ct, holes } = back;
  if (typeof iv !== "string" || iv.length !== IV_BYTES * 2 || !HEX.test(iv)) malformed("back.iv");
  if (typeof ct !== "string" || ct.length !== (gen * ACCOUNT_SECRET_BYTES + TAG_BYTES) * 2 || !HEX.test(ct)) {
    malformed("back.ct must hold exactly gen secrets");
  }
  if (!Array.isArray(holes) || holes.some((h, i) => !Number.isSafeInteger(h) || h < 0 || h >= gen || (i > 0 && h <= holes[i - 1]))) {
    malformed("back.holes must be ascending generations below gen");
  }
  if (gen > 0 && holes.length === gen) malformed("every earlier generation is a hole");

  return {
    v: KEY_RING_VERSION,
    parent,
    gen,
    prev,
    feedSigner,
    orderKeyRef: okr,
    entries: parsedEntries,
    back: { iv, ct, holes: [...(holes as number[])] },
  };
}

export interface OpenedKeyRing {
  gen: number;
  /** S_gen. The caller stores it locked and zeroes this copy. */
  secret: Uint8Array;
  /** S_0..S_{gen-1}; null where the ring has a hole. */
  prior: (Uint8Array | null)[];
}

/**
 * Open a ring with this passkey's box key. `expectedParent` is the account the caller
 * is signed in as. The opened secret must give exactly the feed signer and order key the
 * ring states, so a ring that decrypts to anything else is never adopted.
 */
export async function openKeyRing(
  ring: KeyRing,
  args: { expectedParent: string; coOwner: string; boxSecretKey: Uint8Array },
): Promise<OpenedKeyRing> {
  if (ring.parent !== args.expectedParent.toLowerCase()) throw new KeyRingOpenError("other-account");
  const coOwner = args.coOwner.toLowerCase();
  const entry = ring.entries.find((e) => e.statement.coOwner === coOwner);
  if (!entry) throw new KeyRingOpenError("not-enrolled");
  let secret: Uint8Array;
  try {
    secret = await openBox(
      args.boxSecretKey,
      entry.box,
      keyRingEntryContext(ring.parent, ring.gen, coOwner, entry.statement.boxKeyRef),
    );
  } catch {
    throw new KeyRingOpenError("wrong-key");
  }
  if (secret.length !== ACCOUNT_SECRET_BYTES) {
    secret.fill(0);
    throw new KeyRingOpenError("key-mismatch");
  }
  const keys = accountKeysOf(secret);
  if (keys.feedSigner.address !== ring.feedSigner || keys.orderKeyRef !== ring.orderKeyRef) {
    secret.fill(0);
    throw new KeyRingOpenError("key-mismatch");
  }
  try {
    return { gen: ring.gen, secret, prior: await openBack(secret, ring) };
  } catch (e) {
    secret.fill(0);
    throw e;
  }
}

/**
 * Which of `coOwners` (the account's list, from chain) the ring has no entry for.
 * A writer warns about these before it writes; a reader that finds itself here was
 * left out and must be given the keys again.
 */
export function coOwnersWithoutEntry(ring: KeyRing, coOwners: readonly string[]): string[] {
  const have = new Set(ring.entries.map((e) => e.statement.coOwner));
  return coOwners.map((c) => c.toLowerCase()).filter((c) => !have.has(c));
}

/**
 * The ring's members as the next writer seals to them: each statement with its key.
 * `except` leaves passkeys out (the one being removed). The caller still checks every
 * member against the account's list on chain - a ring names who WAS a member.
 */
export function keyRingMembers(ring: KeyRing, except: readonly string[] = []): KeyRingMember[] {
  const drop = new Set(except.map((a) => a.toLowerCase()));
  return ring.entries
    .filter((e) => !drop.has(e.statement.coOwner))
    .map((e) => ({ statement: e.statement, boxPublicKey: hexToBytes(e.boxKey) }));
}

