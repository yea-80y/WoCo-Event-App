/**
 * Marketing compliance primitives: unsubscribe token + suppression store.
 *
 * The suppression store writes .data/ relative to process.cwd(), so this suite
 * chdirs into a temp dir BEFORE dynamically importing it — test writes never
 * touch the real .data.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-marketing";

const ORG = "0xAbCd000000000000000000000000000000000001";
const OTHER_ORG = "0x0000000000000000000000000000000000000002";
const hash = (n: number) => n.toString(16).padStart(64, "0");

let token: typeof import("../src/lib/marketing/unsub-token.js");
let store: typeof import("../src/lib/marketing/suppression-store.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-marketing-test-")));
  token = await import("../src/lib/marketing/unsub-token.js");
  store = await import("../src/lib/marketing/suppression-store.js");
});

test("unsub token round-trips and preserves payload", () => {
  const t = token.mintUnsubToken({ emailHash: hash(1), organiserAddress: ORG });
  const verdict = token.verifyUnsubToken(t);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.payload.h, hash(1));
    assert.equal(verdict.payload.o, ORG.toLowerCase());
    assert.equal(verdict.payload.v, 1);
  }
});

test("tampered payload is rejected", () => {
  const t = token.mintUnsubToken({ emailHash: hash(2), organiserAddress: ORG });
  const [prefix, b64, sig] = t.split(".");
  const forged = JSON.parse(Buffer.from(b64, "base64url").toString());
  forged.o = OTHER_ORG.toLowerCase();
  const forgedB64 = Buffer.from(JSON.stringify(forged)).toString("base64url");
  const verdict = token.verifyUnsubToken(`${prefix}.${forgedB64}.${sig}`);
  assert.deepEqual(verdict, { ok: false, reason: "bad-signature" });
});

test("malformed tokens are rejected without throwing", () => {
  for (const bad of ["", "mu1", "mu1.abc", "xx1.a.b", "mu1.!!!.zz", `mu1.${Buffer.from("[]").toString("base64url")}.00`]) {
    const verdict = token.verifyUnsubToken(bad);
    assert.equal(verdict.ok, false);
  }
});

test("org suppression is scoped to that organiser", () => {
  store.suppressOrg(hash(10), ORG, "unsub");
  assert.equal(store.isSuppressed(hash(10), ORG), true);
  assert.equal(store.isSuppressed(hash(10), ORG.toLowerCase()), true);
  assert.equal(store.isSuppressed(hash(10), OTHER_ORG), false);
});

test("global suppression applies to every organiser", () => {
  store.suppressGlobal(hash(11), "bounce");
  assert.equal(store.isSuppressed(hash(11), ORG), true);
  assert.equal(store.isSuppressed(hash(11), OTHER_ORG), true);
});

test("suppressedSubset filters to global + this org only", () => {
  store.suppressOrg(hash(20), ORG, "unsub");
  store.suppressGlobal(hash(21), "complaint");
  store.suppressOrg(hash(22), OTHER_ORG, "unsub");
  const subset = store.suppressedSubset(ORG, [hash(20), hash(21), hash(22), hash(23)]);
  assert.deepEqual(subset, [hash(20), hash(21)]);
});

test("suppression is idempotent and first mark wins", () => {
  store.suppressOrg(hash(30), ORG, "unsub");
  store.suppressOrg(hash(30), ORG, "manual");
  assert.equal(store.isSuppressed(hash(30), ORG), true);
});
