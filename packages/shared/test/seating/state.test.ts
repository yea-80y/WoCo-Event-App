import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifestV2Body } from "../../src/edition/types.js";
import { seatPlanEditionTemplate, seatPlanTemplateOf } from "../../src/seating/template.js";
import {
  buildSeatState, decodeHeld, encodeHeld, organiserAllowsSale, seatStateView, validateSeatState,
} from "../../src/seating/state.js";
import { freezeSeatPlan, seatPlanDigest, encodeSeatPlan } from "../../src/seating/plan.js";
import { LAYOUT_TEMPLATES } from "../../src/seating/templates.js";
import { isJsonSafeStatementValue } from "../../src/statement/discipline.js";

const REF = "ab".repeat(32);
const DIGEST = `0x${"cd".repeat(32)}`;

// ── Manifest link ───────────────────────────────────────────────────────────

test("a seated manifest names its plan exactly, and its seats are the supply", () => {
  const editionTemplate = seatPlanEditionTemplate({ ref: REF, digest: DIGEST, seats: 120 });
  assert.deepEqual(seatPlanTemplateOf({ totalSupply: 120, editionTemplate }), { ref: REF, digest: DIGEST, seats: 120 });
  assert.equal(seatPlanTemplateOf({ totalSupply: 121, editionTemplate }), "invalid");
  const body = {
    format: "woco.manifest.v2", totalSupply: 120, issuer: `0x${"11".repeat(20)}`, metadataRoot: `0x${"22".repeat(32)}`,
    encoding: "cbor-v1", treeScheme: "oz-simple-v1", editionTemplate,
  };
  assert.ok(validateManifestV2Body(body), "the manifest format accepts it");
});

test("general admission has no plan; a malformed one is never read as general admission", () => {
  assert.equal(seatPlanTemplateOf({ totalSupply: 5 }), null);
  assert.equal(seatPlanTemplateOf({ totalSupply: 5, editionTemplate: { other: 1 } }), null);
  const t = (seatPlan: unknown, extra: Record<string, unknown> = {}) =>
    seatPlanTemplateOf({ totalSupply: 5, editionTemplate: { seatPlan, ...extra } as Record<string, unknown> });
  assert.equal(t({ ref: REF, digest: DIGEST, seats: 5 }, { other: 1 }), "invalid");
  assert.equal(t({ ref: `0x${REF}`, digest: DIGEST, seats: 5 }), "invalid");
  assert.equal(t({ ref: REF, digest: DIGEST.toUpperCase(), seats: 5 }), "invalid");
  assert.equal(t({ ref: REF, digest: DIGEST, seats: 5, x: 1 }), "invalid");
  assert.equal(t({ ref: REF, digest: DIGEST }), "invalid");
  assert.equal(t(null), "invalid");
  assert.throws(() => seatPlanEditionTemplate({ ref: REF, digest: DIGEST, seats: 0 }));
});

// ── Held bitmap ─────────────────────────────────────────────────────────────

test("held bitmap: seat k is byte k>>3, bit k&7, low bit first", () => {
  assert.equal(encodeHeld([0, 9], 10), "0102");
  assert.deepEqual([...decodeHeld("0102", 10)], [0, 9]);
  assert.equal(encodeHeld([], 1), "00");
  assert.throws(() => encodeHeld([10], 10));
});

function state(over: Record<string, unknown> = {}) {
  return { format: "woco.seatstate.v1", planDigest: DIGEST, seats: 10, held: "0102", confirmed: [[3, 1], [7, 2]], seq: 4, updatedAt: "2026-11-03T12:00:00.000Z", ...over };
}

test("seat state validation", () => {
  assert.ok(validateSeatState(state()));
  assert.ok(isJsonSafeStatementValue(state()));
  assert.ok(validateSeatState(state(), { planDigest: DIGEST, seats: 10 }));
  assert.equal(validateSeatState(state(), { planDigest: DIGEST, seats: 11 }), false, "other plan");
  assert.equal(validateSeatState(state({ held: "0106" })), false, "bit past the last seat");
  assert.equal(validateSeatState(state({ held: "01" })), false, "short");
  assert.equal(validateSeatState(state({ held: "0A02" })), false, "uppercase");
  assert.equal(validateSeatState(state({ confirmed: [[7, 2], [3, 1]] })), false, "unsorted");
  assert.equal(validateSeatState(state({ confirmed: [[3, 1], [3, 2]] })), false, "repeat");
  assert.equal(validateSeatState(state({ confirmed: [[3, 0]] })), false, "nonce 0");
  assert.equal(validateSeatState(state({ confirmed: [[10, 1]] })), false, "seat out of range");
  assert.equal(validateSeatState(state({ confirmed: [[3, 1, 0]] })), false, "triple");
  assert.equal(validateSeatState(state({ seq: -1 })), false);
  assert.equal(validateSeatState(state({ updatedAt: "yesterday" })), false);
  assert.equal(validateSeatState(state({ extra: true })), false);
});

test("buildSeatState sorts confirmations and drops nonce 0", () => {
  const s = buildSeatState({
    planDigest: DIGEST.toUpperCase().replace("0X", "0x"), seats: 10, held: [9, 0],
    confirmed: new Map([[7, 2], [3, 1], [5, 0]]), seq: 1, updatedAt: "2026-11-03T12:00:00.000Z",
  });
  assert.deepEqual(s.confirmed, [[3, 1], [7, 2]]);
  assert.equal(s.held, "0102");
  assert.equal(s.planDigest, DIGEST);
});

// ── Selling rule ────────────────────────────────────────────────────────────

test("a freed seat sells only once the organiser confirms that exact nonce", () => {
  const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "gala")!.make());
  const digest = seatPlanDigest(encodeSeatPlan(plan));
  // No state yet: the plan's own held flags (the gala's top table, seats 0..11).
  const initial = seatStateView(plan, digest, null);
  assert.equal(initial.held.size, 12);
  assert.equal(organiserAllowsSale(initial, 0, 0), false, "held");
  assert.equal(organiserAllowsSale(initial, 12, 0n), true, "never freed");
  assert.equal(organiserAllowsSale(initial, 12, 1n), false, "freed, not confirmed");

  const s = buildSeatState({ planDigest: digest, seats: plan.seats.length, held: [], confirmed: new Map([[12, 2]]), seq: 1, updatedAt: "2026-11-03T12:00:00Z" });
  const view = seatStateView(plan, digest, s);
  assert.equal(organiserAllowsSale(view, 0, 0), true, "released");
  assert.equal(organiserAllowsSale(view, 12, 2), true, "confirmed at 2");
  assert.equal(organiserAllowsSale(view, 12, 3n), false, "freed again since");
  assert.equal(organiserAllowsSale(view, 12, 1), false, "older nonce");

  // A state written for another plan is ignored, not trusted.
  const other = seatStateView(plan, `0x${"00".repeat(32)}`, s);
  assert.equal(other.held.size, 12);
  assert.equal(other.confirmed.size, 0);
});
