/**
 * The attendee-data key and its vault (#746).
 *
 * PROVENANCE, 2026-09-28 - a vector with none is a number someone can "fix":
 *  - Both KEKs and the printed recovery code were produced by the shipped functions
 *    and cross-checked against an independent Python computation: RFC 5869 HKDF by
 *    hand (hmac/hashlib) and Crockford base32 + the SHA-256 check written from the
 *    spec in this file's module, not from its code.
 *  - `attendee-data-vault-v1.json` was produced ONCE by `createAttendeeDataVault` with
 *    the fixed seed, KEKs and credential id below (its IVs are the random ones of that
 *    run). The test opens it with our code AND decrypts it with `node:crypto` from the
 *    literal AAD string, so the wrap format is pinned by something other than itself.
 *
 * A failure here is never a vector to update: a changed KEK, AAD or format means
 * every vault already published stops opening.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";
import { xwing } from "../../src/crypto/xwing.js";
import { orderKeyRef } from "../../src/event/order-key.js";
import { passkeyAttendeeDataKek, PASSKEY_ATTENDEE_DATA_KEK_INFO } from "../../src/crypto/passkey-prf.js";
import {
  ATTENDEE_DATA_VAULT_AAD,
  ATTENDEE_DATA_VAULT_MAX_UNLOCKERS,
  ATTENDEE_DATA_VAULT_VERSION,
  AttendeeDataVaultUnlockError,
  MalformedAttendeeDataVaultError,
  RECOVERY_CODE_KEK_INFO,
  RECOVERY_CODE_PREFIX,
  RecoveryCodeError,
  UnsupportedAttendeeDataVaultError,
  attendeeDataKeyRef,
  attendeeDataKeypair,
  attendeeDataVaultAad,
  createAttendeeDataVault,
  formatRecoveryCode,
  newAttendeeDataKeySeed,
  newRecoveryCode,
  openAttendeeDataVault,
  parseAttendeeDataVault,
  parseRecoveryCode,
  recoveryCodeKek,
  withVaultUnlocker,
  withoutVaultUnlocker,
  wrapAttendeeDataKey,
  type AttendeeDataVault,
  type VaultUnlockFailure,
} from "../../src/crypto/attendee-data-key.js";

const PRF = "0x" + "cd".repeat(32);
const CODE = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
const PARENT = "0x" + "ab".repeat(20);
const SEED = new Uint8Array(32).fill(0x5a);
const CREDENTIAL_ID = "zc3NzQ";

const PINNED = {
  passkeyKek: "b0960bf70e2c589e462a8ca7ef9f6dcded4faf07c4ec3ae4cc6cef5fa89138f6",
  codeKek: "89518db96c5486622f954c294cf0145c37384e1a567a940ebee2282baa1448e1",
  code: "WOCO1-0410-6105-0R3G-G28A-1C60-T3GF-208H-44RM-W4",
  ref: "0bdab543089905609f7c75fbc5659325d5b82291ed733a576ed4d04dc417d86d",
} as const;

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./attendee-data-vault-v1.json", import.meta.url)), "utf8"),
) as unknown;

const passkeyUnlock = () => ({ kind: "passkey" as const, id: CREDENTIAL_ID, kek: passkeyAttendeeDataKek(PRF) });
const codeUnlock = () => ({ kind: "code" as const, kek: recoveryCodeKek(CODE, PARENT) });

async function refusal(p: Promise<unknown>): Promise<VaultUnlockFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AttendeeDataVaultUnlockError) return e.reason;
    throw e;
  }
  throw new Error("expected the vault to refuse");
}

// ---------------------------------------------------------------------------
// Frozen bytes

test("FROZEN: every attendee-data label, byte for byte", () => {
  assert.equal(PASSKEY_ATTENDEE_DATA_KEK_INFO, "woco/attendee-data/kek/passkey-prf/v1");
  assert.equal(RECOVERY_CODE_KEK_INFO, "woco/attendee-data/kek/recovery-code/v1");
  assert.equal(ATTENDEE_DATA_VAULT_AAD, "woco/attendee-data/vault/v1");
  assert.equal(RECOVERY_CODE_PREFIX, "WOCO1");
  assert.equal(ATTENDEE_DATA_VAULT_VERSION, 1);
  assert.equal(
    attendeeDataVaultAad(PARENT, 3, PINNED.ref),
    `woco/attendee-data/vault/v1:0xabababababababababababababababababababab:3:${PINNED.ref}`,
  );
});

test("KEK pins (cross-checked against a by-hand Python HKDF)", () => {
  assert.equal(bytesToHex(passkeyAttendeeDataKek(PRF)), PINNED.passkeyKek);
  assert.equal(bytesToHex(recoveryCodeKek(CODE, PARENT)), PINNED.codeKek);
});

test("the key seed IS X-Wing's sk, and its ref is what events publish", () => {
  assert.deepEqual(attendeeDataKeypair(SEED).publicKey, xwing.keygen(SEED).publicKey);
  assert.equal(attendeeDataKeyRef(SEED), orderKeyRef(xwing.keygen(SEED).publicKey));
  assert.equal(attendeeDataKeyRef(SEED), PINNED.ref);
  assert.throws(() => attendeeDataKeypair(new Uint8Array(31)), /32 bytes/);
  assert.notDeepEqual(newAttendeeDataKeySeed(), newAttendeeDataKeySeed());
});

// ---------------------------------------------------------------------------
// The pinned vault

test("the pinned v1 vault opens with its passkey and with its recovery code", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  assert.equal(vault.ref, PINNED.ref);
  assert.deepEqual(await openAttendeeDataVault(vault, PARENT, passkeyUnlock()), SEED);
  assert.deepEqual(await openAttendeeDataVault(vault, PARENT, codeUnlock()), SEED);
});

test("the pinned vault decrypts with node:crypto from the literal AAD (format pinned independently)", () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  const aad = Buffer.from(`woco/attendee-data/vault/v1:${PARENT}:0:${PINNED.ref}`, "utf8");
  const keks = [Buffer.from(PINNED.passkeyKek, "hex"), Buffer.from(PINNED.codeKek, "hex")];
  vault.unlockers.forEach((u, i) => {
    const ct = Buffer.from(u.ct, "hex");
    const d = createDecipheriv("aes-256-gcm", keks[i], Buffer.from(u.iv, "hex"));
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(32));
    assert.deepEqual(new Uint8Array(Buffer.concat([d.update(ct.subarray(0, 32)), d.final()])), SEED);
  });
});

test("nothing in a published vault is the key or a KEK", () => {
  const text = JSON.stringify(FIXTURE);
  for (const secret of [bytesToHex(SEED), PINNED.passkeyKek, PINNED.codeKek, bytesToHex(CODE)]) {
    assert.ok(!text.includes(secret));
  }
});

// ---------------------------------------------------------------------------
// Refusals

test("a vault naming another account is refused before anything is tried", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  assert.equal(await refusal(openAttendeeDataVault(vault, "0x" + "cd".repeat(20), passkeyUnlock())), "other-account");
  // The caller's address is compared case-insensitively.
  assert.deepEqual(await openAttendeeDataVault(vault, PARENT.toUpperCase().replace("0X", "0x"), passkeyUnlock()), SEED);
});

test("an unknown passkey or a missing code is not-enrolled; a wrong key is wrong-key", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  const other = { kind: "passkey" as const, id: "AAAA", kek: passkeyAttendeeDataKek(PRF) };
  assert.equal(await refusal(openAttendeeDataVault(vault, PARENT, other)), "not-enrolled");
  const noCode = withoutVaultUnlocker(vault, { kind: "code" });
  assert.equal(await refusal(openAttendeeDataVault(noCode, PARENT, codeUnlock())), "not-enrolled");
  const wrongCode = { kind: "code" as const, kek: recoveryCodeKek(new Uint8Array(20).fill(9), PARENT) };
  assert.equal(await refusal(openAttendeeDataVault(vault, PARENT, wrongCode)), "wrong-key");
  const wrongPasskey = { kind: "passkey" as const, id: CREDENTIAL_ID, kek: passkeyAttendeeDataKek("0x" + "ce".repeat(32)) };
  assert.equal(await refusal(openAttendeeDataVault(vault, PARENT, wrongPasskey)), "wrong-key");
});

test("every wrap is bound to its account, key generation and key (AAD)", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  const otherParent = "0x" + "cd".repeat(20);
  // The passkey KEK is not salted by the account, so only the AAD stops this one.
  const moved = { ...vault, parent: otherParent };
  assert.equal(await refusal(openAttendeeDataVault(moved, otherParent, passkeyUnlock())), "wrong-key");
  assert.equal(await refusal(openAttendeeDataVault({ ...vault, gen: 1 }, PARENT, passkeyUnlock())), "wrong-key");
  const otherRef = attendeeDataKeyRef(new Uint8Array(32).fill(1));
  assert.equal(await refusal(openAttendeeDataVault({ ...vault, ref: otherRef }, PARENT, passkeyUnlock())), "wrong-key");
});

test("a vault that unwraps to a key other than the one it names is refused", async () => {
  const otherSeed = new Uint8Array(32).fill(1);
  const ref = attendeeDataKeyRef(otherSeed);
  const kek = recoveryCodeKek(CODE, PARENT);
  // A self-consistent wrap (right AAD) of the WRONG seed: only the keygen check catches it.
  const wrap = await wrapAttendeeDataKey(kek, SEED, { parent: PARENT, gen: 0, ref });
  const vault = parseAttendeeDataVault({
    v: 1,
    parent: PARENT,
    gen: 0,
    ref,
    unlockers: [{ kind: "code", ...wrap, addedAt: 0 }],
  });
  assert.equal(await refusal(openAttendeeDataVault(vault, PARENT, { kind: "code", kek })), "key-mismatch");
});

test("every wrap uses a fresh IV", async () => {
  const kek = recoveryCodeKek(CODE, PARENT);
  const ctx = { parent: PARENT, gen: 0, ref: PINNED.ref };
  const a = await wrapAttendeeDataKey(kek, SEED, ctx);
  const b = await wrapAttendeeDataKey(kek, SEED, ctx);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

// ---------------------------------------------------------------------------
// Parsing

test("parse refuses any other version as UNSUPPORTED, never as malformed", () => {
  for (const v of [0, 2, "1", undefined]) {
    assert.throws(() => parseAttendeeDataVault({ ...(FIXTURE as object), v }), UnsupportedAttendeeDataVaultError);
  }
});

test("parse is exact: fields, hex, unlocker shape, counts", () => {
  const base = FIXTURE as AttendeeDataVault;
  const [pk, code] = base.unlockers;
  const bad: unknown[] = [
    null,
    [],
    { ...base, extra: 1 },
    { ...base, parent: PARENT.toUpperCase() },
    { ...base, gen: -1 },
    { ...base, gen: 1.5 },
    { ...base, ref: base.ref.toUpperCase() },
    { ...base, unlockers: [] },
    { ...base, unlockers: [pk, code, code] },
    { ...base, unlockers: [pk, pk] },
    { ...base, unlockers: [{ ...pk, iv: pk.iv.slice(2) }] },
    { ...base, unlockers: [{ ...pk, ct: pk.ct + "00" }] },
    { ...base, unlockers: [{ ...pk, ct: pk.ct.toUpperCase() }] },
    { ...base, unlockers: [{ ...pk, id: "not base64url!" }] },
    { ...base, unlockers: [{ ...pk, kind: "wallet" }] },
    { ...base, unlockers: [{ ...code, id: "x" }] },
    { ...base, unlockers: [{ ...pk, extra: true }] },
    { ...base, unlockers: [{ ...pk, addedAt: -1 }] },
    { ...base, unlockers: Array.from({ length: ATTENDEE_DATA_VAULT_MAX_UNLOCKERS + 1 }, (_, i) => ({ ...pk, id: `id${i}` })) },
  ];
  for (const x of bad) assert.throws(() => parseAttendeeDataVault(x), MalformedAttendeeDataVaultError, JSON.stringify(x)?.slice(0, 80));
});

// ---------------------------------------------------------------------------
// Building and editing

test("create wraps every unlocker; a vault with none, or a duplicate, is refused", async () => {
  const vault = await createAttendeeDataVault({ parent: PARENT, gen: 0, seed: SEED, unlockers: [passkeyUnlock(), codeUnlock()] });
  assert.equal(vault.ref, PINNED.ref);
  assert.deepEqual(await openAttendeeDataVault(vault, PARENT, codeUnlock()), SEED);
  await assert.rejects(createAttendeeDataVault({ parent: PARENT, gen: 0, seed: SEED, unlockers: [] }), MalformedAttendeeDataVaultError);
  await assert.rejects(
    createAttendeeDataVault({ parent: PARENT, gen: 0, seed: SEED, unlockers: [codeUnlock(), codeUnlock()] }),
    /duplicate/,
  );
});

test("adding a passkey keeps the others; re-issuing the code retires the old one", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  const second = { kind: "passkey" as const, id: "c2Vjb25k", kek: passkeyAttendeeDataKek("0x" + "ee".repeat(32)) };
  const withSecond = await withVaultUnlocker(vault, SEED, second);
  assert.equal(withSecond.unlockers.length, 3);
  assert.equal(withSecond.gen, vault.gen);
  assert.deepEqual(await openAttendeeDataVault(withSecond, PARENT, second), SEED);
  assert.deepEqual(await openAttendeeDataVault(withSecond, PARENT, passkeyUnlock()), SEED);

  const fresh = newRecoveryCode();
  const newCode = { kind: "code" as const, kek: recoveryCodeKek(fresh.bytes, PARENT) };
  const reissued = await withVaultUnlocker(withSecond, SEED, newCode);
  assert.equal(reissued.unlockers.filter((u) => u.kind === "code").length, 1);
  assert.deepEqual(await openAttendeeDataVault(reissued, PARENT, newCode), SEED);
  assert.equal(await refusal(openAttendeeDataVault(reissued, PARENT, codeUnlock())), "wrong-key");
});

test("adding needs the vault's own key, and stops at the cap", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  assert.equal(await refusal(withVaultUnlocker(vault, new Uint8Array(32).fill(1), codeUnlock())), "key-mismatch");
  let full = vault;
  for (let i = 0; full.unlockers.length < ATTENDEE_DATA_VAULT_MAX_UNLOCKERS; i++) {
    full = await withVaultUnlocker(full, SEED, { kind: "passkey", id: `k${i}`, kek: passkeyAttendeeDataKek(PRF) });
  }
  await assert.rejects(
    withVaultUnlocker(full, SEED, { kind: "passkey", id: "one-more", kek: passkeyAttendeeDataKek(PRF) }),
    /at most/,
  );
});

test("removing an unlocker: gone afterwards, never the last, never one that is absent", async () => {
  const vault = parseAttendeeDataVault(FIXTURE);
  const noPasskey = withoutVaultUnlocker(vault, { kind: "passkey", id: CREDENTIAL_ID });
  assert.equal(await refusal(openAttendeeDataVault(noPasskey, PARENT, passkeyUnlock())), "not-enrolled");
  assert.throws(() => withoutVaultUnlocker(noPasskey, { kind: "code" }), /last unlocker/);
  assert.throws(() => withoutVaultUnlocker(vault, { kind: "passkey", id: "AAAA" }), AttendeeDataVaultUnlockError);
});

// ---------------------------------------------------------------------------
// Recovery codes

test("recovery code pin (cross-checked against Python) and round trip", () => {
  assert.equal(formatRecoveryCode(CODE), PINNED.code);
  assert.deepEqual(parseRecoveryCode(PINNED.code), CODE);
  for (let i = 0; i < 50; i++) {
    const { code, bytes } = newRecoveryCode();
    assert.match(code, /^WOCO1(-[0-9A-HJKMNP-TV-Z]{4}){8}-[0-9A-HJKMNP-TV-Z]{2}$/);
    assert.deepEqual(parseRecoveryCode(code), bytes);
  }
});

test("reading a code is forgiving about case, separators and look-alikes", () => {
  const variants = [
    PINNED.code.toLowerCase(),
    PINNED.code.replace(/-/g, ""),
    PINNED.code.replace(/-/g, " "),
    `  ${PINNED.code}  `,
    PINNED.code.replace(/0/g, "O"),
    PINNED.code.replace(/1/g, "l"),
    PINNED.code.replace(/1/g, "I"),
  ];
  for (const v of variants) assert.deepEqual(parseRecoveryCode(v), CODE, v);
});

test("reading a code is strict about everything else, and says what is wrong", () => {
  const problem = (input: string) => {
    try {
      parseRecoveryCode(input);
    } catch (e) {
      if (e instanceof RecoveryCodeError) return e.problem;
      throw e;
    }
    return "accepted";
  };
  assert.equal(problem(PINNED.code.replace("WOCO1", "WOCO2")), "prefix");
  assert.equal(problem(PINNED.code.slice("WOCO1-".length)), "prefix");
  assert.equal(problem(PINNED.code.slice(0, -1)), "length");
  assert.equal(problem(PINNED.code + "0"), "length");
  assert.equal(problem(PINNED.code.replace("W4", "U4")), "character");
  // One symbol changed anywhere in the data is caught by the check (1 in 1024 slips).
  assert.equal(problem(PINNED.code.replace("0410", "0411")), "check");
  assert.equal(problem(PINNED.code.replace(/W4$/, "W5")), "check");
});

test("a code's KEK is bound to the account and needs exactly 20 bytes", () => {
  assert.notEqual(bytesToHex(recoveryCodeKek(CODE, PARENT)), bytesToHex(recoveryCodeKek(CODE, "0x" + "cd".repeat(20))));
  assert.throws(() => recoveryCodeKek(CODE.slice(1), PARENT), /20 bytes/);
  assert.throws(() => recoveryCodeKek(CODE, PARENT.toUpperCase()), /address/);
});
