/**
 * The refusals `issueCertificates` makes BEFORE it reads or writes anything.
 *
 * Every one of these guards catches a failure that is otherwise SILENT — not a
 * thrown error, not a bad status, but a run that appears to succeed while
 * writing permanent bytes to the wrong place or with the wrong key. That is the
 * failure shape this rail keeps producing, so the guards are tested rather than
 * trusted to their comments.
 *
 * All four fire before the first gateway call, which is why this file needs no
 * network: if one of them ever stopped firing early, these tests would hang or
 * fail on a real read instead of asserting a refusal — itself the signal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { Wallet } from "ethers";
import { precheckIssuance } from "../src/lib/cert/issue.js";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";
import { issuingAddress, verifyManifestV2, type Hex0x } from "@woco/shared";

/** The badge's issuing key (secp256k1) — its ADDRESS is the issuer identity. */
const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = issuingAddress(ISSUER_PRIV);
const OTHER_PRIV = new Uint8Array(32).fill(11);
const HOLDER = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(9))).toString("hex");

/** A real feed signer pair, so the key↔address guard passes unless we break it. */
const FEED_PRIV = `0x${"22".repeat(32)}`;
const FEED_ADDR = new Wallet(FEED_PRIV).address.toLowerCase() as Hex0x;

function badge(over: Record<string, unknown> = {}) {
  return buildCertBadgeManifest({
    issuingPrivKey: ISSUER_PRIV,
    name: "Founding Member",
    description: "",
    cap: 10,
    seriesId: "fixed",
    mintedAt: "2026-08-21T00:00:00.000Z",
    ...over,
  });
}

function run(over: Record<string, unknown> = {}) {
  const b = badge();
  return precheckIssuance({
    badge: b.manifestDigestHex,
    manifest: b.signedManifest,
    expectedLogOwner: FEED_ADDR,
    keys: { issuingPrivKey: ISSUER_PRIV, feedPrivKey: FEED_PRIV, feedAddress: FEED_ADDR },
    holders: [HOLDER],
    ...over,
  } as Parameters<typeof precheckIssuance>[0]);
}

/** The precheck's error, or "" when it passed. */
const why = (r: Awaited<ReturnType<typeof precheckIssuance>>) => (r.ok ? "" : r.error);

test("a manifest that is not this badge's is REFUSED", async () => {
  // The nastiest case on this path: an issuing key that agrees with itself but
  // is not the badge's issuer. Signing would succeed, the log read would drop
  // every existing certificate as unverifiable, and every holder would be
  // re-issued — permanently, against the cap, signed by a key no door accepts.
  const mine = badge();
  const theirs = badge({ seriesId: "a-different-badge" });
  const r = await run({ badge: mine.manifestDigestHex, manifest: theirs.signedManifest });
  assert.equal(r.ok, false);
  assert.match(why(r), /not this badge/i);
});

test("a manifest signed by a DIFFERENT issuer is refused too", async () => {
  const mine = badge();
  const forged = buildCertBadgeManifest({
    issuingPrivKey: OTHER_PRIV,
    name: "Founding Member",
    description: "",
    cap: 10,
    seriesId: "fixed",
    mintedAt: "2026-08-21T00:00:00.000Z",
  });
  const r = await run({ badge: mine.manifestDigestHex, manifest: forged.signedManifest });
  assert.equal(r.ok, false, "a manifest naming someone else's issuer has a different digest");
});

test("writing under an address the directory does not name is REFUSED", async () => {
  // Otherwise: a clean, empty, parallel log at an address no reader looks at.
  // Indistinguishable from a first issuance, and permanent.
  const elsewhere = new Wallet(`0x${"33".repeat(32)}`).address.toLowerCase() as Hex0x;
  const r = await run({ expectedLogOwner: elsewhere });
  assert.equal(r.ok, false);
  assert.match(why(r), /feed signer|second log/i);
});

test("the owner check is case-insensitive — a checksummed address is not a mismatch", async () => {
  const checksummed = new Wallet(FEED_PRIV).address as Hex0x; // mixed case
  const r = await run({ expectedLogOwner: checksummed });
  assert.equal(r.ok, true, `case difference must not read as a different owner (got: ${why(r)})`);
});

test("a feed key that disagrees with its own address is REFUSED", async () => {
  // Surfaces otherwise as `unconfirmed`, late and mislabelled as a gateway fault:
  // the read-back would be verifying a feed we did not write.
  const r = await run({
    keys: { issuingPrivKey: ISSUER_PRIV, feedPrivKey: `0x${"44".repeat(32)}`, feedAddress: FEED_ADDR },
  });
  assert.equal(r.ok, false);
  assert.match(why(r), /disagree/i);
});

test("extras keyed to somebody not in this run are REFUSED, not dropped", async () => {
  // A dropped `encPubKey` is a permanent certificate missing the field that the
  // whole per-drop encryption path depends on — and nothing downstream notices.
  const stranger = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(13))).toString("hex");
  const r = await run({ extras: { [stranger]: { encPubKey: "ab".repeat(32) } } });
  assert.equal(r.ok, false);
  assert.match(why(r), /not in this run/i);
});

test("extras for a holder who IS in the run pass the orphan check", async () => {
  const r = await run({ extras: { [HOLDER]: { encPubKey: "ab".repeat(32) } } });
  assert.equal(r.ok, true, `a legitimate extras key must not be refused (got: ${why(r)})`);
});

test("extras matched case-insensitively — an upper-case key is neither orphan nor dropped", async () => {
  const r = await run({ extras: { [HOLDER.toUpperCase()]: { encPubKey: "ab".repeat(32) } } });
  assert.equal(r.ok, true, `case difference must not read as an orphan (got: ${why(r)})`);
});

test("the cap comes from the SIGNED MANIFEST, not from a caller-supplied number", () => {
  // `cap` is no longer a parameter of `issueCertificates` at all, so passing a
  // stale `PodDirectoryEntry.supply` is impossible rather than discouraged.
  // What the run enforces is `manifest.body.totalSupply`, and the manifest is
  // signed — so the number cannot be moved without breaking the signature.
  const b = badge({ cap: 2 });
  assert.equal(b.signedManifest.body.totalSupply, 2);
  const tampered = {
    ...b.signedManifest,
    body: { ...b.signedManifest.body, totalSupply: 999 },
  };
  assert.ok(
    !verifyManifestV2(tampered),
    "raising the cap must break the issuer signature — the cap is signed, not asserted",
  );
});

test("a well-formed run passes every precheck", async () => {
  const r = await run();
  assert.equal(r.ok, true, why(r));
  if (r.ok) assert.equal(r.issuer, ISSUER, "the resolved issuer is the badge's own");
});
