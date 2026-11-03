/**
 * Allocated seating, server side of S2 (docs/SEATING.md): whether a series is seated
 * is decided by its manifest and recorded on its registration, where the mint path
 * reads it. Pinned here: the verdicts, the plan read (digest-checked), the record's
 * shape and its replay rules (seating fixed at registration), and that register-once
 * carries seating on every path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed, PaymentConfig } from "@woco/shared";
import {
  LAYOUT_TEMPLATES, encodeSeatPlan, freezeSeatPlan, seatPlanDigest, seatPlanEditionTemplate,
} from "@woco/shared/seating/index";
import { checkSeatedSeries } from "../src/lib/seating/seated-series.js";
import { loadSeatPlan, SeatPlanUnavailableError } from "../src/lib/seating/plan-store.js";
import { registerSeriesExactlyOnce, type RegisterDeps, type RegisterParams } from "../src/lib/event/register-once.js";

process.env.WOCO_EVENT_CHAIN_ID ??= "421614";

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "cabaret")!.make());
const bytes = encodeSeatPlan(plan);
const digest = seatPlanDigest(bytes);
const REF = "ab".repeat(32);
const SEATS = plan.seats.length;
const template = seatPlanEditionTemplate({ ref: REF, digest, seats: SEATS });
const payment = { price: "22.00", currency: "GBP", stripeEnabled: true } as PaymentConfig;
const seating = { bands: [{ id: plan.bands[0].id, price: "28.00" }, { id: plan.bands[1].id, price: "22.00" }] };

const seatedSeries = (over: Record<string, unknown> = {}) => ({
  totalSupply: SEATS,
  manifestBody: { totalSupply: SEATS, editionTemplate: template },
  seating,
  payment,
  ...over,
});
const deps = (over: Partial<Parameters<typeof checkSeatedSeries>[1]> = {}) => ({
  loadSeatPlan: (async () => plan) as typeof loadSeatPlan,
  seatedAllowed: true,
  ...over,
});

// ── Verdicts ────────────────────────────────────────────────────────────────

test("seated: the manifest names a plan that loads, matches and carries every band's price", async () => {
  const v = await checkSeatedSeries(seatedSeries(), deps());
  assert.equal(v.kind, "seated");
  assert.equal(v.kind === "seated" && v.template.digest, digest);
});

test("general admission: no plan, no seat prices", async () => {
  assert.deepEqual(await checkSeatedSeries({ totalSupply: 5, manifestBody: { totalSupply: 5 }, payment }, deps()), { kind: "general" });
});

test("every inconsistency refuses", async () => {
  const no = async (s: ReturnType<typeof seatedSeries> | Record<string, unknown>, d = deps()) => {
    const v = await checkSeatedSeries(s as never, d);
    assert.equal(v.kind, "refused", JSON.stringify(s).slice(0, 80));
    return v.kind === "refused" ? v.status : 0;
  };
  assert.equal(await no({ totalSupply: 5, manifestBody: { totalSupply: 5 }, seating, payment }), 400, "prices without a plan");
  assert.equal(await no(seatedSeries({ manifestBody: { totalSupply: SEATS, editionTemplate: { seatPlan: { ref: REF } } } })), 400, "malformed template");
  assert.equal(await no(seatedSeries(), deps({ seatedAllowed: false })), 400, "flag off");
  assert.equal(await no(seatedSeries({ totalSupply: SEATS + 1 })), 400, "supply is not the seat count");
  assert.equal(await no(seatedSeries({ payment: { ...payment, stripeEnabled: false } })), 400, "not card");
  assert.equal(await no(seatedSeries({ seating: undefined })), 400, "plan without prices");
  assert.equal(await no(seatedSeries({ seating: { bands: [seating.bands[0]] } })), 400, "a band unpriced");
  assert.equal(await no(seatedSeries({ payment: { ...payment, price: "28.00" } })), 400, "headline is not the lowest band");
  assert.equal(await no(seatedSeries(), deps({ loadSeatPlan: (async () => null) as typeof loadSeatPlan })), 400, "plan does not match");
  const unreadable = deps({ loadSeatPlan: (async () => { throw new SeatPlanUnavailableError(REF, new Error("down")); }) as typeof loadSeatPlan });
  assert.equal(await no(seatedSeries(), unreadable), 503, "plan unreadable");
});

// ── Plan read ───────────────────────────────────────────────────────────────

test("a plan loads only when its bytes hash to the digest; a failed read is unavailable, not absent", async () => {
  const text = new TextDecoder().decode(bytes);
  let reads = 0;
  const loaded = await loadSeatPlan(REF, digest, async () => { reads++; return text; });
  assert.deepEqual(loaded, plan);
  // Content-addressed: the second read of the same digest is memoised.
  await loadSeatPlan(REF, digest, async () => { reads++; return text; });
  assert.equal(reads, 1);
  const other = `0x${"12".repeat(32)}`;
  assert.equal(await loadSeatPlan(REF, other, async () => text), null);
  await assert.rejects(loadSeatPlan(REF, `0x${"34".repeat(32)}`, async () => { throw new Error("404"); }), SeatPlanUnavailableError);
});

// ── register-once carries seating ───────────────────────────────────────────

const PARAMS: RegisterParams = {
  eventId: "evt-s", seriesId: "ser-s", supply: SEATS, manifestRef: "0xabc",
  v2Params: { organiser: "0xc", eventEndTs: 9_999_999_999, priceBaseUnits: 0n, payoutRecipient: "0xc", dropGate: "0x0", organiserKey: "0xk" },
  seating: { planDigest: digest },
};

function harness(over: Partial<RegisterDeps> = {}) {
  const seen: { seated?: boolean; confirms: unknown[] } = { confirms: [] };
  const d: RegisterDeps = {
    lookupOnChainEventId: () => null,
    lookupPending: () => null,
    recordPending: () => {},
    recordIntent: () => {},
    clearPending: () => {},
    resolveRegisterTx: (async () => ({ status: "registered", onChainEventId: "0xid", txHash: "0xtx" })) as never,
    resolveIntent: (async () => ({ status: "registered", onChainEventId: "0xid" })) as never,
    registerEventOnChain: (async (_s, _r, v2) => {
      seen.seated = v2?.seated;
      return { onChainEventId: "0xid", txHash: "0xtx", contract: { chainId: 42161, address: "0x1", version: "ledger2" } };
    }) as RegisterDeps["registerEventOnChain"],
    confirmSeriesOnChain: (async (...args: unknown[]) => {
      seen.confirms.push(args[5]);
      return { feed: {} as EventFeed, resignable: false };
    }) as RegisterDeps["confirmSeriesOnChain"],
    ...over,
  };
  return { d, seen };
}

test("a seated registration registers seated and records the plan, on every path", async () => {
  const fresh = harness();
  await registerSeriesExactlyOnce(PARAMS, fresh.d);
  assert.equal(fresh.seen.seated, true);
  assert.deepEqual(fresh.seen.confirms, [{ planDigest: digest }]);

  const recorded = harness({ lookupOnChainEventId: () => "0xid" });
  await registerSeriesExactlyOnce(PARAMS, recorded.d);
  assert.deepEqual(recorded.seen.confirms, [{ planDigest: digest }], "replay of a recorded registration");

  const fromTx = harness({ lookupPending: () => ({ txHash: "0xtx", nonce: 1, chainId: 42161, at: "x" }) as never });
  await registerSeriesExactlyOnce(PARAMS, fromTx.d);
  assert.deepEqual(fromTx.seen.confirms, [{ planDigest: digest }], "recovered from a sent tx");

  const fromIntent = harness({ lookupPending: () => ({ nonce: 1, chainId: 42161, at: "x" }) as never });
  await registerSeriesExactlyOnce(PARAMS, fromIntent.d);
  assert.deepEqual(fromIntent.seen.confirms, [{ planDigest: digest }], "recovered from an intent marker");

  const general = harness();
  await registerSeriesExactlyOnce({ ...PARAMS, seriesId: "ser-g", seating: undefined }, general.d);
  assert.equal(general.seen.seated, undefined);
  assert.deepEqual(general.seen.confirms, [undefined]);
});
