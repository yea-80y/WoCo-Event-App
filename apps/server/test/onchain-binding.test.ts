/**
 * #424 tier 2 — binding a series to the on-chain event it claims.
 *
 * The property: a series may only be sold against an on-chain event that
 * belongs to it.
 *
 * The first version of this check compared the chain's `manifestRef` against
 * `series.manifestRef`. Both are creator-supplied in the forged case, so an
 * attacker who set BOTH consistently walked straight through — it cost them one
 * extra forged field and nothing else. The anchor now is the digest recomputed
 * from the manifest BLOB, which is content-addressed and signed, so it cannot be
 * made to match an event the creator did not register.
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
    seriesManifestRef: OURS,
    blobManifestDigest: OURS,
    onChainManifestRef: OURS,
  });
  assert.deepEqual(v, { ok: true, checked: true });
});

test("THE REGRESSION: forging both feed fields no longer passes", () => {
  // The attacker points at the victim's event AND declares the victim's digest,
  // which defeated the previous version of this check. Their manifest blob still
  // digests to their own manifest, and that is what is compared now.
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: THEIRS,   // forged to match the victim
    blobManifestDigest: OURS,    // but their actual manifest is their own
    onChainManifestRef: THEIRS,  // the victim's event
  });
  assert.equal(v.ok, false, "forging both feed fields still bound the series");
  assert.equal(v.ok === false && v.reason, "manifest-mismatch");
});

test("a series pointed at another event's manifest is REFUSED", () => {
  const v = checkSeriesOnChainBinding({
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
    seriesManifestRef: THEIRS,
    blobManifestDigest: null,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false, "an unfetchable manifest was treated as verified");
  assert.equal(v.ok === false && v.reason, "manifest-unresolvable");
});

test("an ABSENT series manifestRef is refused, not skipped", () => {
  const v = checkSeriesOnChainBinding({
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
    seriesManifestRef: undefined,
    blobManifestDigest: null,
    onChainManifestRef: null,
  });
  assert.deepEqual(v, { ok: true, checked: false });
});

test("comparison is case-insensitive throughout — hex casing is not a refusal", () => {
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: OURS.toUpperCase().replace("0X", "0x"),
    blobManifestDigest: OURS,
    onChainManifestRef: OURS.toUpperCase().replace("0X", "0x"),
  });
  assert.deepEqual(v, { ok: true, checked: true });
});
