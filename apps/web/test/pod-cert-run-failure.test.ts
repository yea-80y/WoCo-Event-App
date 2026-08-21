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

const ISSUE = strip(read("../src/lib/pod-cert/issue.ts"));
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
