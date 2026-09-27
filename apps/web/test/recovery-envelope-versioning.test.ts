/**
 * Recovery-envelope AAD role/version binding (#166 item 3).
 *
 * Every test pins a property the review named load-bearing:
 *  - the two roles ("guardian" escrow, "portability" envelope) can never open
 *    each other's ciphertexts, even sealed to the SAME recipient key — the
 *    barrier the old address-only AAD did not provide;
 *  - v1 and v2 envelopes (X25519-only wrap) are RETIRED by #642 and refused with
 *    their own typed error, before any unwrap — "set recovery up again", never
 *    "wrong wallet" and never mistaken for a newer client's work;
 *  - an unknown (newer) `envelope.v` is rejected with the TYPED error, so callers
 *    can say "update the app" instead of "wrong wallet" / rewriting a newer
 *    client's envelope with an older format (the back-fill downgrade hazard);
 *  - the DEK is wrapped with X-Wing (a 1120-byte `enc` per entry), and a current
 *    envelope still fits one 4096-byte chunk;
 *  - the portability read classifies "newer than me" as `unreadable` (leave it
 *    alone), never `unusable` (the self-heal rewrite path).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { RECOVERY_ENVELOPE_VERSION, PORTABILITY_ENVELOPE_VERSION } from "@woco/shared";
import type { RecoveryEnvelope, PortabilityEnvelope } from "@woco/shared";
import {
  sealRecoveryBundle,
  openRecoveryBundle,
  deriveEncryptionKeypairFromSeed,
  type RecoveryBundle,
} from "../src/lib/auth/recovery-escrow.js";
import {
  UnknownRecoveryEnvelopeVersionError,
  RetiredRecoveryEnvelopeVersionError,
  recoveryAadBytes,
} from "../src/lib/auth/recovery-aad.js";
import {
  derivePortabilityKeys,
  readPortabilityEnvelope,
  decideBackfill,
} from "../src/lib/auth/recovery-portability.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";

const KERNEL = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const SEED_A = new Uint8Array(32).fill(7);
const BUNDLE: RecoveryBundle = { version: 1, secrets: { identitySeed: "0x" + "ab".repeat(32) } };

test("v2 seal/open round-trips under the same role and declares the current version", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  assert.equal(envelope.v, RECOVERY_ENVELOPE_VERSION);
  const opened = await openRecoveryBundle({
    envelope,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianKeypair: kp,
  });
  assert.equal(opened.secrets.identitySeed, BUNDLE.secrets.identitySeed);
});

test("role separation is cryptographic: the OTHER role cannot open it even with the right recipient key", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "portability",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  await assert.rejects(
    openRecoveryBundle({ envelope, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
    /no wrapped DEK opens/,
  );
});

/**
 * Seal an envelope EXACTLY the way the pre-#166 code did: v1, AAD
 * `woco/recovery/v1:{addr}`, no role component, DEK wrapped with DHKEM(X25519).
 * A REAL retired envelope, so the refusal under test is the one a user who
 * protected an account before #642 would actually meet.
 */
async function sealLegacyV1(): Promise<RecoveryEnvelope> {
  const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const toAb = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const aad = new TextEncoder().encode(`woco/recovery/v1:${KERNEL.toLowerCase()}`);
  const dek = randomBytes(32);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(dek, nonce, aad).encrypt(new TextEncoder().encode(JSON.stringify(BUNDLE)));
  const { publicKey: recipientPublicKey } = await hpke.kem.generateKeyPair();
  const sender = await hpke.createSenderContext({ recipientPublicKey });
  const wrappedCt = new Uint8Array(await sender.seal(toAb(dek), aad));
  const enc = new Uint8Array(sender.enc);
  const combined = new Uint8Array(enc.length + wrappedCt.length);
  combined.set(enc, 0);
  combined.set(wrappedCt, enc.length);
  return {
    v: 1,
    kernelAddress: KERNEL.toLowerCase(),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
    wrappedDeks: [bytesToHex(combined)],
  };
}

test("a REAL retired v1 envelope is refused as RETIRED, under either role, before any unwrap", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealLegacyV1();
  for (const role of ["guardian", "portability"] as const) {
    await assert.rejects(
      openRecoveryBundle({ envelope, kernelAddress: KERNEL, role, guardianKeypair: kp }),
      (e: unknown) => e instanceof RetiredRecoveryEnvelopeVersionError && e.envelopeVersion === 1,
    );
  }
});

test("only the CURRENT version reaches the unwrap: retired labels and future labels are both refused, typed", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  assert.equal(RECOVERY_ENVELOPE_VERSION, 3);
  for (const v of [1, 2]) {
    await assert.rejects(
      openRecoveryBundle({ envelope: { ...envelope, v }, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
      RetiredRecoveryEnvelopeVersionError,
    );
    assert.throws(() => recoveryAadBytes("guardian", v, KERNEL), RetiredRecoveryEnvelopeVersionError);
  }
  for (const v of [RECOVERY_ENVELOPE_VERSION + 1, 0, 2.5, Number.NaN]) {
    await assert.rejects(
      openRecoveryBundle({ envelope: { ...envelope, v }, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
      UnknownRecoveryEnvelopeVersionError,
    );
  }
});

test("the DEK wrap is X-Wing, and a current envelope still fits one 4096-byte chunk", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  assert.equal(kp.publicKeyHex.length, 1216 * 2, "the guardian key is an X-Wing key");
  const envelope = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  assert.equal(envelope.wrappedDeks.length, 1);
  // enc (1120) ‖ HPKE ciphertext of the 32-byte DEK with its 16-byte tag.
  assert.equal(hexToBytes(envelope.wrappedDeks[0]).length, 1120 + 32 + 16);
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  assert.ok(json.length < 4096, `envelope is ${json.length} bytes`);
});

// ── Portability read classification ─────────────────────────────────────────

const PRF_KEY = "0x" + "11".repeat(32);

function feedOf(result: ContentFeedResult<PortabilityEnvelope>) {
  return (async () => result) as unknown as typeof import("../src/lib/swarm/content-feed.js").readContentFeedResult;
}

/** A genuine portability envelope for PRF_KEY, as writePortabilityEnvelope seals it. */
async function realPortabilityEnvelope(): Promise<PortabilityEnvelope> {
  const keys = await derivePortabilityKeys(PRF_KEY);
  const envelope = await sealRecoveryBundle({
    bundle: {
      version: PORTABILITY_ENVELOPE_VERSION,
      secrets: { preservedKernelAddress: KERNEL.toLowerCase(), identitySeed: "0x" + "cd".repeat(32) },
    },
    kernelAddress: keys.socOwnerAddress,
    role: "portability",
    guardianPublicKeysHex: [keys.hpke.publicKeyHex],
  });
  return { v: PORTABILITY_ENVELOPE_VERSION, envelope };
}

test("portability read: a valid current envelope is found and opens", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({ status: "found", value: payload, version: 0 }),
  });
  assert.equal(read.status, "found");
  assert.equal(read.status === "found" && read.value.preservedKernelAddress, KERNEL.toLowerCase());
});

test("portability read: a NEWER wrapper version is unreadable — never the rewritable 'unusable'", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({ status: "found", value: { ...payload, v: (PORTABILITY_ENVELOPE_VERSION + 1) as never }, version: 0 }),
  });
  assert.equal(read.status, "unreadable");
});

test("portability read: a NEWER inner envelope version is unreadable — never the rewritable 'unusable'", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({
      status: "found",
      value: { ...payload, envelope: { ...payload.envelope, v: RECOVERY_ENVELOPE_VERSION + 1 } },
      version: 0,
    }),
  });
  assert.equal(read.status, "unreadable");
});

test("portability read: a RETIRED inner envelope version is unusable — the self-heal may rewrite it", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({
      status: "found",
      value: { ...payload, envelope: { ...payload.envelope, v: 2 } },
      version: 0,
    }),
  });
  assert.equal(read.status, "unusable");
});

test("portability read: an OLDER wrapper version stays unusable (the documented self-heal rewrite)", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({ status: "found", value: { ...payload, v: 1 as never }, version: 0 }),
  });
  assert.equal(read.status, "unusable");
});

test("portability read: a tampered inner envelope is unusable — an integrity fault, not a version case", async () => {
  const payload = await realPortabilityEnvelope();
  const flipped = payload.envelope.ciphertext.replace(/^../, (h) => (h === "00" ? "01" : "00"));
  const read = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({
      status: "found",
      value: { ...payload, envelope: { ...payload.envelope, ciphertext: flipped } },
      version: 0,
    }),
  });
  assert.equal(read.status, "unusable");
});

test("portability read: absent and unavailable map to absent and unreadable", async () => {
  const absent = await readPortabilityEnvelope({ prfSecret: PRF_KEY, readFeed: feedOf({ status: "absent" }) });
  assert.equal(absent.status, "absent");
  const down = await readPortabilityEnvelope({
    prfSecret: PRF_KEY,
    readFeed: feedOf({ status: "unavailable", reason: "gateway 502" }),
  });
  assert.equal(down.status, "unreadable");
});

// ---------------------------------------------------------------------------
// Back-fill decision (#642 PR B): a found envelope that disagrees is REFUSED
// ---------------------------------------------------------------------------

const MINE = { preservedKernelAddress: KERNEL, identitySeed: "0x" + "ab".repeat(32) };
const found = (preservedKernelAddress: string, identitySeed: string) =>
  ({ status: "found", value: { preservedKernelAddress: preservedKernelAddress.toLowerCase(), identitySeed } }) as const;

test("back-fill: an envelope carrying exactly this device's secrets is skipped", () => {
  assert.equal(decideBackfill(found(KERNEL, MINE.identitySeed), MINE).action, "skipped");
});

test("back-fill: a DIFFERENT seed in a found envelope is refused, never overwritten", () => {
  // The #245 poisoned-device shape: this device derived a seed on the wrong
  // Kernel. "Contents differed, write" would replace the account's real seed
  // for every future device.
  const d = decideBackfill(found(KERNEL, "0x" + "cd".repeat(32)), MINE);
  assert.equal(d.action, "refused");
  assert.match(d.reason, /identity seed/);
});

test("back-fill: a DIFFERENT Kernel in a found envelope is refused too", () => {
  const d = decideBackfill(found("0x" + "bb".repeat(20), MINE.identitySeed), MINE);
  assert.equal(d.action, "refused");
  assert.match(d.reason, /Kernel/);
});

test("back-fill: absent and stale envelopes are written; an unreadable one defers", () => {
  assert.equal(decideBackfill({ status: "absent" }, MINE).action, "write");
  assert.equal(decideBackfill({ status: "unusable", reason: "old" }, MINE).action, "write");
  assert.equal(decideBackfill({ status: "unreadable", reason: "fetch" }, MINE).action, "deferred");
});
