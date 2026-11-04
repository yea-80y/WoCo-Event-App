/**
 * The ledger2 relay core (`lib/event/ledger2-relay.ts`) and the cancel ordering
 * (`lib/event/cancel-on-chain.ts`), against a fake chain. What is pinned: only this
 * server's ledger2 registrations are acted on; the signed-in account must be the
 * organiser on chain; signatures are recovered locally against the nonces read; the
 * batch is built from typed fields, seat moves first and all-or-nothing; the first
 * simulated failure names the refusal; locks; landed-from-logs; the abort revokes; and
 * a cancel never records on a refused signature.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  LEDGER2_NO_SEAT,
  ledger2SignatureWindow,
  signLedger2Action,
  type Ledger2Action,
} from "@woco/shared/ticket/ledger2-terms";
import {
  _resetLedger2RelayLocksForTests,
  prepareLedger2Relay,
  submitLedger2Relay,
  type Ledger2RelayDeps,
  type PrepareInput,
  type RelayReceipt,
} from "../src/lib/event/ledger2-relay.js";
import { cancelEventWithChain } from "../src/lib/event/cancel-on-chain.js";
import { ledger2RelayIface, type RelayCall, type SeriesChainState, type SimulatedCall, type SlotChainState } from "../src/lib/chain/ledger2-relay-chain.js";

const CHAIN = 42161;
const LEDGER = "0x00000000000000000000000000000000000000aa";
const PARENT = "0x00000000000000000000000000000000000000b1";
const EVENT = "evt-1";
const SERIES = "series-a";
const SERIES_B = "series-b";
const ID_A = `0x${"0a".repeat(32)}`;
const ID_B = `0x${"0b".repeat(32)}`;
const NOW = 1_800_000_000;
const TARGET = { chainId: CHAIN, address: LEDGER };

const organiser = Wallet.createRandom();
const organiserPk = hexToBytes(organiser.privateKey.slice(2));
const holder = Wallet.createRandom();
const holderPk = hexToBytes(holder.privateKey.slice(2));
const W = ledger2SignatureWindow(NOW);

function sign(a: Ledger2Action, pk = organiserPk): string {
  return signLedger2Action(TARGET, a, pk);
}

interface Fake {
  deps: Ledger2RelayDeps;
  series: Map<string, SeriesChainState>;
  slots: Map<string, SlotChainState>;
  seatNonces: Map<string, bigint>;
  simulated: RelayCall[][];
  sent: RelayCall[][];
  simulate: (calls: readonly RelayCall[]) => SimulatedCall[];
  receipt: (calls: readonly RelayCall[]) => RelayReceipt | null;
  extended: string[];
  held: { held: number; expiresBy: number | null };
  gate: "open" | "cancelled" | "unknown";
  order: string[];
  /** Seats claimed for moves, per series, and which claims were given back. */
  claims: Array<{ seriesId: string; seats: number[]; released: boolean }>;
  /** Seats a buyer holds: a claim naming one is refused. */
  buyerHeld: Set<number>;
}

function seriesState(over: Partial<SeriesChainState> = {}): SeriesChainState {
  return {
    organiser: PARENT,
    organiserKey: organiser.address.toLowerCase(),
    totalSupply: 100,
    nextSlot: 40,
    registeredSupply: 200,
    eventEndTs: NOW + 86_400,
    cancelled: false,
    seated: false,
    termsNonce: 3n,
    ...over,
  };
}

/** The ledger logs a call would emit had it landed. */
function logsFor(calls: readonly RelayCall[]): RelayReceipt["logs"] {
  const out: Array<{ address: string; topics: string[]; data: string }> = [];
  for (const c of calls) {
    const f = ledger2RelayIface.parseTransaction({ data: c.data })!;
    const id = f.args[0] as string;
    const ev = (name: string, args: unknown[]) => {
      const l = ledger2RelayIface.encodeEventLog(name, args);
      out.push({ address: LEDGER, topics: l.topics, data: l.data });
    };
    if (f.name === "setSupplyWithSignature") ev("SupplySet", [id, 0n, f.args[1]]);
    if (f.name === "extendSalesEndWithSignature") ev("SalesEndExtended", [id, 0n, f.args[1]]);
    if (f.name === "cancelEventWithSignature") ev("EventCancelled", [id, organiser.address, false]);
    if (f.name === "revokeSignaturesWithSignature") ev("SignaturesRevoked", [id, organiser.address]);
    if (f.name === "reseatBearer" || f.name === "reseat") ev("SlotReseated", [id, f.args[1], 0n, f.args[2]]);
  }
  return out;
}

function fake(): Fake {
  const f: Fake = {
    series: new Map([[ID_A, seriesState()], [ID_B, seriesState()]]),
    slots: new Map(),
    seatNonces: new Map(),
    simulated: [],
    sent: [],
    simulate: (calls) => calls.map(() => ({ success: true })),
    receipt: (calls) => ({ status: 1, logs: logsFor(calls) }),
    extended: [],
    held: { held: 0, expiresBy: null },
    gate: "open",
    order: [],
    claims: [],
    buyerHeld: new Set(),
    deps: undefined as unknown as Ledger2RelayDeps,
  };
  f.deps = {
    activeChainId: () => CHAIN,
    ledger2Address: () => LEDGER,
    registration: (_e, seriesId) =>
      seriesId === SERIES || seriesId === SERIES_B
        ? { onChainEventId: seriesId === SERIES ? ID_A : ID_B, contract: { chainId: CHAIN, address: LEDGER, version: "ledger2" } }
        : null,
    relayConfigured: () => true,
    verifyCode: async () => ({ ok: true }),
    chainNow: async () => NOW,
    seriesState: async (_c, _l, id) => {
      const s = f.series.get(id);
      if (!s) throw new Error("EventNotFound");
      return s;
    },
    slotState: async (_c, _l, id, slot) => f.slots.get(`${id}:${slot}`) ?? { owner: "0x0000000000000000000000000000000000000000", transferNonce: 0n, seat: LEDGER2_NO_SEAT },
    seatNonce: async (_c, _l, id, seat) => f.seatNonces.get(`${id}:${seat}`) ?? 0n,
    holds: () => f.held,
    claimSeats: async (_e, seriesId, seats) => {
      const conflicts = seats.filter((k) => f.buyerHeld.has(k));
      if (conflicts.length) return { ok: false, conflicts };
      const c = { seriesId, seats: [...seats], released: false };
      f.claims.push(c);
      return { ok: true, release: () => { c.released = true; } };
    },
    cancellationGate: () => f.gate,
    simulate: async (_c, _l, calls) => {
      f.simulated.push([...calls]);
      return f.simulate(calls);
    },
    send: async (_c, _l, calls) => {
      f.order.push("send");
      f.sent.push([...calls]);
      return { hash: `0x${String(f.sent.length).padStart(64, "0")}` };
    },
    waitReceipt: async () => f.receipt(f.sent[f.sent.length - 1]!),
    onExtended: (_c, id) => f.extended.push(id),
    log: () => {},
  };
  return f;
}

function input(request: unknown, over: Partial<PrepareInput> = {}): PrepareInput {
  return {
    eventId: EVENT,
    parent: PARENT,
    seriesIds: [SERIES, SERIES_B],
    request,
    allowed: new Set(["setSupply", "extendSalesEnd", "revoke", "reseat", "reseatBearer"]),
    label: "test",
    ...over,
  };
}

function supplyItem(supply: number, nonce = 3n, seriesId = SERIES, id = ID_A) {
  return { kind: "setSupply" as const, seriesId, supply, ...W, sig: sign({ kind: "setSupply", eventId: id, supply, nonce, ...W }) };
}

beforeEach(() => _resetLedger2RelayLocksForTests());

function detail(r: unknown): Record<string, unknown> {
  return ((r as { detail?: Record<string, unknown> }).detail ?? {});
}

async function run(f: Fake, request: unknown, over: Partial<PrepareInput> = {}) {
  const p = await prepareLedger2Relay(input(request, over), f.deps);
  if (!p.ok) return p;
  return submitLedger2Relay(p.prepared, f.deps);
}

test("a capacity change: built from typed fields, simulated, sent, read back from the receipt", async () => {
  const f = fake();
  const r = await run(f, { items: [supplyItem(120)] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.result.landed, [true]);
  assert.equal(r.result.status, "landed");
  assert.equal(f.sent.length, 1);
  const call = ledger2RelayIface.parseTransaction({ data: f.sent[0]![0]!.data })!;
  assert.equal(call.name, "setSupplyWithSignature");
  assert.equal(call.args[0], ID_A);
  assert.equal(call.args[1], 120n);
  assert.equal(f.sent[0]![0]!.allowFailure, true, "terms writes may fail on their own");
});

test("inert: no ledger2 address, or a series not registered here on ledger2", async () => {
  const f = fake();
  f.deps.ledger2Address = () => null;
  assert.deepEqual(await run(f, { items: [supplyItem(120)] }), { ok: false, status: 404, error: "not_available" });

  const g = fake();
  g.deps.registration = () => ({ onChainEventId: ID_A, contract: { chainId: CHAIN, address: LEDGER, version: "ledger" } });
  assert.equal((await run(g, { items: [supplyItem(120)] }) as { error: string }).error, "not_available");

  const h = fake();
  h.deps.registration = () => ({ onChainEventId: ID_A, contract: { chainId: 421614, address: LEDGER, version: "ledger2" } });
  assert.equal((await run(h, { items: [supplyItem(120)] }) as { error: string }).error, "not_available");

  const k = fake();
  k.deps.registration = () => ({ onChainEventId: ID_A, contract: { chainId: CHAIN, address: `0x${"cc".repeat(20)}`, version: "ledger2" } });
  assert.equal((await run(k, { items: [supplyItem(120)] }) as { error: string }).error, "not_available");
  assert.equal(f.sent.length + g.sent.length + h.sent.length + k.sent.length, 0);
});

test("a series the event does not declare, or one with no registration, is refused", async () => {
  const f = fake();
  const r = await run(f, { items: [supplyItem(120)] }, { seriesIds: [SERIES_B] });
  assert.equal((r as { error: string }).error, "series_not_found");
  const g = fake();
  g.deps.registration = () => null;
  assert.equal((await run(g, { items: [supplyItem(120)] }) as { error: string }).error, "not_available");
});

test("only the event's organiser on chain makes WoCo pay", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ organiser: "0x00000000000000000000000000000000000000ee" }));
  const r = await run(f, { items: [supplyItem(120)] });
  assert.deepEqual([(r as { status: number }).status, (r as { error: string }).error], [403, "not_organiser"]);
  assert.equal(f.simulated.length, 0);
});

test("a signature made at an older nonce is stale; on a revoke it means the nonce moved", async () => {
  const f = fake();
  const r = await run(f, { items: [supplyItem(120, 2n)] });
  assert.equal((r as { error: string }).error, "signature_stale");
  assert.equal(detail(r).termsNonce, "3");

  const revoke = { kind: "revoke", seriesId: SERIES, ...W, sig: sign({ kind: "revoke", eventId: ID_A, nonce: 2n, ...W }) };
  assert.equal((await run(fake(), { items: [revoke] }) as { error: string }).error, "nonce_moved");
  assert.equal(f.simulated.length, 0, "refused before simulating");
});

test("a signature by another key is refused", async () => {
  const f = fake();
  const other = hexToBytes(Wallet.createRandom().privateKey.slice(2));
  const item = { ...supplyItem(120), sig: sign({ kind: "setSupply", eventId: ID_A, supply: 120, nonce: 3n, ...W }, other) };
  assert.equal((await run(f, { items: [item] }) as { error: string }).error, "signature_stale");
});

test("a capacity cut below sold + held is refused with the lowest allowed and when holds lapse", async () => {
  const f = fake();
  f.held = { held: 15, expiresBy: Date.UTC(2027, 0, 1, 14, 32) };
  const r = await run(f, { items: [supplyItem(50)] });
  assert.equal((r as { error: string }).error, "supply_below_sold_or_held");
  assert.equal(detail(r).minSupply, 55);
  assert.equal(detail(r).holdsExpireBy, "2027-01-01T14:32:00.000Z");
  assert.ok((await run(fake(), { items: [supplyItem(55)] })).ok, "55 = 40 sold + 15 held is allowed once no hold");
});

test("capacity: above registered, unchanged, cancelled, closed", async () => {
  assert.equal((await run(fake(), { items: [supplyItem(201)] }) as { error: string }).error, "supply_above_registered");
  assert.equal((await run(fake(), { items: [supplyItem(100)] }) as { error: string }).error, "supply_unchanged");
  const c = fake();
  c.series.set(ID_A, seriesState({ cancelled: true }));
  assert.equal((await run(c, { items: [supplyItem(120)] }) as { error: string }).error, "event_cancelled");
  const d = fake();
  d.series.set(ID_A, seriesState({ eventEndTs: NOW }));
  assert.equal((await run(d, { items: [supplyItem(120)] }) as { error: string }).error, "sales_closed", "closed AT the cutoff, as the ledger");
});

test("the server's own cancellation outranks every change but a revoke", async () => {
  const f = fake();
  f.gate = "cancelled";
  assert.equal((await run(f, { items: [supplyItem(120)] }) as { error: string }).error, "event_cancelled");
  const revoke = { kind: "revoke", seriesId: SERIES, ...W, sig: sign({ kind: "revoke", eventId: ID_A, nonce: 3n, ...W }) };
  assert.ok((await run(f, { items: [revoke] })).ok);
  const g = fake();
  g.gate = "unknown";
  assert.equal((await run(g, { items: [supplyItem(120)] }) as { error: string }).error, "cancellation_unknown");
});

test("the window is checked against the chain clock", async () => {
  const f = fake();
  const late = { issuedAt: NOW - 900, deadline: NOW + 3 * 3600 };
  const item = { kind: "setSupply", seriesId: SERIES, supply: 120, ...late, sig: sign({ kind: "setSupply", eventId: ID_A, supply: 120, nonce: 3n, ...late }) };
  assert.equal((await run(f, { items: [item] }) as { error: string }).error, "deadline_too_far");
  const ahead = { issuedAt: NOW + 60, deadline: NOW + 3600 };
  const item2 = { ...item, ...ahead, sig: sign({ kind: "setSupply", eventId: ID_A, supply: 120, nonce: 3n, ...ahead }) };
  assert.equal((await run(f, { items: [item2] }) as { error: string }).error, "signature_not_yet_valid");
});

test("request shape: duplicate series, revoke alone, kinds, caps", async () => {
  const f = fake();
  assert.equal((await run(f, { items: [supplyItem(120), supplyItem(130)] }) as { error: string }).error, "duplicate_series");
  const revoke = { kind: "revoke", seriesId: SERIES_B, ...W, sig: sign({ kind: "revoke", eventId: ID_B, nonce: 3n, ...W }) };
  assert.equal((await run(f, { items: [supplyItem(120), revoke] }) as { error: string }).error, "revoke_alone");
  const cancel = { kind: "cancel", seriesId: SERIES, ...W, sig: sign({ kind: "cancel", eventId: ID_A, nonce: 3n, ...W }) };
  assert.equal((await run(f, { items: [cancel] }) as { error: string }).error, "kind_not_accepted", "cancels go through the cancel route");
  assert.equal((await run(f, { items: [] }) as { error: string }).error, "invalid_request");
  assert.equal((await run(f, { items: Array(61).fill(supplyItem(120)) }) as { error: string }).error, "batch_too_large");
  assert.equal((await run(f, { items: [{ ...supplyItem(120), sig: "0x12" }] }) as { error: string }).error, "invalid_item");
  assert.equal((await run(f, { items: [{ ...supplyItem(120), onChainEventId: ID_B, seriesId: "../x" }] }) as { error: string }).error, "invalid_item");
  assert.equal(f.simulated.length, 0);
});

test("one relay per on-chain event at a time; the lock lifts after the send", async () => {
  const f = fake();
  const first = await prepareLedger2Relay(input({ items: [supplyItem(120)] }), f.deps);
  assert.ok(first.ok);
  const second = await prepareLedger2Relay(input({ items: [supplyItem(120)] }), f.deps);
  assert.equal((second as { error: string }).error, "in_flight");
  await submitLedger2Relay(first.prepared, f.deps);
  assert.ok((await prepareLedger2Relay(input({ items: [supplyItem(120)] }), f.deps)).ok);
});

test("a refusal after the lock was taken releases it", async () => {
  const f = fake();
  f.simulate = (calls) => calls.map(() => ({ success: false, error: "SupplyUnchanged" }));
  assert.equal((await run(f, { items: [supplyItem(120)] }) as { error: string }).error, "supply_unchanged");
  f.simulate = (calls) => calls.map(() => ({ success: true }));
  assert.ok((await run(f, { items: [supplyItem(120)] })).ok);
});

test("the first simulated failure names the refusal and the item", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  f.slots.set(`${ID_A}:3`, { owner: holder.address.toLowerCase(), transferNonce: 0n, seat: 5n });
  const move = {
    kind: "reseatBearer", seriesId: SERIES, slot: 3, toSeat: 9, ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot: 3, toSeat: 9n, holder: holder.address.toLowerCase(), nonce: 0n, termsNonce: 3n, seatNonce: 0n, ...W }),
  };
  f.simulate = (calls) => calls.map((_, i) => (i === 0 ? { success: false, error: "SeatTaken" } : { success: false, error: "NotOrganiserKey" }));
  const r = await run(f, { items: [supplyItem(120, 3n, SERIES_B, ID_B), move] });
  assert.equal((r as { error: string }).error, "seat_taken", "only the FIRST failure counts");
  assert.equal(detail(r).index, 1, "the request index, not the call index");
});

test("seat moves go first and all-or-nothing, terms writes after", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  f.slots.set(`${ID_A}:3`, { owner: holder.address.toLowerCase(), transferNonce: 0n, seat: 5n });
  const move = {
    kind: "reseatBearer", seriesId: SERIES, slot: 3, toSeat: 9, ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot: 3, toSeat: 9n, holder: holder.address.toLowerCase(), nonce: 0n, termsNonce: 3n, seatNonce: 0n, ...W }),
  };
  const r = await run(f, { items: [supplyItem(120, 3n, SERIES_B, ID_B), move] });
  assert.ok(r.ok, JSON.stringify(r));
  const names = f.sent[0]!.map((c) => [ledger2RelayIface.parseTransaction({ data: c.data })!.name, c.allowFailure]);
  assert.deepEqual(names, [["reseatBearer", false], ["setSupplyWithSignature", true]]);
  assert.deepEqual(r.result.landed, [true, true], "landed is in REQUEST order");
});

test("a dependent swap verifies against the nonces the earlier moves leave", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  const a = holder.address.toLowerCase();
  const b = "0x00000000000000000000000000000000000000b2";
  f.slots.set(`${ID_A}:1`, { owner: a, transferNonce: 4n, seat: 10n });
  f.slots.set(`${ID_A}:2`, { owner: b, transferNonce: 0n, seat: 20n });
  f.seatNonces.set(`${ID_A}:10`, 2n);
  f.seatNonces.set(`${ID_A}:20`, 7n);
  const mv = (slot: number, toSeat: bigint, h: string, nonce: bigint, seatNonce: bigint) => ({
    kind: "reseatBearer", seriesId: SERIES, slot, toSeat: toSeat === LEDGER2_NO_SEAT ? "none" : Number(toSeat), ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot, toSeat, holder: h, nonce, termsNonce: 3n, seatNonce, ...W }),
  });
  const items = [mv(1, LEDGER2_NO_SEAT, a, 4n, 0n), mv(2, 10n, b, 0n, 3n), mv(1, 20n, a, 5n, 8n)];
  const r = await run(f, { items });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(f.sent[0]!.length, 3);
  // Signed against today's nonces instead, the second move is stale.
  const g = fake();
  g.series = f.series; g.slots = f.slots; g.seatNonces = f.seatNonces;
  const wrong = [items[0], mv(2, 10n, b, 0n, 2n), items[2]];
  assert.equal((await run(g, { items: wrong }) as { error: string }).error, "signature_stale");
});

// ── Seats a move aims at (S6): off sale while it is in flight ────────────────

function oneMove(f: Fake, toSeat = 9) {
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  f.slots.set(`${ID_A}:3`, { owner: holder.address.toLowerCase(), transferNonce: 0n, seat: 5n });
  return {
    kind: "reseatBearer", seriesId: SERIES, slot: 3, toSeat, ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot: 3, toSeat: BigInt(toSeat), holder: holder.address.toLowerCase(), nonce: 0n, termsNonce: 3n, seatNonce: 0n, ...W }),
  };
}

test("a move into a seat a buyer is holding is refused before anything is sent, naming the seat", async () => {
  const f = fake();
  const move = oneMove(f);
  f.buyerHeld.add(9);
  const r = await run(f, { items: [move] });
  assert.equal((r as { error: string }).error, "seat_on_hold");
  assert.deepEqual(detail(r).seats, [9]);
  assert.equal(f.sent.length, 0);
  assert.ok((await run(f, { items: [move] }) as { error: string }).error !== "in_flight", "the event's relay lock was given back");
});

test("a landed move keeps its target seats off sale (a replica may not show it yet); a reverted one gives them back", async () => {
  const f = fake();
  const r = await run(f, { items: [oneMove(f)] });
  assert.ok(r.ok);
  assert.deepEqual(f.claims, [{ seriesId: SERIES, seats: [9], released: false }]);
  const g = fake();
  g.receipt = () => ({ status: 0, logs: [] });
  await run(g, { items: [oneMove(g)] });
  assert.deepEqual(g.claims, [{ seriesId: SERIES, seats: [9], released: true }]);
});

test("a swap claims nothing: its targets are its own tickets' seats", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  const a = holder.address.toLowerCase();
  const b = "0x00000000000000000000000000000000000000b2";
  f.slots.set(`${ID_A}:1`, { owner: a, transferNonce: 4n, seat: 10n });
  f.slots.set(`${ID_A}:2`, { owner: b, transferNonce: 0n, seat: 20n });
  f.seatNonces.set(`${ID_A}:10`, 2n);
  f.seatNonces.set(`${ID_A}:20`, 7n);
  f.buyerHeld.add(10).add(20); // bought minutes ago: off sale in the store, which must not block the swap
  const mv = (slot: number, toSeat: bigint, h: string, nonce: bigint, seatNonce: bigint) => ({
    kind: "reseatBearer", seriesId: SERIES, slot, toSeat: toSeat === LEDGER2_NO_SEAT ? "none" : Number(toSeat), ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot, toSeat, holder: h, nonce, termsNonce: 3n, seatNonce, ...W }),
  });
  const r = await run(f, { items: [mv(1, LEDGER2_NO_SEAT, a, 4n, 0n), mv(2, 10n, b, 0n, 3n), mv(1, 20n, a, 5n, 8n)] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(f.claims, [], "no seat outside the swap was aimed at");
});

test("a two-party reseat needs the holder's signature over the same digest", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  const h = holder.address.toLowerCase();
  f.slots.set(`${ID_A}:3`, { owner: h, transferNonce: 1n, seat: 5n });
  const action: Ledger2Action = { kind: "reseat", eventId: ID_A, slot: 3, toSeat: 9n, holder: h, nonce: 1n, termsNonce: 3n, seatNonce: 0n, ...W };
  const item = { kind: "reseat", seriesId: SERIES, slot: 3, toSeat: 9, ...W, sig: sign(action), holderSig: sign(action, holderPk) };
  assert.ok((await run(f, { items: [item] })).ok);
  const bad = { ...item, holderSig: sign(action, organiserPk) };
  assert.equal((await run(f, { items: [bad] }) as { error: string }).error, "holder_signature_invalid");
  const none = { ...item, holderSig: undefined };
  assert.equal((await run(f, { items: [none] }) as { error: string }).error, "invalid_item");
});

test("capacity on a seated series is refused before simulating: its supply is the plan's seats", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  assert.equal((await run(f, { items: [supplyItem(120)] }) as { error: string }).error, "seated_supply");
  assert.equal(f.simulated.length, 0);
});

test("seat moves on an event that is not seated are refused before simulating", async () => {
  const f = fake();
  const move = { kind: "reseatBearer", seriesId: SERIES, slot: 3, toSeat: 9, ...W, sig: supplyItem(120).sig };
  assert.equal((await run(f, { items: [move] }) as { error: string }).error, "not_seated");
  assert.equal(f.simulated.length, 0);
});

test("an extension that lands drops the remembered cutoff", async () => {
  const f = fake();
  const end = NOW + 2 * 86_400;
  const item = { kind: "extendSalesEnd", seriesId: SERIES, eventEndTs: end, ...W, sig: sign({ kind: "extendSalesEnd", eventId: ID_A, eventEndTs: end, nonce: 3n, ...W }) };
  const r = await run(f, { items: [item] });
  assert.ok(r.ok);
  assert.deepEqual(f.extended, [ID_A]);
  assert.equal((await run(fake(), { items: [{ ...item, eventEndTs: NOW + 86_400 }] }) as { error: string }).error, "sales_end_not_later");
});

test("a terms write that failed in the batch reads as not landed", async () => {
  const f = fake();
  f.receipt = (calls) => ({ status: 1, logs: logsFor(calls.slice(1)) });
  const r = await run(f, { items: [supplyItem(120), supplyItem(150, 3n, SERIES_B, ID_B)] });
  assert.ok(r.ok);
  assert.deepEqual(r.result.landed, [false, true]);
  assert.equal(f.extended.length, 0);
});

test("no receipt in time is `unconfirmed`, and the lock is released", async () => {
  const f = fake();
  f.receipt = () => null;
  const r = await run(f, { items: [supplyItem(120)] });
  assert.ok(r.ok);
  assert.equal(r.result.status, "unconfirmed");
  assert.equal(r.result.landed, undefined);
  assert.ok((await prepareLedger2Relay(input({ items: [supplyItem(120)] }), f.deps)).ok);
});

test("a batch that reverts on chain submits the abort revokes, and only then", async () => {
  const f = fake();
  f.receipt = (calls) => (calls.length === 1 && ledger2RelayIface.parseTransaction({ data: calls[0]!.data })!.name === "revokeSignaturesWithSignature"
    ? { status: 1, logs: logsFor(calls) }
    : { status: 0, logs: [] });
  const abort = { seriesId: SERIES, ...W, sig: sign({ kind: "revoke", eventId: ID_A, nonce: 3n, ...W }) };
  const r = await run(f, { items: [supplyItem(120)], aborts: [abort] });
  assert.ok(r.ok);
  assert.equal(r.result.status, "reverted_on_chain");
  assert.equal(r.result.aborted, true);
  assert.equal(f.sent.length, 2);
  assert.equal(ledger2RelayIface.parseTransaction({ data: f.sent[1]![0]!.data })!.name, "revokeSignaturesWithSignature");

  const g = fake();
  const ok = await run(g, { items: [supplyItem(120)], aborts: [abort] });
  assert.ok(ok.ok);
  assert.equal(g.sent.length, 1, "a batch that landed never sends its aborts");
  assert.equal(ok.result.aborted, undefined);
});

test("an abort signed at the wrong nonce refuses the whole request", async () => {
  const f = fake();
  const abort = { seriesId: SERIES, ...W, sig: sign({ kind: "revoke", eventId: ID_A, nonce: 2n, ...W }) };
  assert.equal((await run(f, { items: [supplyItem(120)], aborts: [abort] }) as { error: string }).error, "signature_stale");
  const stray = { seriesId: SERIES_B, ...W, sig: abort.sig };
  assert.equal((await run(fake(), { items: [supplyItem(120)], aborts: [stray] }) as { error: string }).error, "invalid_abort");
});

test("relay off, code check failed, chain unread", async () => {
  const f = fake();
  f.deps.relayConfigured = () => false;
  assert.equal((await run(f, { items: [supplyItem(120)] }) as { error: string }).error, "relay_unavailable");
  const g = fake();
  g.deps.verifyCode = async () => ({ ok: false, reason: "nope" });
  assert.equal((await run(g, { items: [supplyItem(120)] }) as { error: string }).error, "relay_unavailable");
  const h = fake();
  h.deps.chainNow = async () => {
    throw new Error("rpc down");
  };
  assert.deepEqual([(await run(h, { items: [supplyItem(120)] }) as { status: number }).status], [502]);
});

// ── cancel ordering ──────────────────────────────────────────────────────────

function cancelItem(nonce = 3n, seriesId = SERIES, id = ID_A) {
  return { kind: "cancel", seriesId, ...W, sig: sign({ kind: "cancel", eventId: id, nonce, ...W }) };
}

const recorded = { ok: true as const, created: true, cancellation: {} as never };

test("cancel: checks the signatures, records, then relays", async () => {
  const f = fake();
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES, SERIES_B], chainCancels: [cancelItem(), cancelItem(3n, SERIES_B, ID_B)], record: () => (f.order.push("record"), recorded) },
    f.deps,
  );
  assert.equal(r.kind, "done");
  assert.deepEqual(f.order, ["record", "send"]);
  assert.equal((r as { chain: { status: string } }).chain.status, "landed");
  assert.deepEqual((r as { chain: { landed: boolean[] } }).chain.landed, [true, true]);
});

test("cancel: a stale signature records NOTHING", async () => {
  const f = fake();
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem(2n)], record: () => (f.order.push("record"), recorded) },
    f.deps,
  );
  assert.equal(r.kind, "refused");
  assert.deepEqual(f.order, []);
});

test("cancel: a chain we cannot read still records, and says the chain part is not done", async () => {
  const f = fake();
  f.deps.chainNow = async () => {
    throw new Error("rpc down");
  };
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], record: () => (f.order.push("record"), recorded) },
    f.deps,
  );
  assert.equal(r.kind, "done");
  assert.deepEqual(f.order, ["record"]);
  assert.deepEqual((r as { chain: unknown }).chain, { status: "failed", error: "chain_unverified" });
});

test("cancel: no signatures is the record alone; an unsaved record releases the lock", async () => {
  const f = fake();
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: undefined, record: () => (f.order.push("record"), recorded) },
    f.deps,
  );
  assert.equal(r.kind, "done");
  assert.equal((r as { chain?: unknown }).chain, undefined);

  const g = fake();
  const failed = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], record: () => ({ ok: false, reason: "not-persisted" }) },
    g.deps,
  );
  assert.equal(failed.kind, "done");
  assert.equal(g.sent.length, 0, "nothing relayed when the record did not save");
  const again = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], record: () => recorded },
    g.deps,
  );
  assert.equal((again as { chain: { status: string } }).chain.status, "landed");
});

test("cancel: over the chain budget, or a change still saving, still records - the chain half waits", async () => {
  const f = fake();
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], chainAllowed: false, record: () => (f.order.push("record"), recorded) },
    f.deps,
  );
  assert.equal(r.kind, "done");
  assert.deepEqual(f.order, ["record"]);
  assert.deepEqual((r as { chain: unknown }).chain, { status: "failed", error: "rate_limited" });

  const g = fake();
  const held = await prepareLedger2Relay(input({ items: [supplyItem(120)] }), g.deps);
  assert.ok(held.ok, "a capacity change holds the event's lock");
  const c = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], record: () => (g.order.push("record"), recorded) },
    g.deps,
  );
  assert.equal(c.kind, "done");
  assert.deepEqual(g.order, ["record"]);
  assert.deepEqual((c as { chain: unknown }).chain, { status: "failed", error: "in_flight" });
});

test("two moves on one slot read that slot once", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ seated: true, nextSlot: 10 }));
  const h = holder.address.toLowerCase();
  f.slots.set(`${ID_A}:3`, { owner: h, transferNonce: 0n, seat: 5n });
  let reads = 0;
  const slotState = f.deps.slotState;
  f.deps.slotState = async (...a) => (reads++, slotState(...a));
  const mv = (toSeat: number, nonce: bigint) => ({
    kind: "reseatBearer", seriesId: SERIES, slot: 3, toSeat, ...W,
    sig: sign({ kind: "reseatBearer", eventId: ID_A, slot: 3, toSeat: BigInt(toSeat), holder: h, nonce, termsNonce: 3n, seatNonce: 0n, ...W }),
  });
  assert.ok((await run(f, { items: [mv(9, 0n), mv(11, 1n)] })).ok);
  assert.equal(reads, 1);
});

test("cancel: an event already cancelled on chain is refused for that series", async () => {
  const f = fake();
  f.series.set(ID_A, seriesState({ cancelled: true }));
  const r = await cancelEventWithChain(
    { eventId: EVENT, parent: PARENT, seriesIds: [SERIES], chainCancels: [cancelItem()], record: () => recorded },
    f.deps,
  );
  assert.equal(r.kind, "refused");
  assert.equal((r as { refusal: { error: string } }).refusal.error, "already_cancelled");
});
