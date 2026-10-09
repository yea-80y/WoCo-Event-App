/**
 * The buyer's side of #186: every box declares the key it was sealed to, and a box
 * sealed to a key the organiser has since replaced is re-sealed ONCE to the key the
 * server names (its bytes verified against that ref before use).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const CLAIM = read("../src/lib/attendee/events/ClaimButton.svelte");
const STRIPE = read("../src/lib/api/stripe.ts");
const PREFETCH = read("../src/lib/attendee/events/claim/useOrderPrefetch.svelte.ts");

test("a box declares the ref its key's bytes were verified against - never one still loading", () => {
  assert.match(CLAIM, /orderKey = key;\s*orderKeyFor = ref;/);
  assert.match(CLAIM, /encryptionKeyRef: orderKeyFor,/);
  assert.match(CLAIM, /getKeyRef: \(\) => orderKeyFor,/);
  assert.match(PREFETCH, /prepareStripeOrder\(sealed, \{ eventId: opts\.eventId, \.\.\.\(keyRef \? \{ encryptionKeyRef: keyRef \} : \{\}\) \}\)/);
  // A key change makes a prefetched box stale.
  assert.match(CLAIM, /\) \+ `\|\$\{orderKeyFor \?\? ""\}`;/);
});

test("a stale-key refusal re-seals once, to the key the server names", () => {
  const retry = CLAIM.slice(CLAIM.indexOf("if (err instanceof OrderKeyStaleError"));
  assert.match(retry, /err\.current && err\.current !== orderKeyFor && !staleRetried/);
  assert.match(retry, /const key = await loadOrderKey\(err\.current\);/, "verified against its ref");
  assert.ok(retry.indexOf("staleRetried = true;") < retry.indexOf("await handleStripeCheckout();"));
  assert.match(STRIPE, /if \(data\.code !== "ORDER_KEY_STALE"\) return null;/);
  assert.match(STRIPE, /\/\^\[0-9a-f\]\{64\}\$\/\.test\(data\.encryptionKeyRef\)/);
  assert.match(STRIPE, /\.\.\.\(params\.encryptedOrder && params\.encryptionKeyRef \? \{ encryptionKeyRef: params\.encryptionKeyRef \} : \{\}\),/);
});
