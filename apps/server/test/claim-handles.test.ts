/**
 * Wallet-address hashing on public claim surfaces, and the sealed raw address
 * that rides in pending entries. These guard the privacy properties directly:
 * a regression here republishes wallet↔attendance linkage on public feeds.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.EMAIL_HASH_SECRET ??= "test-secret-claim-handles";

const ADDR = "0xAbCdEF0123456789abcdef0123456789ABCDEF01";
const SERIES_A = "series-aaaa";
const SERIES_B = "series-bbbb";

describe("hashWalletAddress / walletHandle", () => {
  let svc: typeof import("../src/lib/event/claim-service.js");
  before(async () => {
    svc = await import("../src/lib/event/claim-service.js");
  });

  it("is deterministic and case/whitespace-normalising", () => {
    assert.equal(
      svc.hashWalletAddress(ADDR, SERIES_A),
      svc.hashWalletAddress(` ${ADDR.toLowerCase()} `, SERIES_A),
    );
  });

  it("per-series salt: same wallet, different series → unlinkable handles", () => {
    assert.notEqual(
      svc.hashWalletAddress(ADDR, SERIES_A),
      svc.hashWalletAddress(ADDR, SERIES_B),
    );
  });

  it("key-separated from email hashing: a crafted email cannot collide", () => {
    // hashEmail HMACs attacker-chosen strings under the raw secret with no
    // prefix, so wallet hashing must use an independent HKDF-derived key —
    // even an email equal to the exact wallet HMAC input must not collide.
    const emailHash = svc.hashEmail(`${SERIES_A}:${ADDR.toLowerCase()}`);
    assert.notEqual(emailHash, svc.hashWalletAddress(ADDR, SERIES_A));
  });

  it("walletHandle carries the wallet: prefix", () => {
    assert.ok(svc.walletHandle(ADDR, SERIES_A).startsWith("wallet:"));
  });
});

describe("claimHandleMatches", () => {
  let svc: typeof import("../src/lib/event/claim-service.js");
  before(async () => {
    svc = await import("../src/lib/event/claim-service.js");
  });

  it("matches a hashed entry to its raw address, per series", () => {
    const entry = svc.walletHandle(ADDR, SERIES_A);
    assert.ok(svc.claimHandleMatches(entry, ADDR.toLowerCase(), SERIES_A));
    assert.ok(!svc.claimHandleMatches(entry, ADDR.toLowerCase(), SERIES_B));
  });

  it("matches legacy bare-address entries", () => {
    assert.ok(svc.claimHandleMatches(ADDR.toLowerCase(), ADDR, SERIES_A));
  });

  it("does not match a different wallet", () => {
    const other = "0x0000000000000000000000000000000000000001";
    assert.ok(!svc.claimHandleMatches(svc.walletHandle(ADDR, SERIES_A), other, SERIES_A));
  });

  it("email handles match by equality only", () => {
    assert.ok(svc.claimHandleMatches("email:deadbeef", "email:deadbeef", SERIES_A));
    assert.ok(!svc.claimHandleMatches("email:deadbeef", "email:cafebabe", SERIES_A));
  });
});

describe("sealClaimer / unsealClaimer", () => {
  let seal: typeof import("../src/lib/event/claimer-seal.js");
  before(async () => {
    seal = await import("../src/lib/event/claimer-seal.js");
  });

  it("round-trips under the same {seriesId, pendingId} context", () => {
    const sealed = seal.sealClaimer(ADDR.toLowerCase(), SERIES_A, "pend-1");
    assert.equal(seal.unsealClaimer(sealed, SERIES_A, "pend-1"), ADDR.toLowerCase());
  });

  it("AAD binding: unsealing under another entry's context fails", () => {
    const sealed = seal.sealClaimer(ADDR.toLowerCase(), SERIES_A, "pend-1");
    assert.equal(seal.unsealClaimer(sealed, SERIES_A, "pend-2"), null);
    assert.equal(seal.unsealClaimer(sealed, SERIES_B, "pend-1"), null);
  });

  it("tampered ciphertext fails closed", () => {
    const sealed = seal.sealClaimer(ADDR.toLowerCase(), SERIES_A, "pend-1");
    const buf = Buffer.from(sealed, "base64");
    buf[buf.length - 1] ^= 0x01;
    assert.equal(seal.unsealClaimer(buf.toString("base64"), SERIES_A, "pend-1"), null);
    assert.equal(seal.unsealClaimer("not-base64!!", SERIES_A, "pend-1"), null);
  });

  it("fresh IV per seal — identical plaintext yields distinct ciphertext", () => {
    assert.notEqual(
      seal.sealClaimer(ADDR, SERIES_A, "pend-1"),
      seal.sealClaimer(ADDR, SERIES_A, "pend-1"),
    );
  });
});
