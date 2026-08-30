/**
 * #424 tier 2 — binding a series to the on-chain event it claims.
 *
 * The property: a series may only be sold against an on-chain event that
 * belongs to it.
 *
 * TWO EARLIER ATTEMPTS FAILED, both by anchoring on something the creator
 * controls, and the tests are shaped around not repeating that:
 *   1. Comparing the chain's `manifestRef` against `series.manifestRef` — both
 *      feed values, so forging both passed it.
 *   2. Comparing against the digest recomputed from the manifest BLOB —
 *      `swarmManifestRef` is also creator-controlled, so pointing it at the
 *      VICTIM's public blob passed it, with no forgery at all.
 *
 * The anchor is the server's OWN registration record. The blob digest is kept
 * as consistency enforcement, never as the anti-theft anchor.
 *
 * The tests below are written around what an attacker controls:
 *   `seriesManifestRef`  — controlled (feed)
 *   `swarmManifestRef`   — controlled (feed), hence the blob it points at
 *   `blobManifestDigest` — derived from the blob, so only as good as the blob
 *   `onChainManifestRef` — NOT controlled; stamped at registration
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSeriesOnChainBinding } from "../src/lib/event/onchain-binding.js";

const OURS   = `0x${"c3".repeat(32)}`;
const THEIRS = `0x${"d4".repeat(32)}`;

test("the series' own manifest digests to the event it claims — bound", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: OURS,
    blobManifestDigest: OURS,
    onChainManifestRef: OURS,
  });
  assert.deepEqual(v, { ok: true, checked: true });
});

test("ANCHOR: no registration record refuses, whatever the feed says", () => {
  // The case both earlier attempts missed. Every feed-derived value is
  // consistent with the victim's event here — including the blob digest, which
  // an attacker gets for free by pointing swarmManifestRef at the victim's
  // public blob. Only the server's own record disagrees, and that is enough.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: THEIRS,
    recordedOnChainEventId: null,
    seriesManifestRef: THEIRS,
    blobManifestDigest: THEIRS,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false, "a series this server never registered was allowed to sell");
  assert.equal(v.ok === false && v.reason, "no-registration-record");
});

test("ANCHOR: a record for a DIFFERENT event refuses", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: THEIRS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: THEIRS,
    blobManifestDigest: THEIRS,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "registration-record-mismatch");
});

test("ANCHOR is checked BEFORE the chain — a chain outage cannot wave it through", () => {
  // The chain-unavailable fail-open must not become a way around the anchor.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: THEIRS,
    recordedOnChainEventId: null,
    onChainManifestRef: null,
  });
  assert.equal(v.ok, false, "a chain outage bypassed the registration-record anchor");
  assert.equal(v.ok === false && v.reason, "no-registration-record");
});

test("a matching record proceeds to the consistency checks", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: OURS,
    blobManifestDigest: OURS,
    onChainManifestRef: OURS,
  });
  assert.deepEqual(v, { ok: true, checked: true });
});

test("CONSISTENCY: a blob digesting to something else is still refused", () => {
  // Retained from the previous attempt. Not the anti-theft anchor, but it stops
  // a malformed registration selling tickets whose manifests never verify.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: THEIRS,
    blobManifestDigest: OURS,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "manifest-mismatch");
});

test("a series pointed at another event's manifest is REFUSED", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: OURS,
    blobManifestDigest: OURS,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "manifest-mismatch");
});

test("an unresolvable blob is REFUSED, not waved through", () => {
  // `swarmManifestRef` is creator-controlled, so "could not fetch the blob" is
  // an attacker-reachable state. Treating it as "nothing to check" would hand
  // the bypass straight back by pointing the ref at nothing.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: THEIRS,
    blobManifestDigest: null,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false, "an unfetchable manifest was treated as verified");
  assert.equal(v.ok === false && v.reason, "manifest-unresolvable");
});

test("an ABSENT series manifestRef is refused, not skipped", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: undefined,
    blobManifestDigest: OURS,
    onChainManifestRef: OURS,
  });
  assert.equal(v.ok, false, "omitting manifestRef skipped the binding check");
  assert.equal(v.ok === false && v.reason, "no-manifest-ref");
});

test("a series whose declared digest contradicts its own manifest is refused", () => {
  // Not required for safety — the blob already settled it against the chain —
  // but a series declaring a digest its own manifest does not produce is
  // malformed, and saying so beats ignoring it.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: THEIRS,
    blobManifestDigest: OURS,
    onChainManifestRef: OURS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "series-manifest-inconsistent");
});

test("no CHAIN value — passes UNCHECKED so a flaky RPC cannot stop every sale", () => {
  // The one legitimate fail-open. Unlike the blob, the chain value is not
  // creator-controlled, so its absence is a transport condition rather than an
  // attacker-reachable state.
  for (const onChainManifestRef of [null, undefined]) {
    const v = checkSeriesOnChainBinding({
      claimedOnChainEventId: OURS,
      recordedOnChainEventId: OURS,
      seriesManifestRef: OURS,
      blobManifestDigest: OURS,
      onChainManifestRef,
    });
    assert.deepEqual(v, { ok: true, checked: false });
  }
});

test("no chain value wins over every other missing input — nothing to judge", () => {
  // The refusal must always be caused by a contradiction with the chain, never
  // by absence of information, or a chain outage would refuse every sale.
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: undefined,
    blobManifestDigest: null,
    onChainManifestRef: null,
  });
  assert.deepEqual(v, { ok: true, checked: false });
});

test("comparison is case-insensitive throughout — hex casing is not a refusal", () => {
  const v = checkSeriesOnChainBinding({
    claimedOnChainEventId: OURS,
    recordedOnChainEventId: OURS,
    seriesManifestRef: OURS.toUpperCase().replace("0X", "0x"),
    blobManifestDigest: OURS,
    onChainManifestRef: OURS.toUpperCase().replace("0X", "0x"),
  });
  assert.deepEqual(v, { ok: true, checked: true });
});
