/**
 * The seated route's draft becomes exactly the ticket type the server accepts
 * (seriesSeatingRefusal): one price per plan band, headline = lowest, one ticket per seat.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { seriesSeatingRefusal } from "@woco/shared/seating/series";
import { newSeatedDraft, normalisePrice, publishableSeries, seatedDraftProblems, seatedSeries } from "../src/lib/creator/seating/seated-draft.js";

const theatre = () => {
  const d = newSeatedDraft("GBP");
  d.layout = LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make();
  return d;
};

test("a complete draft is the seated ticket type the server accepts", () => {
  const d = theatre();
  d.prices = { b1: "30", b2: "24.5", b3: "18" };
  assert.deepEqual(seatedDraftProblems(d), []);
  const s = seatedSeries(d)!;
  assert.equal(s.totalSupply, 394);
  assert.equal(s.payment.price, "18.00");
  assert.equal(s.payment.stripeEnabled, true);
  assert.equal(s.payment.cryptoEnabled, false);
  assert.deepEqual(s.seating.bands, [{ id: "b1", price: "30.00" }, { id: "b2", price: "24.50" }, { id: "b3", price: "18.00" }]);
  assert.equal(seriesSeatingRefusal({ bands: s.seating.bands }, s.seating.plan, s.payment), null);
  assert.match(s.seriesId, /^[a-z0-9-]{8,64}$/);
});

test("unpriced or too-cheap bands, no plan, no name: not publishable, said in plain words", () => {
  const d = theatre();
  d.prices = { b1: "30", b2: "0.50" };
  const p = seatedDraftProblems(d);
  assert.ok(p.some((x) => /^Rear stalls: set a price of at least 1\.00/.test(x)));
  assert.ok(p.some((x) => /^Circle: set a price/.test(x)));
  assert.equal(seatedSeries(d), null);
  assert.deepEqual(seatedDraftProblems(newSeatedDraft("GBP")), ["Choose a seating plan."]);
  const n = theatre();
  n.prices = { b1: "30", b2: "24", b3: "18" };
  n.name = "  ";
  assert.deepEqual(seatedDraftProblems(n), ["Give the seats a name for the tickets."]);
});

test("a band no seat uses needs no price and is not published", () => {
  const d = theatre();
  d.layout!.bands.push({ id: "b9", name: "Unused", style: 5 });
  d.prices = { b1: "30", b2: "24", b3: "18" };
  assert.deepEqual(seatedDraftProblems(d), []);
  assert.deepEqual(seatedSeries(d)!.seating.bands.map((b) => b.id), ["b1", "b2", "b3"]);
});

test("the publish list follows the route; standing tickets ride along only when asked", () => {
  const ga = [{ seriesId: "ga-000000001" }];
  const d = theatre();
  d.prices = { b1: "30", b2: "24", b3: "18" };
  assert.deepEqual(publishableSeries("general", d, true, ga), ga);
  assert.deepEqual(publishableSeries("seated", d, false, ga).map((s) => s.seriesId), [d.seriesId]);
  assert.deepEqual(publishableSeries("seated", d, true, ga).map((s) => s.seriesId), [d.seriesId, "ga-000000001"]);
  assert.deepEqual(publishableSeries("seated", newSeatedDraft("GBP"), true, ga), ga, "an unfinished plan publishes nothing seated");
});

test("prices have one spelling", () => {
  assert.equal(normalisePrice("12"), "12.00");
  assert.equal(normalisePrice(" 12.5 "), "12.50");
  assert.equal(normalisePrice("abc"), "");
});
