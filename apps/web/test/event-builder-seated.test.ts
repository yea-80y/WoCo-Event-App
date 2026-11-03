/**
 * A seated ticket type's manifest signs its seating plan in (docs/SEATING.md), and the
 * compact edition body a seated create sends rebuilds exactly the bodies the manifest's
 * Merkle root commits to - the check the server runs on whatever it is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildEditionTree, editionBodiesFromCommon, validateSignedManifestV2 } from "@woco/shared";
import { seatPlanTemplateOf as templateOf } from "@woco/shared/seating/template";
import { buildEventManifests } from "../src/lib/object/event-builder.js";

const KEY = new Uint8Array(32).fill(7);
const PLAN = { ref: "ab".repeat(32), digest: `0x${"cd".repeat(32)}`, seats: 12 };
const build = (seatPlan?: typeof PLAN, totalSupply = 12) =>
  buildEventManifests({
    issuingPrivKey: KEY,
    eventMeta: { startDate: "2099-01-01T19:00:00.000Z" },
    series: [{ seriesId: "series-0001", name: "Seats", description: "", totalSupply, ...(seatPlan ? { seatPlan } : {}) }],
    mintedAt: "2026-11-03T12:00:00.000Z",
  })[0];

test("a seated manifest carries the plan, signed", () => {
  const m = build(PLAN);
  assert.ok(validateSignedManifestV2(m.signedManifest));
  assert.deepEqual(templateOf(m.signedManifest.body), PLAN);
});

test("general admission is unchanged: no template, same digest as before seating existed", () => {
  const ga = build();
  assert.equal(ga.signedManifest.body.editionTemplate, undefined);
  assert.notEqual(build(PLAN).manifestDigestHex, ga.manifestDigestHex, "the plan is inside the digest");
});

test("a seated ticket type sells exactly one ticket per seat", () => {
  assert.throws(() => build(PLAN, 13), /one ticket per seat/);
});

test("the compact body rebuilds the committed bodies", () => {
  const m = build(PLAN);
  const rebuilt = editionBodiesFromCommon(m.editionCommon, 12)!;
  assert.deepEqual(rebuilt, m.editionBodies);
  assert.equal(buildEditionTree(rebuilt).root, m.signedManifest.body.metadataRoot);
});
