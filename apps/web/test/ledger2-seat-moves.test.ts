/**
 * Changing a ticket's seat (src/lib/ledger2/seat-moves.ts): the plan from the chain's
 * seats, the first move's digest checked against the ledger before the key signs, the
 * abort revoke on every request, the key zeroed, and the outcome settled from the chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  LEDGER2_NO_SEAT, ledger2Digest, recoverLedger2Signer, type Ledger2Action, type Ledger2RelayRequest, type Ledger2RelayResult, type SeatSlotState,
} from "@woco/shared/ticket/ledger2-terms";
import { messageFor, type Ledger2ClientIO, type Ledger2EventView } from "../src/lib/ledger2/organiser-changes.js";
import { planMoves, sendSeatMoves, signSeatMoves } from "../src/lib/ledger2/seat-moves.js";

const LEDGER = "0x00000000000000000000000000000000000000aa";
const TARGET = { chainId: 42161, address: LEDGER };
const ID = `0x${"0a".repeat(32)}`;
const NOW = 1_800_000_000;
const key = Wallet.createRandom();
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

const view = (over: Partial<Ledger2EventView["series"][number]> = {}): Ledger2EventView => ({
  target: TARGET,
  chainNow: NOW,
  series: [{
    seriesId: "stalls", name: "Stalls", onChainEventId: ID, totalSupply: 400, nextSlot: 10, registeredSupply: 400,
    eventEndTs: NOW + 86_400, cancelled: false, termsNonce: 3n, organiserKey: key.address.toLowerCase(), seated: true, ...over,
  }],
});

function fake(over: { relay?: (r: Ledger2RelayRequest) => Promise<Ledger2RelayResult>; digest?: (a: Ledger2Action) => string } = {}) {
  const slots = new Map<number, SeatSlotState>([
    [1, { owner: A, transferNonce: 4n, seat: 10n }],
    [2, { owner: B, transferNonce: 0n, seat: 20n }],
  ]);
  const nonces = new Map<bigint, bigint>([[10n, 2n], [20n, 7n], [30n, 1n]]);
  const keys: Uint8Array[] = [];
  const sent: Ledger2RelayRequest[] = [];
  const io: Ledger2ClientIO = {
    deployment: async () => TARGET,
    readSeries: async () => [],
    chainNow: async () => NOW,
    chainDigest: async (_l, a) => (over.digest ?? ((x) => ledger2Digest(TARGET, x)))(a),
    organiserKey: async () => {
      const pk = hexToBytes(key.privateKey.slice(2));
      keys.push(pk);
      return { privateKey: pk, address: key.address.toLowerCase() };
    },
    relay: async (_e, r) => {
      sent.push(r);
      return (over.relay ?? (async () => ({ status: "landed", txHash: "0x1", landed: r.items.map(() => true) })))(r);
    },
    slots: async (_l, _e, ss) => new Map(ss.map((s) => [s, { ...slots.get(s)! }])),
    seatNonces: async (_l, _e, seats) => new Map(seats.map((s) => [s, nonces.get(s) ?? 0n])),
    sleep: async () => {},
  };
  return { io, keys, sent, slots };
}

test("a swap is one dependent sequence: a out, b into a's seat, a into b's", () => {
  assert.deepEqual(planMoves({ kind: "swap", a: 1, b: 2 }, new Map([[1, 10n], [2, 20n]])), [
    { slot: 1, toSeat: LEDGER2_NO_SEAT }, { slot: 2, toSeat: 10n }, { slot: 1, toSeat: 20n },
  ]);
  assert.throws(() => planMoves({ kind: "swap", a: 1, b: 2 }, new Map([[1, 10n], [2, LEDGER2_NO_SEAT]])), /need a seat/);
});

test("a move is signed by the organiser key at the chain's nonces, with an abort revoke at the terms nonce; the key is zeroed", async () => {
  const f = fake();
  const { request, planned } = await signSeatMoves(view(), "stalls", { kind: "move", slot: 1, to: 30 }, f.io);
  assert.equal(request.items.length, 1);
  const it = request.items[0]! as Extract<typeof request.items[number], { kind: "reseatBearer" }>;
  assert.equal(it.toSeat, 30);
  const action: Ledger2Action = {
    kind: "reseatBearer", eventId: ID, slot: 1, toSeat: 30n, holder: A, nonce: 4n, termsNonce: 3n, seatNonce: 1n,
    issuedAt: it.issuedAt, deadline: it.deadline,
  };
  assert.equal(recoverLedger2Signer(TARGET, action, it.sig), key.address.toLowerCase());
  const ab = request.aborts![0]!;
  assert.equal(recoverLedger2Signer(TARGET, { kind: "revoke", eventId: ID, nonce: 3n, issuedAt: ab.issuedAt, deadline: ab.deadline }, ab.sig), key.address.toLowerCase());
  assert.deepEqual(planned.emptied, [10n], "the old seat is left empty");
  assert.ok(f.keys.every((k) => k.every((b) => b === 0)), "zeroed");
});

test("a swap signs three moves against the nonces each leaves, and empties nothing", async () => {
  const f = fake();
  const { request, planned } = await signSeatMoves(view(), "stalls", { kind: "swap", a: 1, b: 2 }, f.io);
  assert.equal(request.items.length, 3);
  assert.deepEqual(planned.emptied, []);
  const [m1, m2, m3] = request.items as Array<Extract<typeof request.items[number], { kind: "reseatBearer" }>>;
  const w = { issuedAt: m1!.issuedAt, deadline: m1!.deadline };
  const base = { kind: "reseatBearer" as const, eventId: ID, termsNonce: 3n, ...w };
  assert.equal(recoverLedger2Signer(TARGET, { ...base, slot: 1, toSeat: LEDGER2_NO_SEAT, holder: A, nonce: 4n, seatNonce: 0n }, m1!.sig), key.address.toLowerCase());
  assert.equal(recoverLedger2Signer(TARGET, { ...base, slot: 2, toSeat: 10n, holder: B, nonce: 0n, seatNonce: 3n }, m2!.sig), key.address.toLowerCase(), "seat 10's nonce after a left it");
  assert.equal(recoverLedger2Signer(TARGET, { ...base, slot: 1, toSeat: 20n, holder: A, nonce: 5n, seatNonce: 8n }, m3!.sig), key.address.toLowerCase());
});

test("refused before signing: a disagreeing digest, an old key, cut-off, cancelled, unseated", async () => {
  const moveOnly = fake({ digest: (a) => (a.kind === "reseatBearer" ? `0x${"00".repeat(32)}` : ledger2Digest(TARGET, a)) });
  await assert.rejects(signSeatMoves(view(), "stalls", { kind: "move", slot: 1, to: 30 }, moveOnly.io), (e: { code?: string }) => e.code === "digest_mismatch", "the move's own digest");
  assert.equal(moveOnly.keys.length, 0);
  const bad = fake({ digest: () => `0x${"00".repeat(32)}` });
  await assert.rejects(signSeatMoves(view(), "stalls", { kind: "move", slot: 1, to: 30 }, bad.io), (e: { code?: string }) => e.code === "digest_mismatch");
  assert.equal(bad.keys.length, 0, "no key derived");
  const f = fake();
  await assert.rejects(signSeatMoves(view({ organiserKey: "0x00000000000000000000000000000000000000ff" }), "stalls", { kind: "move", slot: 1, to: 30 }, f.io), (e: { code?: string }) => e.code === "key_moved");
  await assert.rejects(signSeatMoves({ ...view(), chainNow: NOW + 86_400 }, "stalls", { kind: "move", slot: 1, to: 30 }, f.io), (e: { code?: string }) => e.code === "sales_closed");
  await assert.rejects(signSeatMoves(view({ cancelled: true }), "stalls", { kind: "move", slot: 1, to: 30 }, f.io), (e: { code?: string }) => e.code === "event_cancelled");
  await assert.rejects(signSeatMoves(view({ seated: false }), "stalls", { kind: "move", slot: 1, to: 30 }, f.io), (e: { code?: string }) => e.code === "not_seated");
  await assert.rejects(signSeatMoves(view(), "stalls", { kind: "move", slot: 1, to: 10 }, f.io), (e: { code?: string }) => e.code === "seat_move_invalid", "into its own seat");
});

test("send: landed is moved; a seat being bought names it; unconfirmed settles from the chain", async () => {
  const f = fake();
  const signed = await signSeatMoves(view(), "stalls", { kind: "move", slot: 1, to: 30 }, f.io);
  assert.deepEqual(await sendSeatMoves("evt", LEDGER, signed, f.io, messageFor), { phase: "moved" });
  const busy = fake({ relay: async () => { throw Object.assign(new Error("x"), { code: "seat_on_hold", body: { seats: [30] } }); } });
  const r = await sendSeatMoves("evt", LEDGER, signed, busy.io, messageFor);
  assert.equal(r.phase, "failed");
  assert.deepEqual(r.phase === "failed" && r.seats, [30]);
  assert.match(r.phase === "failed" ? r.message : "", /buying that seat/);
  const slow = fake({ relay: async () => ({ status: "unconfirmed", txHash: "0x2" }) });
  slow.slots.set(1, { owner: A, transferNonce: 5n, seat: 30n });
  assert.deepEqual(await sendSeatMoves("evt", LEDGER, signed, slow.io, messageFor), { phase: "moved" });
  const reverted = fake({ relay: async () => ({ status: "reverted_on_chain", txHash: "0x3", aborted: true }) });
  assert.equal((await sendSeatMoves("evt", LEDGER, signed, reverted.io, messageFor)).phase, "failed");
});
