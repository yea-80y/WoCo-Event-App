/**
 * #426 — a later duplicate `manifestRef` must not shadow the original.
 *
 * `registerEvent` is permissionless and takes whatever manifest digest it is
 * handed, and the contract does not enforce uniqueness — so two on-chain events
 * can carry the same `manifestRef`. The walk used a plain `set`, i.e.
 * last-writer-wins, so anyone registering a copy of an existing digest replaced
 * the original in this projection.
 *
 * `findOnChainEventIdByManifestRef` is the positive arm of the #318 intent
 * resolver, whose NEGATIVE answer triggers a re-broadcast, and the tier-3 fill
 * resolves ids through the same map. First-wins keeps the EARLIEST registration
 * — the one that actually landed, the answer the resolver wants, and the only
 * direction an attacker cannot choose (registering a copied digest after the
 * victim is free; getting in first means winning a crash-window race).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { indexWalkedRegistrations } from "../src/lib/event/onchain-registry.js";

const REF   = `0x${"c3".repeat(32)}`;
const REF_2 = `0x${"d4".repeat(32)}`;
const FIRST  = `0x${"a1".repeat(32)}`;
const SECOND = `0x${"b2".repeat(32)}`;

test("a manifestRef resolves to the registration that landed first", () => {
  const m = new Map<string, string>();
  // Ascending nonce order, exactly as the walk produces it.
  indexWalkedRegistrations(m, [
    { id: FIRST,  manifestRef: REF },
    { id: SECOND, manifestRef: REF },
  ]);
  assert.equal(m.get(REF.toLowerCase()), FIRST, "a later duplicate shadowed the original");
});

test("ANCHOR: a duplicate registered in a LATER walk still cannot displace it", () => {
  // The map is process-lifetime state, so the shadowing attempt can also arrive
  // as a separate walk after the original is already indexed.
  const m = new Map<string, string>();
  indexWalkedRegistrations(m, [{ id: FIRST, manifestRef: REF }]);
  indexWalkedRegistrations(m, [{ id: SECOND, manifestRef: REF }]);
  assert.equal(m.get(REF.toLowerCase()), FIRST);
});

test("re-walking the same registration is not a collision", () => {
  // The walk restarts from nonce 0 every time, so every entry is re-seen with
  // the SAME id. That must be silent, not reported as a duplicate.
  const m = new Map<string, string>();
  indexWalkedRegistrations(m, [{ id: FIRST, manifestRef: REF }]);
  indexWalkedRegistrations(m, [{ id: FIRST, manifestRef: REF }]);
  assert.equal(m.get(REF.toLowerCase()), FIRST);
  assert.equal(m.size, 1);
});

test("distinct manifestRefs are all indexed", () => {
  const m = new Map<string, string>();
  indexWalkedRegistrations(m, [
    { id: FIRST,  manifestRef: REF },
    { id: SECOND, manifestRef: REF_2 },
  ]);
  assert.equal(m.get(REF.toLowerCase()), FIRST);
  assert.equal(m.get(REF_2.toLowerCase()), SECOND);
});

test("registrations with no manifestRef are skipped, not indexed under a falsy key", () => {
  const m = new Map<string, string>();
  indexWalkedRegistrations(m, [
    { id: FIRST, manifestRef: null },
    { id: SECOND, manifestRef: undefined },
  ]);
  assert.equal(m.size, 0);
});

test("lookup is case-insensitive on the ref, as the walk stores it lowercased", () => {
  const m = new Map<string, string>();
  indexWalkedRegistrations(m, [{ id: FIRST, manifestRef: REF.toUpperCase() }]);
  assert.equal(m.get(REF.toLowerCase()), FIRST);
});
