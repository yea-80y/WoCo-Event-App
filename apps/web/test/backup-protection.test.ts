/**
 * Semantics lock for the "is this account protected?" decision (#148, #138/#169).
 *
 * This matrix exists because the first cut of it shipped a lie: with the chain
 * unreadable and no server hint document, `!!status?.configured` collapsed to a
 * confident `false`, and the recovery portal renders `false` as
 *
 *   "No backup found for that account … recovery isn't possible for this account."
 *
 * — to a user who is locked out and protected. A platform-signed hint CANNOT prove
 * absence: the hint write at setup is explicitly non-fatal, the server reads it
 * through a lenient feed read that turns a transient bee error into the same null
 * as a real absence, and the platform can withhold it at will.
 *
 * So: only a CHAIN read may ever produce `isProtected: false`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideProtection } from "../src/lib/auth/backup-management.js";

test("chain is believed in both directions", () => {
  assert.deepEqual(decideProtection("installed", null), {
    isProtected: true, source: "chain", routeState: "installed",
  });
  assert.deepEqual(decideProtection("absent", null), {
    isProtected: false, source: "chain", routeState: "absent",
  });
});

test("the chain wins even when the hint disagrees", () => {
  // A stale `configured:true` hint after a removal must not resurrect the claim.
  assert.equal(decideProtection("absent", { configured: true }).isProtected, false);
  // And a missing hint must not weaken a route we can actually see.
  assert.equal(decideProtection("installed", null).isProtected, true);
});

test("an unreadable chain + no hint document is UNKNOWN, never 'not protected'", () => {
  const r = decideProtection("unknown", null);
  assert.equal(r.isProtected, null, "this is the portal's 'recovery isn't possible' lie");
  assert.equal(r.source, "none");
});

test("an unreadable chain + unreadable hint is UNKNOWN", () => {
  assert.equal(decideProtection("unknown", "unreadable").isProtected, null);
});

test("a hint may attest presence when the chain is unreadable", () => {
  const r = decideProtection("unknown", { configured: true });
  assert.equal(r.isProtected, true);
  assert.equal(r.source, "hint", "callers must be able to qualify a hint-sourced claim");
});

test("a hint saying NOT configured is still only UNKNOWN", () => {
  // The doc is real but forgeable, withholdable and possibly stale — and the cost
  // of believing it is telling a locked-out user recovery is impossible.
  const r = decideProtection("unknown", { configured: false });
  assert.equal(r.isProtected, null);
  assert.equal(r.source, "none");
});

test("no hint outcome can ever yield a definite false", () => {
  const hints = [null, "unreadable" as const, { configured: true }, { configured: false }];
  for (const hint of hints) {
    assert.notEqual(
      decideProtection("unknown", hint).isProtected,
      false,
      `hint ${JSON.stringify(hint)} must not prove absence`,
    );
  }
});
