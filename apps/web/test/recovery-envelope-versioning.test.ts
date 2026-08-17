/**
 * Recovery-envelope AAD role/version binding (#166 item 3).
 *
 * Every test pins a property the review named load-bearing:
 *  - the two roles ("guardian" escrow, "portability" envelope) can never open
 *    each other's ciphertexts, even sealed to the SAME recipient key — the
 *    barrier the old address-only AAD did not provide;
 *  - envelopes sealed under the LEGACY v1 AAD (`woco/recovery/v1:{addr}`, no
 *    role) still open — pre-v2 escrows must keep recovering;
 *  - an unknown `envelope.v` is rejected with the TYPED error, so callers can
 *    say "update the app" instead of "wrong wallet" / rewriting a newer
 *    client's envelope with an older format (the back-fill downgrade hazard);
 *  - the declared version is downgrade-proof: lying about `v` selects an AAD
 *    the AEAD tag cannot verify under;
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
import { UnknownRecoveryEnvelopeVersionError, recoveryAadBytes } from "../src/lib/auth/recovery-aad.js";
import {
  derivePortabilityKeys,
  readPortabilityEnvelope,
} from "../src/lib/auth/recovery-portability.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";

const KERNEL = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const SEED_A = new Uint8Array(32).fill(7);
const BUNDLE: RecoveryBundle = { version: 1, secrets: { podSeed: "0x" + "ab".repeat(32) } };

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
  assert.equal(opened.secrets.podSeed, BUNDLE.secrets.podSeed);
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
 * `woco/recovery/v1:{addr}`, no role component. This is the on-feed format of
 * every escrow sealed before this change — the compat contract under test.
 */
async function sealLegacyV1(recipientPubHex: string): Promise<RecoveryEnvelope> {
  const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const toAb = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const aad = new TextEncoder().encode(`woco/recovery/v1:${KERNEL.toLowerCase()}`);
  const dek = randomBytes(32);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(dek, nonce, aad).encrypt(new TextEncoder().encode(JSON.stringify(BUNDLE)));
  const recipientPublicKey = await hpke.kem.deserializePublicKey(toAb(hexToBytes(recipientPubHex)));
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

test("legacy v1 envelopes still open — under either role, as before roles existed", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealLegacyV1(kp.publicKeyHex);
  for (const role of ["guardian", "portability"] as const) {
    const opened = await openRecoveryBundle({ envelope, kernelAddress: KERNEL, role, guardianKeypair: kp });
    assert.equal(opened.secrets.podSeed, BUNDLE.secrets.podSeed);
  }
});

test("an unknown envelope.v throws the TYPED error, before any unwrap work", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const envelope = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  await assert.rejects(
    openRecoveryBundle({ envelope: { ...envelope, v: 3 }, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
    (e: unknown) => e instanceof UnknownRecoveryEnvelopeVersionError,
  );
  assert.throws(() => recoveryAadBytes("guardian", 3, KERNEL), UnknownRecoveryEnvelopeVersionError);
});

test("the declared version is downgrade-proof: lying about v fails the AEAD, both directions", async () => {
  const kp = await deriveEncryptionKeypairFromSeed(SEED_A);
  const v2 = await sealRecoveryBundle({
    bundle: BUNDLE,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [kp.publicKeyHex],
  });
  await assert.rejects(
    openRecoveryBundle({ envelope: { ...v2, v: 1 }, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
    /no wrapped DEK opens/,
  );
  const v1 = await sealLegacyV1(kp.publicKeyHex);
  await assert.rejects(
    openRecoveryBundle({ envelope: { ...v1, v: 2 }, kernelAddress: KERNEL, role: "guardian", guardianKeypair: kp }),
    /no wrapped DEK opens/,
  );
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
      secrets: { preservedKernelAddress: KERNEL.toLowerCase(), podSeed: "0x" + "cd".repeat(32) },
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
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({ status: "found", value: payload, version: 0 }),
  });
  assert.equal(read.status, "found");
  assert.equal(read.status === "found" && read.value.preservedKernelAddress, KERNEL.toLowerCase());
});

test("portability read: a NEWER wrapper version is unreadable — never the rewritable 'unusable'", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({ status: "found", value: { ...payload, v: (PORTABILITY_ENVELOPE_VERSION + 1) as never }, version: 0 }),
  });
  assert.equal(read.status, "unreadable");
});

test("portability read: a NEWER inner envelope version is unreadable — never the rewritable 'unusable'", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({
      status: "found",
      value: { ...payload, envelope: { ...payload.envelope, v: 3 } },
      version: 0,
    }),
  });
  assert.equal(read.status, "unreadable");
});

test("portability read: an OLDER wrapper version stays unusable (the documented self-heal rewrite)", async () => {
  const payload = await realPortabilityEnvelope();
  const read = await readPortabilityEnvelope({
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({ status: "found", value: { ...payload, v: 1 as never }, version: 0 }),
  });
  assert.equal(read.status, "unusable");
});

test("portability read: a tampered inner envelope is unusable — an integrity fault, not a version case", async () => {
  const payload = await realPortabilityEnvelope();
  const flipped = payload.envelope.ciphertext.replace(/^../, (h) => (h === "00" ? "01" : "00"));
  const read = await readPortabilityEnvelope({
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({
      status: "found",
      value: { ...payload, envelope: { ...payload.envelope, ciphertext: flipped } },
      version: 0,
    }),
  });
  assert.equal(read.status, "unusable");
});

test("portability read: absent and unavailable map to absent and unreadable", async () => {
  const absent = await readPortabilityEnvelope({ passkeyPrivKey: PRF_KEY, readFeed: feedOf({ status: "absent" }) });
  assert.equal(absent.status, "absent");
  const down = await readPortabilityEnvelope({
    passkeyPrivKey: PRF_KEY,
    readFeed: feedOf({ status: "unavailable", reason: "gateway 502" }),
  });
  assert.equal(down.status, "unreadable");
});
