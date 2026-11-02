/**
 * The ledger2 organiser-signed encoder (`src/ticket/ledger2-terms.ts`).
 *
 * Three anchors: the type strings are the ledger's typehash strings verbatim
 * (WoCoTicketLedger.sol abf5fb5), every digest equals ethers' EIP-712 hash of the same
 * statement, and the GOLDEN digests below are what the contracts repo asserts against
 * the ledger's own `*Digest` views (WoCo-Contracts
 * `test/WoCoTicketLedgerTermsVectors.t.sol`, which sets the same nonces in storage).
 * Change a golden digest only together with that test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedDataEncoder, Wallet, verifyTypedData } from "ethers";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  LEDGER2_NO_SEAT,
  LEDGER2_TYPES,
  LEDGER2_RELAY_MAX_LEFT_SECS,
  LEDGER2_RELAY_MIN_LEFT_SECS,
  ledger2Digest,
  ledger2SignatureWindow,
  ledger2Statement,
  ledger2WindowRefusal,
  planSeatMoveNonces,
  recoverLedger2Signer,
  signLedger2Action,
  type Ledger2Action,
  type SeatSlotState,
} from "../src/ticket/ledger2-terms.js";

/** The strings inside the ledger's `keccak256(...)` typehash constants (:495-540). */
const CONTRACT_TYPE_STRINGS: Record<keyof typeof LEDGER2_TYPES, string> = {
  SetSupply: "SetSupply(bytes32 eventId,uint64 supply,uint256 nonce,uint256 issuedAt,uint256 deadline)",
  ExtendSalesEnd: "ExtendSalesEnd(bytes32 eventId,uint64 eventEndTs,uint256 nonce,uint256 issuedAt,uint256 deadline)",
  CancelEvent: "CancelEvent(bytes32 eventId,uint256 nonce,uint256 issuedAt,uint256 deadline)",
  RevokeSignatures: "RevokeSignatures(bytes32 eventId,uint256 nonce,uint256 issuedAt,uint256 deadline)",
  Reseat:
    "Reseat(bytes32 eventId,uint256 slot,uint256 toSeat,address holder,uint256 nonce,uint256 termsNonce,uint256 seatNonce,uint256 issuedAt,uint256 deadline)",
  ReseatBearer:
    "ReseatBearer(bytes32 eventId,uint256 slot,uint256 toSeat,address holder,uint256 nonce,uint256 termsNonce,uint256 seatNonce,uint256 issuedAt,uint256 deadline)",
};

// The contracts-repo test places the ledger at this address on chain 42161
// (`deployCodeTo`), so both sides hash the same domain.
const TARGET = { chainId: 42161, address: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f" };
const EVENT_ID = `0x${"ab".repeat(32)}`;
const HOLDER = "0x1111111111111111111111111111111111111111";
const W = { issuedAt: 1_800_000_000, deadline: 1_800_003_600 };

/** Distinct non-zero values in every field, so a swapped pair changes the digest. */
const VECTORS: Array<{ action: Ledger2Action; digest: string }> = [
  { action: { kind: "setSupply", eventId: EVENT_ID, supply: 120, nonce: 3n, ...W }, digest: "0x0f9638f8888c531ccdd05ad76d90103effc6e67eb7538872348069ee426db0ef" },
  { action: { kind: "extendSalesEnd", eventId: EVENT_ID, eventEndTs: 1_900_000_000, nonce: 4n, ...W }, digest: "0xaedf4803168296c6410de89a90ea786e996add56bee500ad8d23177d900258d2" },
  { action: { kind: "cancel", eventId: EVENT_ID, nonce: 5n, ...W }, digest: "0xecac648162449e19ef21ec09cbe54924f118a8a9a414e3d8808623a4eb0583ae" },
  { action: { kind: "revoke", eventId: EVENT_ID, nonce: 6n, ...W }, digest: "0xfe5d8fc087e40ecdd7abefd3757d70c7a04c15fac3adfcbafd7af58255ffa67f" },
  {
    action: { kind: "reseat", eventId: EVENT_ID, slot: 7, toSeat: 41n, holder: HOLDER, nonce: 2n, termsNonce: 9n, seatNonce: 1n, ...W },
    digest: "0x68731ff2799e85023f80c06e3f693ce0c908d96f3cd75c63b554906c2fea5162",
  },
  {
    action: {
      kind: "reseatBearer", eventId: EVENT_ID, slot: 7, toSeat: LEDGER2_NO_SEAT, holder: HOLDER, nonce: 2n, termsNonce: 9n, seatNonce: 0n, ...W,
    },
    digest: "0x2a107cff2feba6daddb8d828eeebc9a9ab48b0faba783c7cced483961022a613",
  },
];

test("type strings are the ledger's typehash strings", () => {
  for (const [name, fields] of Object.entries(LEDGER2_TYPES)) {
    const s = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    assert.equal(s, CONTRACT_TYPE_STRINGS[name as keyof typeof LEDGER2_TYPES]);
  }
});

test("digests equal ethers' EIP-712 hash and the golden vectors", () => {
  for (const { action, digest } of VECTORS) {
    const s = ledger2Statement(TARGET, action);
    const ethersHash = TypedDataEncoder.hash(s.domain, { [s.primaryType]: [...s.fields] }, s.message);
    assert.equal(ledger2Digest(TARGET, action), ethersHash, action.kind);
    assert.equal(ledger2Digest(TARGET, action), digest, `golden ${action.kind}`);
  }
});

test("the domain binds chain and contract", () => {
  const a = VECTORS[0]!.action;
  const base = ledger2Digest(TARGET, a);
  assert.notEqual(ledger2Digest({ ...TARGET, chainId: 421614 }, a), base);
  assert.notEqual(ledger2Digest({ ...TARGET, address: HOLDER }, a), base);
});

test("sign then recover; ethers agrees; a moved nonce recovers to someone else", () => {
  const wallet = Wallet.createRandom();
  const pk = hexToBytes(wallet.privateKey.slice(2));
  for (const { action } of VECTORS) {
    const sig = signLedger2Action(TARGET, action, pk);
    assert.equal(recoverLedger2Signer(TARGET, action, sig), wallet.address.toLowerCase(), action.kind);
    const s = ledger2Statement(TARGET, action);
    assert.equal(verifyTypedData(s.domain, { [s.primaryType]: [...s.fields] }, s.message, sig), wallet.address);
    const moved = { ...action, nonce: action.nonce + 1n } as Ledger2Action;
    assert.notEqual(recoverLedger2Signer(TARGET, moved, sig), wallet.address.toLowerCase());
  }
  assert.equal(recoverLedger2Signer(TARGET, VECTORS[0]!.action, "0x1234"), null);
  assert.equal(recoverLedger2Signer(TARGET, VECTORS[0]!.action, 7), null);
});

test("the signing window: 15 min behind chain time, an hour ahead, and the relay accepts it", () => {
  const now = 1_800_000_000;
  const w = ledger2SignatureWindow(now);
  assert.deepEqual(w, { issuedAt: now - 900, deadline: now + 3600 });
  assert.equal(ledger2WindowRefusal(w.issuedAt, w.deadline, now), null);
});

test("window refusals mirror the ledger, then narrow", () => {
  const now = 1_800_000_000;
  assert.equal(ledger2WindowRefusal(now + 1, now + 3600, now), "signature_not_yet_valid");
  assert.equal(ledger2WindowRefusal(now, now + 3600, now), null, "issuedAt == now is valid");
  assert.equal(ledger2WindowRefusal(now - 900, now + LEDGER2_RELAY_MIN_LEFT_SECS - 1, now), "signature_expiring");
  assert.equal(ledger2WindowRefusal(now - 900, now + LEDGER2_RELAY_MIN_LEFT_SECS, now), null);
  assert.equal(ledger2WindowRefusal(now - 900, now + LEDGER2_RELAY_MAX_LEFT_SECS, now), null);
  assert.equal(ledger2WindowRefusal(now - 900, now + LEDGER2_RELAY_MAX_LEFT_SECS + 1, now), "deadline_too_far");
  assert.equal(ledger2WindowRefusal(now - 48 * 3600 - 1, now + 3600, now), "deadline_too_far", "window over 48 h");
  assert.equal(ledger2WindowRefusal(now - 900, now - 1000, now), "deadline_too_far", "deadline before issuedAt");
  assert.equal(ledger2WindowRefusal(1.5, now + 3600, now), "window_invalid");
  assert.equal(ledger2WindowRefusal("1", now + 3600, now), "window_invalid");
  assert.equal(ledger2WindowRefusal(-1, now + 3600, now), "window_invalid");
});

test("seat sequence: a swap commits to the nonces the earlier moves leave", () => {
  // Slot 1 in seat 10, slot 2 in seat 20. Swap: 1 -> NO_SEAT, 2 -> 10, 1 -> 20.
  const slots = new Map<number, SeatSlotState>([
    [1, { owner: "0xaaa", transferNonce: 4n, seat: 10n }],
    [2, { owner: "0xbbb", transferNonce: 0n, seat: 20n }],
  ]);
  const seatNonces = new Map<bigint, bigint>([[10n, 2n], [20n, 7n]]);
  const plan = planSeatMoveNonces(3n, slots, seatNonces, [
    { slot: 1, toSeat: LEDGER2_NO_SEAT },
    { slot: 2, toSeat: 10n },
    { slot: 1, toSeat: 20n },
  ]);
  assert.deepEqual(plan, [
    { holder: "0xaaa", nonce: 4n, termsNonce: 3n, seatNonce: 0n },
    { holder: "0xbbb", nonce: 0n, termsNonce: 3n, seatNonce: 3n }, // seat 10 freed once
    { holder: "0xaaa", nonce: 5n, termsNonce: 3n, seatNonce: 8n }, // seat 20 freed once, slot 1 moved once
  ]);
  // The inputs are not mutated.
  assert.equal(slots.get(1)!.transferNonce, 4n);
  assert.equal(seatNonces.get(10n), 2n);
});

test("seat sequence: refuses what cannot land or is not covered", () => {
  const slots = new Map<number, SeatSlotState>([
    [1, { owner: "0xaaa", transferNonce: 0n, seat: 10n }],
    [2, { owner: "0xbbb", transferNonce: 0n, seat: 20n }],
  ]);
  const seats = new Map<bigint, bigint>([[10n, 0n], [20n, 0n], [30n, 0n]]);
  assert.equal(planSeatMoveNonces(0n, slots, seats, [{ slot: 2, toSeat: 10n }]), null, "into a seat slot 1 holds");
  assert.equal(planSeatMoveNonces(0n, slots, seats, [{ slot: 1, toSeat: 10n }]), null, "into its own seat");
  assert.equal(planSeatMoveNonces(0n, slots, seats, [{ slot: 3, toSeat: 30n }]), null, "slot not read");
  assert.equal(planSeatMoveNonces(0n, slots, seats, [{ slot: 1, toSeat: 40n }]), null, "seat not read");
  assert.ok(planSeatMoveNonces(0n, slots, seats, [{ slot: 1, toSeat: 30n }, { slot: 2, toSeat: 10n }]));
});
