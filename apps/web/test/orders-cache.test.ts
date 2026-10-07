/**
 * #546: an erased attendee's details must not outlive the erasure in the
 * organiser's browser. The cached orders never carry the sealed blob.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withoutSealedOrders } from "../src/lib/api/orders-cache.js";

test("the cached copy keeps every row and drops only the sealed blob", () => {
  const data = {
    eventId: "e1",
    orders: [
      { edition: 1, claimerAddress: "0xabc", encryptedOrder: { sealed: "ciphertext" } },
      { edition: 2, claimerAddress: "0xdef", erased: true },
    ],
  } as never;
  const out = withoutSealedOrders(data) as unknown as { eventId: string; orders: Record<string, unknown>[] };
  assert.equal(out.eventId, "e1");
  assert.equal(out.orders.length, 2);
  assert.equal("encryptedOrder" in out.orders[0], false);
  assert.equal(out.orders[0].claimerAddress, "0xabc");
  assert.equal(out.orders[1].erased, true);
});

test("the orders cache strips on read AND write, so an older cached blob is never decrypted", () => {
  const src = readFileSync(new URL("../src/lib/api/creator-cache.ts", import.meta.url), "utf-8");
  const fn = src.slice(src.indexOf("export function getEventOrdersSWR"), src.indexOf("return { cached, refresh };", src.indexOf("export function getEventOrdersSWR")));
  assert.match(fn, /const cached = stored \? withoutSealedOrders\(stored\) : null/);
  assert.match(fn, /cacheSet\(key, withoutSealedOrders\(data\)/);
});
