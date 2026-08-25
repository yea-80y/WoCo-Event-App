/**
 * #34 — referral capture is silent to the server by design; it must not also be
 * silent to the visitor. These pin the rules the banner depends on.
 *
 * Testable at all because lib/campaign/referral-capture.ts imports nothing —
 * the same property that keeps it out of the router's dependency graph.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const {
  storeCapturedRef,
  readCapturedRef,
  clearCapturedRef,
  referralNoticeFor,
  dismissReferralNotice,
  shortRef,
  classifyRefToken,
  storeCapturedRefName,
  capturedRefName,
  unresolvedRefName,
} = await import("../src/lib/campaign/referral-capture.js");

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

test("a captured referrer is stored lowercased and read back", () => {
  storeCapturedRef(A);
  assert.equal(readCapturedRef(), A.toLowerCase());
});

test("a malformed referrer is not stored", () => {
  storeCapturedRef("not-an-address");
  storeCapturedRef("0x1234");
  assert.equal(readCapturedRef(), null);
});

test("the notice is offered for a fresh capture and withdrawn once dismissed", () => {
  storeCapturedRef(A);
  assert.equal(referralNoticeFor()?.display, "0xaaaa…aaaa");
  dismissReferralNotice();
  assert.equal(referralNoticeFor(), null);
  // Dismissing the notice must not discard the referral itself — the credit is
  // the point, and it posts at the visitor's first authenticated moment.
  assert.equal(readCapturedRef(), A.toLowerCase());
});

test("a DIFFERENT invite is acknowledged even after an earlier dismissal", () => {
  storeCapturedRef(A);
  dismissReferralNotice();
  assert.equal(referralNoticeFor(), null);
  storeCapturedRef(B);
  assert.equal(
    referralNoticeFor()?.display,
    "0xbbbb…bbbb",
    "one dismissal must not silence every future invite",
  );
});

test("re-capturing the SAME referrer stays dismissed", () => {
  storeCapturedRef(A);
  dismissReferralNotice();
  storeCapturedRef(A);
  assert.equal(referralNoticeFor(), null, "revisiting the same link must not nag");
});

test("a capture AFTER the referral was posted is acknowledged again", () => {
  // clearCapturedRef runs when the pending referral posts. It drops the
  // dismissal too, so following a fresh invite later is a fresh fact rather
  // than something a months-old dismissal silences.
  storeCapturedRef(A);
  dismissReferralNotice();
  clearCapturedRef();
  storeCapturedRef(A);
  assert.equal(referralNoticeFor()?.display, "0xaaaa…aaaa");
});

test("the notice cannot outlive the referral it describes", () => {
  storeCapturedRef(A);
  clearCapturedRef();
  assert.equal(referralNoticeFor(), null);
});

test("storage that throws reads as no capture and never throws", () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => storeCapturedRef(A));
  assert.equal(readCapturedRef(), null);
  assert.equal(referralNoticeFor(), null);
  assert.doesNotThrow(() => dismissReferralNotice());
  assert.doesNotThrow(() => clearCapturedRef());
});

test("shortRef keeps both ends so the link is recognisable", () => {
  assert.equal(shortRef(A.toLowerCase()), "0xaaaa…aaaa");
});

// ── sub-ENS referral links (#34 item 3) ──────────────────────────────────────

test("a link token is classified as an address, a name, or neither", () => {
  assert.deepEqual(classifyRefToken(A), { kind: "address", address: A.toLowerCase() });
  assert.deepEqual(classifyRefToken("TheVenue"), { kind: "name", label: "thevenue" });
  // The registrar's own suffix is accepted, so a pasted full name works.
  assert.deepEqual(classifyRefToken("thevenue.woco.eth"), { kind: "name", label: "thevenue" });
  assert.equal(classifyRefToken("not a name!").kind, "invalid");
  // Hex characters are valid label characters, so a truncated address would
  // otherwise be looked up as a name — and a label of that shape can be
  // registered, catching the credit from every mistyped invite.
  assert.equal(classifyRefToken("0x1234").kind, "invalid");
  assert.equal(classifyRefToken("0XDEADBEEF").kind, "invalid");
});

test("a named invite is acknowledged BEFORE the name resolves", () => {
  // Resolution is a network read. The visitor followed an invite either way,
  // and telling them so must not wait on a registrar.
  storeCapturedRefName("thevenue");
  assert.equal(readCapturedRef(), null);
  assert.equal(referralNoticeFor()?.display, "thevenue.woco.eth");
});

test("the notice shows the NAME, not the address, once both are known", () => {
  storeCapturedRefName("thevenue");
  storeCapturedRef(A);
  assert.equal(referralNoticeFor()?.display, "thevenue.woco.eth");
});

test("dismissing before resolution stays dismissed after it", () => {
  // The notice key must not flip from name to address when resolution lands,
  // or a visitor who dismissed the banner would see it come back.
  storeCapturedRefName("thevenue");
  dismissReferralNotice();
  storeCapturedRef(A);
  assert.equal(referralNoticeFor(), null);
});

test("a name with no address yet is reported as pending, and stops being so once resolved", () => {
  storeCapturedRefName("thevenue");
  assert.equal(unresolvedRefName(), "thevenue", "the post path must know to retry this");
  storeCapturedRef(A);
  assert.equal(unresolvedRefName(), null, "resolved names must not be re-resolved forever");
});

test("clearing the capture clears the name with it", () => {
  storeCapturedRefName("thevenue");
  storeCapturedRef(A);
  clearCapturedRef();
  assert.equal(capturedRefName(), null);
  assert.equal(unresolvedRefName(), null);
  assert.equal(referralNoticeFor(), null);
});

test("a malformed name is not stored", () => {
  storeCapturedRefName("not a name!");
  assert.equal(capturedRefName(), null);
});
