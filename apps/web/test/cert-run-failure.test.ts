/**
 * The three defects the slice-4 review found, pinned.
 *
 * All three share this rail's signature failure shape — the surface looks like
 * it is working while the truth is elsewhere — and none was reachable by the
 * tests that already existed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const ISSUE = strip(read("../src/lib/cert/issue.ts"));
const MODAL_RAW = read("../src/lib/components/pod/CertIssueModal.svelte");
const MODAL = strip(MODAL_RAW);
const DRAWER = read("../src/lib/components/pod/PodEditDrawer.svelte");

// ---------------------------------------------------------------------------
// #1 — an upload that THROWS must become a stop, not an escaping rejection
// ---------------------------------------------------------------------------

test("the write call is inside a try — a throwing upload cannot escape the run", () => {
  // `writeContentFeedVerified` does NOT catch its upload half: only the
  // read-back (`verifyLanded`) is documented never to throw, and
  // `writeContentFeed` sits outside that try. `signAndUploadSoc` throws by
  // contract when the relay refuses. Uncaught, the rejection escapes past every
  // `stop` the caller can render, stranding a surface mid-run with everything
  // already landed unreported.
  const call = ISSUE.indexOf("writeContentFeedVerified({");
  assert.ok(call > 0, "the write call must still exist");
  const before = ISSUE.slice(0, call);
  assert.ok(
    before.lastIndexOf("try {") > before.lastIndexOf("for (const page of pages)"),
    "a `try {` must open between the page loop and the write call",
  );
});

test("a thrown upload is reported as `unconfirmed`, never as a silent success", () => {
  const call = ISSUE.indexOf("writeContentFeedVerified({");
  const after = ISSUE.slice(call, call + 1400);
  assert.match(after, /catch\s*\(/, "the write must have a catch");
  assert.match(after, /stop:\s*"unconfirmed"/, "an unknown outcome is `unconfirmed`");
  assert.match(after, /landed,/, "everything already landed must still be reported");
});

test("the surface guards the run too — it can never be left spinning", () => {
  // `close()` refuses while `phase === "running"`, so an escaping rejection
  // would leave the organiser in a dialog they cannot dismiss.
  const call = MODAL.indexOf("issueCertificates({");
  assert.ok(call > 0);
  assert.ok(MODAL.slice(0, call).lastIndexOf("try {") > MODAL.lastIndexOf("async function run("),
    "run() must wrap the call in try");
  assert.match(MODAL.slice(call), /catch\s*\([\s\S]{0,400}?phase\s*=\s*result\.ok|catch\s*\(/, "and catch it");
});

// ---------------------------------------------------------------------------
// #2 — the award modal opens from inside the drawer, so it must stack above it
// ---------------------------------------------------------------------------

function zIndexes(src: string): number[] {
  return [...src.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
}

test("the award modal stacks ABOVE the drawer that opens it", () => {
  // At the modal default of 90/91 it rendered BEHIND PodEditDrawer (200/201) —
  // invisible, while still capturing the run. Nothing in a unit test or a
  // typecheck can see this; only stacking arithmetic can.
  const modalMax = Math.max(...zIndexes(MODAL_RAW));
  const drawerMax = Math.max(...zIndexes(DRAWER));
  assert.ok(
    modalMax > drawerMax,
    `award modal (${modalMax}) must stack above PodEditDrawer (${drawerMax})`,
  );
});

test("the drawer really is where the award modal is mounted", () => {
  // The assertion above is only meaningful while that stays true.
  assert.match(DRAWER, /<CertIssueModal/, "if this moves, re-check the z-index rule");
});

// ---------------------------------------------------------------------------
// #3 — a gated 403 must not be reported as "try again"
// ---------------------------------------------------------------------------

test("a whitelist refusal is a permanent condition, not a retry", () => {
  // The chunk gate refuses exactly the addresses it was never told about, so
  // "try again" is advice that can never come good.
  const fetchAt = ISSUE.indexOf("/bytes/${swarmManifestRef}");
  assert.ok(fetchAt > 0);
  const after = ISSUE.slice(fetchAt, fetchAt + 1200);
  assert.match(after, /403/, "the gated status must be distinguished");
  assert.match(after, /X-Chunk-Gate/, "and matched on the gate's own tag, not prose");
  assert.doesNotMatch(
    after.slice(0, after.indexOf("return { ok: false, error: \"Could not read")),
    /try again/,
    "the gated branch must not advise a retry",
  );
});

// ---------------------------------------------------------------------------
// #4 — the key ceremonies must not strand the organiser either
// ---------------------------------------------------------------------------

test("the signing ceremonies are INSIDE the try, not one line above it", () => {
  // `getContentFeedSigner` is documented fail-loud, and the likeliest trigger is
  // the most ordinary user action there is: rejecting the wallet prompt on a
  // first award. Outside the try, that throw escapes `run()` with `phase` stuck
  // at "running" — and `close()` refuses mid-run, so the X is disabled and
  // Escape is refused. Reload is the only way out. This is the same
  // undismissable-dialog defect the write-throw fix targeted.
  const runAt = MODAL.indexOf("async function run(");
  const tryAt = MODAL.indexOf("try {", runAt);
  const keypairAt = MODAL.indexOf("getPodKeypair()", runAt);
  const signerAt = MODAL.indexOf("getContentFeedSigner()", runAt);
  assert.ok(tryAt > 0 && keypairAt > 0 && signerAt > 0);
  assert.ok(tryAt < keypairAt, "getPodKeypair must be inside the try");
  assert.ok(tryAt < signerAt, "getContentFeedSigner must be inside the try");
});

test("a ceremony that throws is `refused`, never `unconfirmed`", () => {
  // Nothing was sent, so telling the operator to go and re-read a log that
  // cannot have changed would be wrong — and would make a rejected signature
  // look like a possible lost write.
  const catchAt = MODAL.lastIndexOf("} catch (e) {");
  const after = MODAL.slice(catchAt, catchAt + 500);
  assert.match(after, /stop:\s*"refused"/);
  assert.doesNotMatch(after, /stop:\s*"unconfirmed"/);
});

// ---------------------------------------------------------------------------
// #5 — the picker must not claim a completeness it does not have
// ---------------------------------------------------------------------------

test("the picker reads ORDERS as well as bindings", () => {
  // Bindings alone exist only for attendees who signed in at checkout (first
  // edition of a group buy) or redeemed the email link. Using them as the
  // denominator let a 100-ticket event read as "6 of 10 attendees" at the
  // moment a PERMANENT run is confirmed.
  assert.match(MODAL, /getEventOrders\(/, "the true denominator comes from /orders");
  assert.match(MODAL, /getAttendeeKeys\(/, "joined against the sparse key set");
  assert.match(MODAL, /totalClaims/, "and the count shown is claims, not bindings");
});

test("the false-completeness copy is gone", () => {
  assert.doesNotMatch(MODAL_RAW, /whole picture/i, "it was not the whole picture");
  assert.doesNotMatch(
    MODAL_RAW,
    /of\s*\n?\s*\{attendeeSplit\.certifiable\.length \+ attendeeSplit\.withoutKey\.length\}/,
    "the denominator must not be rebuilt from the bindings split",
  );
});

test("a run in flight still cannot be dismissed — the guard that makes the above matter", () => {
  assert.match(MODAL, /function close\(\)[\s\S]{0,200}phase === "running"/, "close() refuses mid-run");
});
