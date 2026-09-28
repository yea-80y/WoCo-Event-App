/**
 * The attendee-data key (ADK) and the vault that carries it (#746).
 *
 * WHY A KEY OF ITS OWN. Orders and contact lists are sealed to the organiser and sit
 * on public storage for good (every order's address is emitted onchain at mint). They
 * must stay closed to anyone who can later compute discrete logs. The identity seed
 * cannot promise that for every kind of account: an email or wallet account's seed is
 * a signature, and every seed travels in the recovery escrow to a guardian whose key
 * may be a signature too. So attendee data gets a key that nothing curve-based leads
 * to: 32 random bytes, reachable only through symmetric wraps.
 *
 *   adkSeed           = 32 random bytes (X-Wing's own `sk`, so there is one route)
 *   ADK               = X-Wing.keygen(adkSeed)
 *   ref               = orderKeyRef(ADK public key)   what every event publishes
 *   passkey KEK       = HKDF(prf, "", PASSKEY_ATTENDEE_DATA_KEK_INFO, 32)   passkey-prf.ts
 *   recovery-code KEK = HKDF(code, parent, RECOVERY_CODE_KEK_INFO, 32)
 *   wrap              = AES-256-GCM(KEK, 12 random bytes, adkSeed, vaultAad(parent, gen, ref))
 *
 * THE VAULT is `{ v: 1, parent, gen, ref, unlockers }` on the account's own versioned
 * feed. Everything in it is public (the ref) or a symmetric wrap, so publishing it
 * hands a discrete-log solver nothing. Opening REQUIRES the unwrapped seed to
 * regenerate the named key: the GCM tag under the organiser's own KEK and that check
 * authenticate the vault to its owner without any signature. A forged vault write is
 * a denial, never a disclosure: recorded boxes are sealed to the real key.
 *
 * THE RECOVERY ESCROW MUST NEVER CARRY THE ADK. It wraps one DEK for every guardian,
 * and a wallet or email guardian's key is a signature. A backup passkey joins the
 * vault as an unlocker instead.
 *
 * X-Wing is a hybrid, and this rests on it: a discrete-log solver reads the X25519
 * half, so a box holds while ML-KEM-768 does.
 *
 * `gen` counts keys, not vault edits: adding or removing an unlocker re-wraps the SAME
 * seed at the same gen. Only losing every unlocker makes a new key (gen + 1), and
 * boxes sealed to the old one stay closed.
 *
 * Import by subpath (`@woco/shared/crypto/attendee-data-key`) and, in the browser,
 * lazily: checking the key loads the lattice code.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { xwing, XWING_SEED_BYTES, type XWingKeypair } from "./xwing.js";
import { orderKeyRef, isOrderKeyRef } from "../event/order-key.js";

/** Current vault format. Anything else is refused, never rewritten: a newer vault
 *  means this build is out of date, and writing over it would drop what it holds. */
export const ATTENDEE_DATA_VAULT_VERSION = 1 as const;

/** HKDF info for a recovery code's KEK. FROZEN: change it and no saved code opens. */
export const RECOVERY_CODE_KEK_INFO = "woco/attendee-data/kek/recovery-code/v1";

/** The AAD every wrap is bound to, before `:{parent}:{gen}:{ref}`. FROZEN. */
export const ATTENDEE_DATA_VAULT_AAD = "woco/attendee-data/vault/v1";

/** Unlockers per vault. Keeps the vault well inside one 4096-byte feed page. */
export const ATTENDEE_DATA_VAULT_MAX_UNLOCKERS = 10;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const IV_RE = new RegExp(`^[0-9a-f]{${IV_BYTES * 2}}$`);
const CT_RE = new RegExp(`^[0-9a-f]{${(XWING_SEED_BYTES + TAG_BYTES) * 2}}$`);
// base64url of a raw credential id (WebAuthn caps those at 1023 bytes).
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,1364}$/;

export type VaultUnlocker =
  | { kind: "passkey"; id: string; iv: string; ct: string; addedAt: number }
  | { kind: "code"; iv: string; ct: string; addedAt: number };

export interface AttendeeDataVault {
  v: typeof ATTENDEE_DATA_VAULT_VERSION;
  parent: string;
  gen: number;
  ref: string;
  unlockers: VaultUnlocker[];
}

/** What to enrol: the KEK plus, for a passkey, its credential id. */
export type UnlockerInput =
  | { kind: "passkey"; id: string; kek: Uint8Array }
  | { kind: "code"; kek: Uint8Array };

/** A vault of a VERSION this build does not read. Say "update the app"; never write. */
export class UnsupportedAttendeeDataVaultError extends Error {
  constructor(v: unknown) {
    super(`unsupported attendee-data vault version: ${String(v)}`);
    this.name = "UnsupportedAttendeeDataVaultError";
  }
}

/** Something that claims to be a v1 vault and is not one: corruption, not age. */
export class MalformedAttendeeDataVaultError extends Error {
  constructor(detail: string) {
    super(`malformed attendee-data vault: ${detail}`);
    this.name = "MalformedAttendeeDataVaultError";
  }
}

/**
 * Why a vault did not open.
 * - `other-account`: the vault names a different parent than the caller expected.
 * - `not-enrolled`: no entry for this passkey (or no recovery code saved).
 * - `wrong-key`: the entry's tag failed: a mistyped code, a different passkey, or a
 *   tampered entry.
 * - `key-mismatch`: it unwrapped, but not to the key the vault names.
 */
export type VaultUnlockFailure = "other-account" | "not-enrolled" | "wrong-key" | "key-mismatch";

export class AttendeeDataVaultUnlockError extends Error {
  constructor(readonly reason: VaultUnlockFailure) {
    super(`attendee-data vault did not open: ${reason}`);
    this.name = "AttendeeDataVaultUnlockError";
  }
}

function assertAddress(parent: string): string {
  if (!ADDRESS_RE.test(parent)) throw new Error("attendee-data vault: parent must be a lowercase 20-byte address");
  return parent;
}

function assertGen(gen: number): number {
  if (!Number.isSafeInteger(gen) || gen < 0) throw new Error("attendee-data vault: gen must be a non-negative integer");
  return gen;
}

function assert32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length !== 32) throw new Error(`attendee-data vault: ${what} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** A fresh attendee-data key seed. The caller zeroes it once it is wrapped or cached. */
export function newAttendeeDataKeySeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(XWING_SEED_BYTES));
}

/** The attendee-data keypair of a seed. The seed IS X-Wing's `sk`: no KDF in between. */
export function attendeeDataKeypair(seed: Uint8Array): XWingKeypair {
  const { secretKey, publicKey } = xwing.keygen(assert32(seed, "key seed"));
  return { secretKey, publicKey };
}

/** The content address the seed's public key is published under: what events name. */
export function attendeeDataKeyRef(seed: Uint8Array): string {
  return orderKeyRef(attendeeDataKeypair(seed).publicKey);
}

/**
 * The AAD every wrap in a vault is bound to. Addresses are lowercase hex and refs are
 * 64 hex characters, so ":" cannot occur inside a part and the string is unambiguous.
 * A wrap moved to another account, key generation or key fails its tag.
 */
export function attendeeDataVaultAad(parent: string, gen: number, ref: string): string {
  assertAddress(parent);
  assertGen(gen);
  if (!isOrderKeyRef(ref)) throw new Error("attendee-data vault: ref must be 64 lowercase hex characters");
  return `${ATTENDEE_DATA_VAULT_AAD}:${parent}:${gen}:${ref}`;
}

/**
 * A recovery code's KEK. The code is 160 uniformly random bits, never chosen by a
 * person, so a slow KDF would add nothing but a dependency. The salt is the account,
 * so one guess can never be tried against every vault at once.
 */
export function recoveryCodeKek(codeBytes: Uint8Array, parent: string): Uint8Array {
  if (codeBytes.length !== RECOVERY_CODE_BYTES) {
    throw new Error(`recovery code must be ${RECOVERY_CODE_BYTES} bytes, got ${codeBytes.length}`);
  }
  return hkdf(sha256, codeBytes, utf8ToBytes(assertAddress(parent)), utf8ToBytes(RECOVERY_CODE_KEK_INFO), 32);
}

interface WrapContext {
  parent: string;
  gen: number;
  ref: string;
}

/** Wrap a key seed under a KEK. A fresh random IV every call: never pass one in. */
export async function wrapAttendeeDataKey(
  kek: Uint8Array,
  seed: Uint8Array,
  ctx: WrapContext,
): Promise<{ iv: string; ct: string }> {
  const key = await crypto.subtle.importKey("raw", buf(assert32(kek, "KEK")), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8ToBytes(attendeeDataVaultAad(ctx.parent, ctx.gen, ctx.ref))) },
    key,
    buf(assert32(seed, "key seed")),
  );
  return { iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) };
}

/** Unwrap a key seed, or throw `wrong-key` when the tag does not verify. */
export async function unwrapAttendeeDataKey(
  kek: Uint8Array,
  wrap: { iv: string; ct: string },
  ctx: WrapContext,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(assert32(kek, "KEK")), "AES-GCM", false, ["decrypt"]);
  try {
    const seed = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buf(hexToBytes(wrap.iv)),
        additionalData: buf(utf8ToBytes(attendeeDataVaultAad(ctx.parent, ctx.gen, ctx.ref))),
      },
      key,
      buf(hexToBytes(wrap.ct)),
    );
    return new Uint8Array(seed);
  } catch {
    throw new AttendeeDataVaultUnlockError("wrong-key");
  }
}

async function wrapEntry(
  input: UnlockerInput,
  seed: Uint8Array,
  ctx: WrapContext,
  addedAt: number,
): Promise<VaultUnlocker> {
  if (!Number.isSafeInteger(addedAt) || addedAt < 0) throw new Error("attendee-data vault: addedAt must be ms since epoch");
  const { iv, ct } = await wrapAttendeeDataKey(input.kek, seed, ctx);
  if (input.kind === "passkey") {
    if (!CREDENTIAL_ID_RE.test(input.id)) throw new Error("attendee-data vault: passkey id must be base64url");
    return { kind: "passkey", id: input.id, iv, ct, addedAt };
  }
  return { kind: "code", iv, ct, addedAt };
}

function sameSlot(a: { kind: string; id?: string }, b: { kind: string; id?: string }): boolean {
  return a.kind === b.kind && (a.kind === "code" || a.id === b.id);
}

/**
 * A new vault for a key seed, wrapped to every unlocker given. At least one: a vault
 * nothing can open has lost its key.
 */
export async function createAttendeeDataVault(args: {
  parent: string;
  gen: number;
  seed: Uint8Array;
  unlockers: UnlockerInput[];
  addedAt?: number;
}): Promise<AttendeeDataVault> {
  const parent = assertAddress(args.parent);
  const gen = assertGen(args.gen);
  const ref = attendeeDataKeyRef(args.seed);
  const ctx = { parent, gen, ref };
  const addedAt = args.addedAt ?? Date.now();
  const unlockers: VaultUnlocker[] = [];
  for (const input of args.unlockers) unlockers.push(await wrapEntry(input, args.seed, ctx, addedAt));
  // The parse inside refuses a duplicate or an empty list.
  return checkedVault({ v: ATTENDEE_DATA_VAULT_VERSION, parent, gen, ref, unlockers });
}

/**
 * The vault with one more unlocker, or with a passkey's or the code's entry
 * REPLACED (a re-issued recovery code drops the old one). Needs the key seed, which
 * the caller has because it just opened the vault; refuses a seed that is not the
 * vault's key.
 */
export async function withVaultUnlocker(
  vault: AttendeeDataVault,
  seed: Uint8Array,
  input: UnlockerInput,
  addedAt: number = Date.now(),
): Promise<AttendeeDataVault> {
  if (attendeeDataKeyRef(seed) !== vault.ref) throw new AttendeeDataVaultUnlockError("key-mismatch");
  const kept = vault.unlockers.filter((u) => !sameSlot(u, input));
  if (kept.length >= ATTENDEE_DATA_VAULT_MAX_UNLOCKERS) {
    throw new Error(`attendee-data vault: at most ${ATTENDEE_DATA_VAULT_MAX_UNLOCKERS} unlockers - remove one first`);
  }
  const entry = await wrapEntry(input, seed, vault, addedAt);
  return checkedVault({ ...vault, unlockers: [...kept, entry] });
}

/** The vault without a passkey's entry (or the code's). Never the last one. */
export function withoutVaultUnlocker(
  vault: AttendeeDataVault,
  slot: { kind: "passkey"; id: string } | { kind: "code" },
): AttendeeDataVault {
  const kept = vault.unlockers.filter((u) => !sameSlot(u, slot));
  if (kept.length === vault.unlockers.length) throw new AttendeeDataVaultUnlockError("not-enrolled");
  if (kept.length === 0) throw new Error("attendee-data vault: cannot remove the last unlocker");
  return checkedVault({ ...vault, unlockers: kept });
}

/**
 * The key seed inside a vault. `expectedParent` is the account the caller is signed
 * in as; a vault naming anyone else is refused before anything is tried. The result
 * is checked against the vault's `ref`, so a vault that decrypts to some other key
 * never becomes the one attendee data is opened or sealed with.
 */
export async function openAttendeeDataVault(
  vault: AttendeeDataVault,
  expectedParent: string,
  unlock: { kind: "passkey"; id: string; kek: Uint8Array } | { kind: "code"; kek: Uint8Array },
): Promise<Uint8Array> {
  if (vault.parent !== expectedParent.toLowerCase()) throw new AttendeeDataVaultUnlockError("other-account");
  const entry = vault.unlockers.find((u) => sameSlot(u, unlock));
  if (!entry) throw new AttendeeDataVaultUnlockError("not-enrolled");
  const seed = await unwrapAttendeeDataKey(unlock.kek, entry, vault);
  if (attendeeDataKeyRef(seed) !== vault.ref) {
    seed.fill(0);
    throw new AttendeeDataVaultUnlockError("key-mismatch");
  }
  return seed;
}

function checkedVault(vault: AttendeeDataVault): AttendeeDataVault {
  return parseAttendeeDataVault(JSON.parse(JSON.stringify(vault)));
}

const VAULT_FIELDS = ["gen", "parent", "ref", "unlockers", "v"];

/**
 * A v1 vault from untrusted JSON, or a throw. EXACT fields, lowercase hex, at most one
 * recovery code, no repeated passkey, at least one unlocker. A vault of any other `v`
 * is `UnsupportedAttendeeDataVaultError` - never read as v1, never overwritten.
 */
export function parseAttendeeDataVault(x: unknown): AttendeeDataVault {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new MalformedAttendeeDataVaultError("not an object");
  const o = x as Record<string, unknown>;
  if (o.v !== ATTENDEE_DATA_VAULT_VERSION) throw new UnsupportedAttendeeDataVaultError(o.v);
  if (Object.keys(o).sort().join(",") !== VAULT_FIELDS.join(",")) {
    throw new MalformedAttendeeDataVaultError("unexpected fields");
  }
  if (typeof o.parent !== "string" || !ADDRESS_RE.test(o.parent)) throw new MalformedAttendeeDataVaultError("parent");
  if (typeof o.gen !== "number" || !Number.isSafeInteger(o.gen) || o.gen < 0) throw new MalformedAttendeeDataVaultError("gen");
  if (!isOrderKeyRef(o.ref)) throw new MalformedAttendeeDataVaultError("ref");
  if (!Array.isArray(o.unlockers) || o.unlockers.length === 0 || o.unlockers.length > ATTENDEE_DATA_VAULT_MAX_UNLOCKERS) {
    throw new MalformedAttendeeDataVaultError("unlockers");
  }
  const unlockers: VaultUnlocker[] = [];
  for (const raw of o.unlockers) {
    const u = parseUnlocker(raw);
    if (unlockers.some((seen) => sameSlot(seen, u))) throw new MalformedAttendeeDataVaultError("duplicate unlocker");
    unlockers.push(u);
  }
  return { v: ATTENDEE_DATA_VAULT_VERSION, parent: o.parent, gen: o.gen, ref: o.ref, unlockers };
}

function parseUnlocker(raw: unknown): VaultUnlocker {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MalformedAttendeeDataVaultError("unlocker");
  const u = raw as Record<string, unknown>;
  const keys = Object.keys(u).sort().join(",");
  if (typeof u.iv !== "string" || !IV_RE.test(u.iv)) throw new MalformedAttendeeDataVaultError("unlocker iv");
  if (typeof u.ct !== "string" || !CT_RE.test(u.ct)) throw new MalformedAttendeeDataVaultError("unlocker ct");
  if (typeof u.addedAt !== "number" || !Number.isSafeInteger(u.addedAt) || u.addedAt < 0) {
    throw new MalformedAttendeeDataVaultError("unlocker addedAt");
  }
  if (u.kind === "passkey") {
    if (keys !== "addedAt,ct,id,iv,kind") throw new MalformedAttendeeDataVaultError("unlocker fields");
    if (typeof u.id !== "string" || !CREDENTIAL_ID_RE.test(u.id)) throw new MalformedAttendeeDataVaultError("unlocker id");
    return { kind: "passkey", id: u.id, iv: u.iv, ct: u.ct, addedAt: u.addedAt };
  }
  if (u.kind === "code") {
    if (keys !== "addedAt,ct,iv,kind") throw new MalformedAttendeeDataVaultError("unlocker fields");
    return { kind: "code", iv: u.iv, ct: u.ct, addedAt: u.addedAt };
  }
  throw new MalformedAttendeeDataVaultError("unlocker kind");
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------
//
//   WOCO1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-CC
//
// 160 random bits as 32 Crockford base32 symbols, then 2 check symbols (the first 10
// bits of SHA-256 of the 20 bytes). 160 rather than 128 bits because the wraps sit on
// public storage indefinitely: a quantum search over 160 bits is ~2^80 sequential
// steps. Reading is forgiving - any case, dashes and spaces optional, O read as 0 and
// I/L as 1 - and strict about everything else.

/** Bytes of randomness in a recovery code. */
export const RECOVERY_CODE_BYTES = 20;

/** The version prefix every recovery code starts with. FROZEN. */
export const RECOVERY_CODE_PREFIX = "WOCO1";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DATA_SYMBOLS = 32;
const CHECK_SYMBOLS = 2;

/** Why a typed recovery code was refused - each maps to its own hint. */
export type RecoveryCodeProblem = "prefix" | "length" | "character" | "check";

export class RecoveryCodeError extends Error {
  constructor(readonly problem: RecoveryCodeProblem) {
    super(`not a valid recovery code: ${problem}`);
    this.name = "RecoveryCodeError";
  }
}

function checkValue(bytes: Uint8Array): number {
  const h = sha256(bytes);
  return (h[0] << 2) | (h[1] >> 6);
}

/** The printed form of a code's 20 bytes. */
export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_CODE_BYTES) {
    throw new Error(`recovery code must be ${RECOVERY_CODE_BYTES} bytes, got ${bytes.length}`);
  }
  let symbols = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      symbols += CROCKFORD[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  const check = checkValue(bytes);
  symbols += CROCKFORD[check >> 5] + CROCKFORD[check & 31];
  const groups = [RECOVERY_CODE_PREFIX];
  for (let i = 0; i < DATA_SYMBOLS; i += 4) groups.push(symbols.slice(i, i + 4));
  groups.push(symbols.slice(DATA_SYMBOLS));
  return groups.join("-");
}

/** A fresh recovery code. Show `code` once; derive the KEK from `bytes`, then zero them. */
export function newRecoveryCode(): { code: string; bytes: Uint8Array } {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
  return { code: formatRecoveryCode(bytes), bytes };
}

/** A typed recovery code's 20 bytes, or a `RecoveryCodeError` naming what is wrong. */
export function parseRecoveryCode(input: string): Uint8Array {
  const normalise = (s: string) =>
    s.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  const text = normalise(input);
  const prefix = normalise(RECOVERY_CODE_PREFIX);
  if (!text.startsWith(prefix)) throw new RecoveryCodeError("prefix");
  const body = text.slice(prefix.length);
  if (body.length !== DATA_SYMBOLS + CHECK_SYMBOLS) throw new RecoveryCodeError("length");
  const values: number[] = [];
  for (const ch of body) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new RecoveryCodeError("character");
    values.push(v);
  }
  const bytes = new Uint8Array(RECOVERY_CODE_BYTES);
  let acc = 0;
  let bits = 0;
  let out = 0;
  for (const v of values.slice(0, DATA_SYMBOLS)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  const check = (values[DATA_SYMBOLS] << 5) | values[DATA_SYMBOLS + 1];
  if (check !== checkValue(bytes)) {
    bytes.fill(0);
    throw new RecoveryCodeError("check");
  }
  return bytes;
}
