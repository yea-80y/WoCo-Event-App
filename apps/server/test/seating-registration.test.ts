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
  LAYOUT_TEMPLATES, MAX_SEAT_PLAN_BYTES, encodeSeatPlan, freezeSeatPlan, seatPlanDigest, seatPlanEditionTemplate,
  type SeatLayout,
} from "@woco/shared/seating/index";
import { checkSeatedSeries } from "../src/lib/seating/seated-series.js";
import { loadSeatPlan, SeatPlanTooLargeError, SeatPlanUnavailableError, storeSeatPlan } from "../src/lib/seating/plan-store.js";
import { registerSeriesExactlyOnce, type RegisterDeps, type RegisterParams } from "../src/lib/event/register-once.js";
import { registeredIdFromLogs } from "../src/lib/chain/event-contract-ledger.js";
import { Interface } from "ethers";

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

test("a valid plan whose bytes exceed the read cap is refused before anything is stored", { timeout: 120_000 }, async () => {
  // 200 blocks x 40 rows x 25 seats with 12-character row labels, six-digit numbers and a 24-character
  // band id (all allowed): valid, but ~80 bytes a seat.
  const band = "band-aaaaaaaaaaaaaaaaaaa";
  const items: SeatLayout["items"] = [];
  for (let b = 0; b < 200; b++) {
    items.push({
      id: `r${b}`, kind: "rows", name: `Block ${b + 1}`, x: (b % 20) * 700, y: Math.floor(b / 20) * 1000, rot: 0, curve: 0,
      numberFrom: "left", numberStart: 100_000,
      rows: Array.from({ length: 40 }, (_, r) => ({ label: `Row-label-${String(r).padStart(2, "0")}`, seats: Array.from({ length: 25 }, () => ({ b: band })) })),
    });
  }
  const big = freezeSeatPlan({ format: "woco.seatlayout.v1", name: "Big", bands: [{ id: band, name: "All", style: 0 }], items });
  assert.ok(encodeSeatPlan(big).length > MAX_SEAT_PLAN_BYTES, "the fixture is over the cap");
  await assert.rejects(storeSeatPlan(big, { batchId: "00", target: "wocoBee" }, "0x" + "aa".repeat(20)), SeatPlanTooLargeError);
});

test("a registration receipt counts only the ledger's own logs, and a seated one must say Seated", () => {
  const iface = new Interface([
    "event Registered(bytes32 indexed eventId, address indexed organiser, address indexed registrant, uint64 supply, bytes32 manifestRef, uint64 eventEndTs)",
    "event Seated(bytes32 indexed eventId)",
  ]);
  const LEDGER = "0x" + "2e".repeat(20), OTHER = "0x" + "99".repeat(20);
  const id = "0x" + "ab".repeat(32), other = "0x" + "cd".repeat(32);
  const log = (address: string, name: "Registered" | "Seated", eventId: string) => {
    const args = name === "Registered" ? [eventId, "0x" + "01".repeat(20), "0x" + "02".repeat(20), 5, "0x" + "03".repeat(32), 9] : [eventId];
    const e = iface.encodeEventLog(name, args);
    return { address, topics: e.topics, data: e.data };
  };
  assert.equal(registeredIdFromLogs([log(LEDGER, "Registered", id)], LEDGER, false), id);
  assert.equal(registeredIdFromLogs([log(LEDGER, "Registered", id), log(LEDGER, "Seated", id)], LEDGER.toUpperCase().replace("0X", "0x"), true), id);
  assert.throws(() => registeredIdFromLogs([log(OTHER, "Registered", other), log(LEDGER, "Registered", id)].slice(0, 1), LEDGER, false), /Registered event not found/, "another contract's log");
  assert.equal(registeredIdFromLogs([log(OTHER, "Registered", other), log(LEDGER, "Registered", id)], LEDGER, false), id, "skips the foreign one");
  assert.throws(() => registeredIdFromLogs([log(LEDGER, "Registered", id)], LEDGER, true), /Seated event not found/);
  assert.throws(() => registeredIdFromLogs([log(LEDGER, "Registered", id), log(LEDGER, "Seated", other)], LEDGER, true), /Seated event not found/, "Seated for another id");
  assert.throws(() => registeredIdFromLogs([log(LEDGER, "Registered", id), log(OTHER, "Seated", id)], LEDGER, true), /Seated event not found/, "Seated from another contract");
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
    // Every recovery below is of a seated series, and the chain agrees unless a test says not.
    isSeatedOnChain: async () => true,
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

test("a recovered registration the chain disagrees about is not recorded (S1+S2 sign-off, carried to S4)", async () => {
  const sent = { txHash: "0xtx", nonce: 1, chainId: 42161, at: "x" };
  const intent = { nonce: 1, chainId: 42161, at: "x" };
  for (const [why, marker, seating, chainSeated] of [
    ["seated series, general event, from a tx", sent, PARAMS.seating, false],
    ["seated series, general event, from an intent", intent, PARAMS.seating, false],
    ["general series, seated event, from a tx", sent, undefined, true],
  ] as const) {
    const h = harness({ lookupPending: () => marker as never, isSeatedOnChain: async () => chainSeated });
    await assert.rejects(registerSeriesExactlyOnce({ ...PARAMS, seriesId: `ser-${why.length}`, seating }, h.d), /not recorded, marker kept/, why);
    assert.deepEqual(h.seen.confirms, [], why);
  }
  const unreadable = harness({ lookupPending: () => sent as never, isSeatedOnChain: async () => { throw new Error("rpc down"); } });
  await assert.rejects(registerSeriesExactlyOnce({ ...PARAMS, seriesId: "ser-x" }, unreadable.d), /rpc down/);
  assert.deepEqual(unreadable.seen.confirms, [], "an unread chain records nothing");
});
