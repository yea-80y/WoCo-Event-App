/**
 * `woco.cert-log.v1` — the issuer's per-badge log page, on the v2 issuer curve.
 *
 * The size rules here are not tidiness. A page that reaches 4096 bytes pages
 * across `_woco_mc`, which is a torn-write hazard (#315) and destroys the
 * atomicity the write's read-back depends on — and until holder import exists,
 * a certificate lives nowhere but this log.
 *
 * NOT TESTED HERE, because not ported here: the band/version cursor arithmetic
 * and the holder dedupe. Both are log-format-agnostic and stay in
 * `pod-cert/log.ts` until the v1 module is deleted (PR 5a) — their tests stay
 * in `test/pod-cert/log.test.ts` with them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  CERT_LOG_FORMAT,
  CERT_LOG_PAGE_MAX_BYTES,
  packCertLogPages,
  validateCertLogPageV1,
  verifyCertLogPage,
} from "../../src/cert/log.js";
import { MAX_CERT_BYTES, signCertV1, type CertV1 } from "../../src/cert/types.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import { asHolderPubkey } from "../../src/crypto/brands.js";

const ISSUING = deriveIssuingKey(`0x${"ab".repeat(32)}`, 0);
const OTHER_ISSUING = deriveIssuingKey(`0x${"cd".repeat(32)}`, 0);
const BADGE = `0x${"ab".repeat(32)}`;

/** The module keeps its own copy private; the test needs the same arithmetic. */
function jsonByteLength(value: unknown): number {
  return utf8ToBytes(JSON.stringify(value)).length;
}

function certFor(seed: number, issuing = ISSUING): CertV1 {
  const holderPriv = new Uint8Array(32).fill(seed);
  const holder = asHolderPubkey(bytesToHex(ed25519.getPublicKey(holderPriv)));
  return signCertV1(
    { format: "woco.cert.v1", badge: BADGE, holder, issuedAt: "2026-08-20" },
    issuing.privateKey,
    issuing.address,
  );
}

// ---------------------------------------------------------------------------
// The closed schema
// ---------------------------------------------------------------------------

test("a log page is exactly format + certs, and never empty", () => {
  const page = { format: CERT_LOG_FORMAT, certs: [certFor(1)] };
  assert.ok(validateCertLogPageV1(page));

  assert.ok(!validateCertLogPageV1({ ...page, certs: [] }), "an empty page is a wasted version");
  assert.ok(!validateCertLogPageV1({ ...page, extra: 1 }), "unknown field");
  assert.ok(!validateCertLogPageV1({ ...page, format: "woco.cert-log.v2" }), "wrong format");
  assert.ok(!validateCertLogPageV1({ ...page, format: "woco.pod-cert-log.v1" }), "the v1 rail's page format");
  assert.ok(!validateCertLogPageV1({ certs: page.certs }), "missing format");
  assert.ok(
    !validateCertLogPageV1({ ...page, certs: [{ ...certFor(1), extra: 1 }] }),
    "a malformed certificate fails the whole page's shape check",
  );
});

test("a log page can never carry the paging marker", () => {
  // The closed validator is what guarantees this: `_woco_mc` on a payload is
  // how a reader recognises a multi-chunk manifest, so a statement able to
  // carry that key could be mistaken for one.
  const page = { format: CERT_LOG_FORMAT, certs: [certFor(1)], _woco_mc: 1 };
  assert.ok(!validateCertLogPageV1(page));
});

// ---------------------------------------------------------------------------
// Size — the rule the feed's atomicity depends on
// ---------------------------------------------------------------------------

test("a conforming certificate leaves room for many page-mates", () => {
  const one = certFor(1);
  assert.ok(jsonByteLength(one) < 400, `a bare certificate is ${jsonByteLength(one)} bytes`);
  assert.ok(jsonByteLength(one) <= MAX_CERT_BYTES);
});

test("the packer fills pages and never emits one that would page", () => {
  const certs = Array.from({ length: 60 }, (_, i) => certFor(i + 1));
  const pages = packCertLogPages(certs);

  assert.ok(pages.length > 1, "60 certificates do not fit one chunk");
  for (const page of pages) {
    assert.ok(
      jsonByteLength(page) <= CERT_LOG_PAGE_MAX_BYTES,
      `page of ${page.certs.length} is ${jsonByteLength(page)} bytes`,
    );
    assert.ok(page.certs.length > 0);
  }

  // Nothing lost, nothing duplicated, order preserved.
  const flat = pages.flatMap((p) => p.certs);
  assert.equal(flat.length, certs.length);
  assert.deepEqual(flat.map((c) => c.holder), certs.map((c) => c.holder));
});

test("the packer is greedy — a page is full before the next one opens", () => {
  const certs = Array.from({ length: 60 }, (_, i) => certFor(i + 1));
  const pages = packCertLogPages(certs);
  for (let i = 0; i < pages.length - 1; i++) {
    const overfilled = {
      format: CERT_LOG_FORMAT,
      certs: [...pages[i]!.certs, pages[i + 1]!.certs[0]!],
    };
    assert.ok(
      jsonByteLength(overfilled) > CERT_LOG_PAGE_MAX_BYTES,
      `page ${i} had room for one more and did not take it`,
    );
  }
});

test("one certificate always fits a page alone", () => {
  assert.deepEqual(packCertLogPages([certFor(1)]).length, 1);
  assert.equal(packCertLogPages([]).length, 0);
});

test("a certificate that evaded the signing bound is refused, not paged", () => {
  // Reachable only by constructing bytes `signCertV1` would not produce.
  // Dropping it would lose a certificate; paging it would brick the feed.
  const forged = {
    ...certFor(1),
    evidence: Array.from({ length: 400 }, (_, i) => `woco.x.v1:${"A".repeat(40)}${i}`),
  } as CertV1;
  assert.throws(() => packCertLogPages([forged]), /exceeds 4096 bytes/);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("a bad certificate is dropped without voiding its page-mates", () => {
  const good = certFor(1);
  const wrongIssuer = certFor(2, OTHER_ISSUING);
  const tampered = { ...certFor(3), issuedAt: "2020-01-01" };
  const page = { format: CERT_LOG_FORMAT, certs: [wrongIssuer, tampered, good] };

  const verified = verifyCertLogPage(page, ISSUING.address);
  assert.equal(verified.length, 1, "both bad certificates dropped, the good one kept");
  assert.equal(verified[0]!.holder, good.holder);
});

test("a page that is not a log page verifies to nothing", () => {
  assert.deepEqual(verifyCertLogPage({ format: "woco.credit.v1" }, ISSUING.address), []);
  assert.deepEqual(verifyCertLogPage(null, ISSUING.address), []);
  assert.deepEqual(verifyCertLogPage({ format: CERT_LOG_FORMAT, certs: [] }, ISSUING.address), []);
  assert.deepEqual(
    verifyCertLogPage({ format: "woco.pod-cert-log.v1", certs: [certFor(1)] }, ISSUING.address),
    [],
    "the v1 rail's envelope is refused at dispatch, not read leniently",
  );
});
