/**
 * #424 tier 2 — binding a series to the on-chain event it claims.
 *
 * The property: a series may only be sold against an on-chain event that
 * belongs to it. `series.onChainEventId` arrives from the creator's own
 * client-signed feed, so it is untrusted; `manifestRef` is stamped on chain at
 * registration and cannot be edited, so it is the anchor.
 *
 * The case that matters most here is the ABSENT series digest. `manifestRef` is
 * optional in the schema and the checkout's registration gate requires
 * `swarmManifestRef` instead — so an implementation that treats "absent" as
 * "nothing to check" is bypassed by omitting one field, which costs an attacker
 * less than forging it. That exact hole existed in the first version of this
 * fix and is pinned below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSeriesOnChainBinding } from "../src/lib/event/onchain-binding.js";

const OURS   = `0x${"c3".repeat(32)}`;
const THEIRS = `0x${"d4".repeat(32)}`;

test("matching digests bind, and the verdict records that a check happened", () => {
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: OURS,
    onChainManifestRef: OURS,
  });
  assert.deepEqual(v, { ok: true, checked: true });
});

test("a series pointed at another event's manifestRef is REFUSED", () => {
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: OURS,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "manifest-mismatch");
});

test("an ABSENT series manifestRef is refused, not skipped", () => {
  // The bypass: omit the optional field and the whole binding disappears.
  // Cheaper for an attacker than forging it, so absence must be disqualifying.
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: undefined,
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false, "omitting manifestRef skipped the binding check");
  assert.equal(v.ok === false && v.reason, "no-manifest-ref");
});

test("an empty-string manifestRef is treated as absent, not as a match", () => {
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: "",
    onChainManifestRef: THEIRS,
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "no-manifest-ref");
});

test("no chain value — passes UNCHECKED so a flaky RPC cannot stop every sale", () => {
  // Fails open deliberately: this is a transient network condition, not a
  // property of the series. `checked: false` lets the caller tell the two apart.
  for (const onChainManifestRef of [null, undefined]) {
    const v = checkSeriesOnChainBinding({ seriesManifestRef: OURS, onChainManifestRef });
    assert.deepEqual(v, { ok: true, checked: false });
  }
});

test("no chain value AND no series digest still passes — nothing to judge", () => {
  // The refusal must be caused by a contradiction with the chain, never by the
  // absence of information. Otherwise a chain outage would refuse every sale.
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: undefined,
    onChainManifestRef: null,
  });
  assert.deepEqual(v, { ok: true, checked: false });
});

test("comparison is case-insensitive — hex casing is not a refusal", () => {
  const v = checkSeriesOnChainBinding({
    seriesManifestRef: OURS.toUpperCase().replace("0X", "0x"),
    onChainManifestRef: OURS,
  });
  assert.equal(v.ok, true);
});
