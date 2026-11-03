import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesSeatingRefusal, bandPricesMinor } from "../../src/seating/series.js";
import { editionBodiesFromCommon, editionBody, MAX_EDITIONS_PER_EVENT } from "../../src/edition/common.js";
import { buildEditionTree } from "../../src/edition/merkle.js";

const plan = { bands: [{ id: "b1", name: "Front", style: 0 }, { id: "b2", name: "Back", style: 1 }] };
const ok = { bands: [{ id: "b1", price: "28.50" }, { id: "b2", price: "22" }] };

test("band prices: one per plan band, each well formed and at least the minimum, headline = lowest", () => {
  assert.equal(seriesSeatingRefusal(ok, plan, { price: "22.00" }), null);
  assert.equal(seriesSeatingRefusal(ok, plan, { price: "22" }), null);
  const no = (seating: unknown, price = "22.00") => assert.notEqual(seriesSeatingRefusal(seating, plan, { price }), null, JSON.stringify(seating));
  no(ok, "28.50");
  no({ bands: [ok.bands[0]] });
  no({ bands: [...ok.bands, { id: "b3", price: "5" }] });
  no({ bands: [ok.bands[0], ok.bands[0], ok.bands[1]] });
  no({ bands: [{ id: "b1", price: "0.99" }, ok.bands[1]] }, "0.99");
  no({ bands: [{ id: "b1", price: "1e3" }, ok.bands[1]] });
  no({ bands: [{ id: "b1", price: "-5" }, ok.bands[1]] });
  no({ bands: [{ id: "b1", price: "12.345" }, ok.bands[1]] });
  no({ bands: [{ id: "b1", price: 28 }, ok.bands[1]] });
  no({ bands: [{ id: "b1", price: "28", x: 1 }, ok.bands[1]] });
  no({ bands: ok.bands, extra: 1 });
  no(undefined);
  assert.notEqual(seriesSeatingRefusal(ok, plan, undefined), null, "no payment");
  assert.deepEqual([...bandPricesMinor(ok)], [["b1", 2850], ["b2", 2200]]);
});

const common = {
  format: "woco.edition.v1" as const,
  seriesId: "series-0001",
  metadata: { name: "Stalls", description: "", mintedAt: "2026-11-03T12:00:00.000Z" },
  issuer: `0x${"11".repeat(20)}`,
};

test("compact editions rebuild exactly the bodies a client would list", () => {
  const listed = Array.from({ length: 5 }, (_, i) => ({ ...common, edition: i + 1 }));
  const rebuilt = editionBodiesFromCommon(common, 5)!;
  assert.deepEqual(rebuilt, listed);
  assert.equal(buildEditionTree(rebuilt).root, buildEditionTree(listed).root, "same Merkle root");
  assert.deepEqual(editionBody(common, 3), listed[2]);
});

test("compact editions refuse anything but an edition body without its number", () => {
  assert.equal(editionBodiesFromCommon({ ...common, edition: 1 }, 5), null, "carries a number");
  assert.equal(editionBodiesFromCommon({ ...common, extra: 1 }, 5), null);
  assert.equal(editionBodiesFromCommon({ ...common, format: "woco.ticket.v2" }, 5), null);
  assert.equal(editionBodiesFromCommon({ ...common, metadata: { price: 1.5 } }, 5), null, "a float");
  assert.equal(editionBodiesFromCommon(common, 0), null);
  assert.equal(editionBodiesFromCommon(common, 1.5), null);
  assert.equal(editionBodiesFromCommon(common, MAX_EDITIONS_PER_EVENT + 1), null, "past the per-event ceiling");
  assert.equal(editionBodiesFromCommon(null, 5), null);
});
