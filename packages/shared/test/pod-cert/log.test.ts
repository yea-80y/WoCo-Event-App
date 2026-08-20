/**
 * `woco.pod-cert-log.v1` — the issuer's per-badge log page.
 *
 * The size rules here are not tidiness. A page that reaches 4096 bytes pages
 * across `_woco_mc`, which is a torn-write hazard (#315) and destroys the
 * atomicity the write's read-back depends on — and until holder import exists,
 * a certificate lives nowhere but this log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  MAX_POD_CERT_BYTES,
  POD_CERT_LOG_FORMAT,
  POD_CERT_LOG_PAGE_MAX_BYTES,
  holdersFromLogPages,
  jsonByteLength,
  packPodCertLogPages,
  signPodCert,
  validatePodCertLogPageV1,
  verifyPodCertLogPage,
  type PodCertV1,
} from "../../src/pod-cert/index.js";

const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = bytesToHex(ed25519.getPublicKey(ISSUER_PRIV));
const OTHER_PRIV = new Uint8Array(32).fill(11);
const OTHER = bytesToHex(ed25519.getPublicKey(OTHER_PRIV));
const BADGE = `0x${"ab".repeat(32)}`;

function certFor(seed: number, priv = ISSUER_PRIV, issuer = ISSUER): PodCertV1 {
  const holderPriv = new Uint8Array(32).fill(seed);
  const holder = bytesToHex(ed25519.getPublicKey(holderPriv));
  return signPodCert(
    { format: "woco.pod-cert.v1", badge: BADGE, holder, issuedAt: "2026-08-20" },
    priv,
    issuer,
  );
}

// ---------------------------------------------------------------------------
// The closed schema
// ---------------------------------------------------------------------------

test("a log page is exactly format + certs, and never empty", () => {
  const page = { format: POD_CERT_LOG_FORMAT, certs: [certFor(1)] };
  assert.ok(validatePodCertLogPageV1(page));

  assert.ok(!validatePodCertLogPageV1({ ...page, certs: [] }), "an empty page is a wasted version");
  assert.ok(!validatePodCertLogPageV1({ ...page, extra: 1 }), "unknown field");
  assert.ok(!validatePodCertLogPageV1({ ...page, format: "woco.pod-cert-log.v2" }), "wrong format");
  assert.ok(!validatePodCertLogPageV1({ certs: page.certs }), "missing format");
  assert.ok(
    !validatePodCertLogPageV1({ ...page, certs: [{ ...certFor(1), extra: 1 }] }),
    "a malformed certificate fails the whole page's shape check",
  );
});

test("a log page can never carry the paging marker", () => {
  // The closed validator is what guarantees this: `_woco_mc` on a payload is
  // how a reader recognises a multi-chunk manifest, so a statement able to
  // carry that key could be mistaken for one.
  const page = { format: POD_CERT_LOG_FORMAT, certs: [certFor(1)], _woco_mc: 1 };
  assert.ok(!validatePodCertLogPageV1(page));
});

// ---------------------------------------------------------------------------
// Size — the rule the feed's atomicity depends on
// ---------------------------------------------------------------------------

test("signing refuses a certificate too large to sit in a page", () => {
  const holderPriv = new Uint8Array(32).fill(3);
  const holder = bytesToHex(ed25519.getPublicKey(holderPriv));
  const huge = Array.from({ length: 200 }, (_, i) => `woco.evidence-report.v1:${"A".repeat(40)}${i}`);
  assert.throws(
    () =>
      signPodCert(
        { format: "woco.pod-cert.v1", badge: BADGE, holder, issuedAt: "2026-08-20", evidence: huge },
        ISSUER_PRIV,
        ISSUER,
      ),
    /over the 2048-byte limit/,
  );
});

test("a conforming certificate leaves room for many page-mates", () => {
  const one = certFor(1);
  assert.ok(jsonByteLength(one) < 400, `a bare certificate is ${jsonByteLength(one)} bytes`);
  assert.ok(jsonByteLength(one) <= MAX_POD_CERT_BYTES);
});

test("the packer fills pages and never emits one that would page", () => {
  const certs = Array.from({ length: 60 }, (_, i) => certFor(i + 1));
  const pages = packPodCertLogPages(certs);

  assert.ok(pages.length > 1, "60 certificates do not fit one chunk");
  for (const page of pages) {
    assert.ok(
      jsonByteLength(page) <= POD_CERT_LOG_PAGE_MAX_BYTES,
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
  const pages = packPodCertLogPages(certs);
  for (let i = 0; i < pages.length - 1; i++) {
    const overfilled = {
      format: POD_CERT_LOG_FORMAT,
      certs: [...pages[i]!.certs, pages[i + 1]!.certs[0]!],
    };
    assert.ok(
      jsonByteLength(overfilled) > POD_CERT_LOG_PAGE_MAX_BYTES,
      `page ${i} had room for one more and did not take it`,
    );
  }
});

test("one certificate always fits a page alone", () => {
  assert.deepEqual(packPodCertLogPages([certFor(1)]).length, 1);
  assert.equal(packPodCertLogPages([]).length, 0);
});

test("a certificate that evaded the signing bound is refused, not paged", () => {
  // Reachable only by constructing bytes `signPodCert` would not produce.
  // Dropping it would lose a certificate; paging it would brick the feed.
  const forged = {
    ...certFor(1),
    evidence: Array.from({ length: 400 }, (_, i) => `woco.x.v1:${"A".repeat(40)}${i}`),
  } as PodCertV1;
  assert.throws(() => packPodCertLogPages([forged]), /exceeds 4096 bytes/);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("a bad certificate is dropped without voiding its page-mates", () => {
  const good = certFor(1);
  const wrongIssuer = certFor(2, OTHER_PRIV, OTHER);
  const page = { format: POD_CERT_LOG_FORMAT, certs: [wrongIssuer, good] };

  const verified = verifyPodCertLogPage(page, ISSUER);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.holder, good.holder);
});

test("a page that is not a log page verifies to nothing", () => {
  assert.deepEqual(verifyPodCertLogPage({ format: "woco.credit.v1" }, ISSUER), []);
  assert.deepEqual(verifyPodCertLogPage(null, ISSUER), []);
  assert.deepEqual(verifyPodCertLogPage({ format: POD_CERT_LOG_FORMAT, certs: [] }, ISSUER), []);
});

test("holders dedupe across pages — presence, not certificate count", () => {
  // The audit's unit. An issuer re-signs when a holder rotates keys or a date
  // was wrong, so counting certificates would inflate supply.
  const a = certFor(1);
  const b = certFor(2);
  const aAgain = signPodCert(
    { format: "woco.pod-cert.v1", badge: BADGE, holder: a.holder, issuedAt: "2026-09-01" },
    ISSUER_PRIV,
    ISSUER,
  );
  assert.notEqual(a.issuerSig, aAgain.issuerSig, "a genuine re-issue, different bytes");

  const holders = holdersFromLogPages([[a, b], [aAgain]]);
  assert.deepEqual(holders, [a.holder, b.holder]);
});
