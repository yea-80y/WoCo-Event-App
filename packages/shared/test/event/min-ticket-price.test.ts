/**
 * The minimum ticket price. Below it a card sale either loses most of its price
 * to Stripe's per-card fee or, under 34p, carries no platform fee and is refused
 * at checkout (#645) - so an organiser must not be able to publish one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_TICKET_PRICE, ticketPriceMeetsMinimum } from "../../src/features.js";

test("the minimum is one unit of the currency, inclusive", () => {
  assert.equal(MIN_TICKET_PRICE, 1);
  for (const ok of ["1", "1.00", " 1.5 ", "10"]) assert.equal(ticketPriceMeetsMinimum(ok), true, ok);
  for (const no of ["0.99", "0.30", "0", "", "abc", undefined, "-5"]) {
    assert.equal(ticketPriceMeetsMinimum(no), false, String(no));
  }
});

test("publish, the editor and the server all apply it", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
  assert.match(read("../../../../apps/server/src/routes/events.ts"), /!ticketPriceMeetsMinimum\(s\.payment\.price\)/);
  assert.match(read("../../../../apps/web/src/lib/creator/events/PublishButton.svelte"), /ticketPriceMeetsMinimum\(s\.payment\.price\)/);
  assert.match(read("../../../../apps/web/src/lib/creator/events/TicketSeriesEditor.svelte"), /!ticketPriceMeetsMinimum\(tier\.price\)/);
});
