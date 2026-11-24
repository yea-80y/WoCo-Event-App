/**
 * The receipt, its presentation and the v3 fingerprint (`src/holding/receipt.ts`).
 * Anchors: exact type strings, golden digests and signatures equal to ethers', the
 * domain binding, canonical-signature refusals, every presentation refusal, and the
 * five per-slot messages (door QR, receipt, presentation, transfer, handover) all
 * hashing differently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, TypedDataEncoder, Wallet, concat, hashMessage, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  HOLDING_PRESENTATION_FIELDS,
  HOLDING_PRESENTATION_MAX_SECS,
  TICKET_HOLDING_FIELDS,
  checkHoldingPresentation,
  holdingLeaf,
  holdingPresentationStatement,
  holdingRoot,
  recoverTicketHoldingSigner,
  signHoldingPresentation,
  signTicketHolding,
  ticketHoldingDigest,
  ticketHoldingStatement,
} from "../../src/holding/receipt.js";
import { holdingAnswerKey, holdingHolderKey } from "../../src/holding/derive.js";
import { buildTicketCanonicalMessage } from "../../src/ticket/canonical.js";
import { AUDIENCE, BURNER_KEY, CONTEXT, EVENT_ID, G, HOLDING, PRESENTATION, R, SLOT, T0, TARGET } from "./vectors.js";

const typeString = (name: string, fields: readonly { name: string; type: string }[]) =>
  `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;

/** The secp256k1 group order. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const burnerAddress = new Wallet(`0x${bytesToHex(BURNER_KEY)}`).address.toLowerCase();

test("type strings, exactly as the spec freezes them", () => {
  assert.equal(
    typeString("TicketHolding", TICKET_HOLDING_FIELDS),
    "TicketHolding(bytes32 eventId,uint256 slot,address holder,address answerKey,bytes32 nkCommit)",
  );
  assert.equal(
    typeString("HoldingPresentation", HOLDING_PRESENTATION_FIELDS),
    "HoldingPresentation(bytes32 receipt,address audience,bytes32 context,uint64 issuedAt,uint64 expiresAt)",
  );
});

test("receipt digest and signature: golden, equal to ethers, recoverable", async () => {
  const s = ticketHoldingStatement(TARGET, HOLDING);
  assert.deepEqual(s.domain, { name: "WoCo Ticket Holding", version: "1", chainId: 42161, verifyingContract: TARGET.ledger });
  assert.equal(TypedDataEncoder.hash(s.domain, { TicketHolding: [...s.fields] }, s.message), G.receiptDigest);
  assert.equal(ticketHoldingDigest(TARGET, HOLDING), G.receiptDigest);
  const sig = signTicketHolding(TARGET, HOLDING, BURNER_KEY);
  assert.equal(sig, G.receiptSig);
  const wallet = new Wallet(`0x${bytesToHex(BURNER_KEY)}`);
  assert.equal(await wallet.signTypedData(s.domain, { TicketHolding: [...s.fields] }, s.message), G.receiptSig);
  assert.equal(verifyTypedData(s.domain, { TicketHolding: [...s.fields] }, s.message, sig).toLowerCase(), burnerAddress);
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, sig), burnerAddress);
});

test("the domain binds chain and ledger, and every field is signed", () => {
  const base = ticketHoldingDigest(TARGET, HOLDING);
  assert.notEqual(ticketHoldingDigest({ ...TARGET, chainId: 8453 }, HOLDING), base);
  assert.notEqual(ticketHoldingDigest({ ...TARGET, ledger: `0x${"00".repeat(19)}01` }, HOLDING), base);
  const flipLastHex = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, eventId: flipLastHex(EVENT_ID) }), base);
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, slot: SLOT + 1 }), base);
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, holder: flipLastHex(HOLDING.holder) }), base);
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, answerKey: flipLastHex(HOLDING.answerKey) }), base);
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, nkCommit: flipLastHex(HOLDING.nkCommit) }), base);
  // holder and answer key swapped is a different receipt
  assert.notEqual(ticketHoldingDigest(TARGET, { ...HOLDING, holder: HOLDING.answerKey, answerKey: HOLDING.holder }), base);
});

test("non-canonical signatures recover to nobody: high-s, v 0/1, wrong length", () => {
  const raw = hexToBytes(G.receiptSig.slice(2));
  const s = BigInt(`0x${bytesToHex(raw.slice(32, 64))}`);
  const highS = SECP256K1_N - s;
  const twin = raw.slice();
  twin.set(hexToBytes(highS.toString(16).padStart(64, "0")), 32);
  twin[64] = raw[64] === 27 ? 28 : 27;
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, `0x${bytesToHex(twin)}`), null);
  const v0 = raw.slice();
  v0[64] = raw[64]! - 27;
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, `0x${bytesToHex(v0)}`), null);
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, G.receiptSig.slice(0, -2)), null);
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, G.receiptSig.toUpperCase()), null);
  assert.equal(recoverTicketHoldingSigner(TARGET, HOLDING, 42), null);
});

test("malformed receipts and targets are refused, not hashed", () => {
  assert.throws(() => ticketHoldingDigest(TARGET, { ...HOLDING, holder: HOLDING.holder.toUpperCase().replace("0X", "0x") }));
  assert.throws(() => ticketHoldingDigest(TARGET, { ...HOLDING, slot: -1 }));
  assert.throws(() => ticketHoldingDigest(TARGET, { ...HOLDING, eventId: "0xab" }));
  assert.throws(() => ticketHoldingDigest({ ...TARGET, chainId: 0 }, HOLDING));
  assert.throws(() => ticketHoldingDigest({ ...TARGET, ledger: TARGET.ledger.toUpperCase() }, HOLDING));
  assert.equal(recoverTicketHoldingSigner(TARGET, { ...HOLDING, slot: -1 }, G.receiptSig), null);
});

test("presentation: golden, equal to ethers, signed by the answer key", async () => {
  const s = holdingPresentationStatement(TARGET, PRESENTATION);
  assert.equal(TypedDataEncoder.hash(s.domain, { HoldingPresentation: [...s.fields] }, s.message), G.presentationDigest);
  const answer = holdingAnswerKey(R, 0);
  const sig = signHoldingPresentation(TARGET, PRESENTATION, answer.privateKey);
  assert.equal(sig, G.presentationSig);
  assert.equal(await new Wallet(`0x${bytesToHex(answer.privateKey)}`).signTypedData(s.domain, { HoldingPresentation: [...s.fields] }, s.message), sig);
});

test("presentation checks: accepted, and each way it is refused", () => {
  assert.equal(HOLDING_PRESENTATION_MAX_SECS, 30 * 24 * 60 * 60);
  const base = {
    target: TARGET,
    receipt: HOLDING,
    presentation: PRESENTATION,
    signature: G.presentationSig,
    expectedAudience: AUDIENCE,
    expectedContext: CONTEXT,
    nowSecs: T0 + 10,
  };
  assert.deepEqual(checkHoldingPresentation(base), { ok: true });
  assert.deepEqual(checkHoldingPresentation({ ...base, expectedAudience: AUDIENCE.toUpperCase().replace("0X", "0x") }), { ok: true });
  const refused = (over: Partial<typeof base>) => {
    const r = checkHoldingPresentation({ ...base, ...over });
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(refused({ receipt: { ...HOLDING, slot: SLOT + 1 } }), "not-this-receipt");
  assert.equal(refused({ expectedAudience: `0x${"33".repeat(20)}` }), "wrong-audience");
  assert.equal(refused({ expectedContext: `0x${"ce".repeat(32)}` }), "wrong-context");
  assert.equal(refused({ nowSecs: T0 - 1 }), "not-yet-valid");
  assert.equal(refused({ nowSecs: T0 + 86_401 }), "expired");
  assert.equal(refused({ presentation: { ...PRESENTATION, expiresAt: T0 + HOLDING_PRESENTATION_MAX_SECS + 1 } }), "window-too-long");
  assert.equal(refused({ presentation: { ...PRESENTATION, expiresAt: T0 } }), "window-too-long");
  assert.equal(refused({ presentation: { ...PRESENTATION, audience: "0xnope" } }), "malformed");
  // the holder key must never be what signs a presentation
  const byHolder = signHoldingPresentation(TARGET, PRESENTATION, holdingHolderKey(R, 0).privateKey);
  assert.equal(refused({ signature: byHolder }), "wrong-signer");
  assert.equal(refused({ signature: "0x00" }), "wrong-signer");
  assert.throws(() => signHoldingPresentation(TARGET, { ...PRESENTATION, expiresAt: T0 + HOLDING_PRESENTATION_MAX_SECS + 1 }, BURNER_KEY));
  // A broken clock never passes the time checks.
  assert.equal(refused({ nowSecs: Number.NaN }), "malformed");
  assert.equal(refused({ nowSecs: undefined as unknown as number }), "malformed");
  assert.equal(refused({ nowSecs: Number.POSITIVE_INFINITY }), "malformed");
});

test("presentation edges: valid at its first and last second, and over exactly 30 days", () => {
  const base = {
    target: TARGET,
    receipt: HOLDING,
    presentation: PRESENTATION,
    signature: G.presentationSig,
    expectedAudience: AUDIENCE,
    expectedContext: CONTEXT,
  };
  assert.deepEqual(checkHoldingPresentation({ ...base, nowSecs: PRESENTATION.issuedAt }), { ok: true });
  assert.deepEqual(checkHoldingPresentation({ ...base, nowSecs: PRESENTATION.expiresAt }), { ok: true });
  const month = { ...PRESENTATION, expiresAt: T0 + HOLDING_PRESENTATION_MAX_SECS };
  const sig = signHoldingPresentation(TARGET, month, holdingAnswerKey(R, 0).privateKey);
  assert.deepEqual(checkHoldingPresentation({ ...base, presentation: month, signature: sig, nowSecs: month.expiresAt }), { ok: true });
});

test("five messages about one slot never share a digest", () => {
  const door = hashMessage(buildTicketCanonicalMessage({ onChainEventId: EVENT_ID, seriesId: "series-1", edition: SLOT + 1 }));
  const ledger = (version: string) => ({ name: "WoCoTicketLedger", version, chainId: TARGET.chainId, verifyingContract: TARGET.ledger });
  const transfer = TypedDataEncoder.hash(
    ledger("2"),
    { TransferSlot: [
      { name: "eventId", type: "bytes32" }, { name: "slot", type: "uint256" }, { name: "from", type: "address" },
      { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    { eventId: EVENT_ID, slot: SLOT, from: burnerAddress, to: HOLDING.holder, nonce: 0, deadline: T0 },
  );
  const handover = TypedDataEncoder.hash(
    ledger("3"),
    { HandoverSlot: [
      { name: "eventId", type: "bytes32" }, { name: "slot", type: "uint256" }, { name: "from", type: "address" },
      { name: "to", type: "address" }, { name: "epoch", type: "uint256" },
    ] },
    { eventId: EVENT_ID, slot: SLOT, from: burnerAddress, to: HOLDING.holder, epoch: 0 },
  );
  const all = [door, G.receiptDigest, G.presentationDigest, transfer, handover];
  assert.equal(new Set(all).size, all.length);
});

test("v3 fingerprint: golden leaves and root, equal to an ethers ABI encoding", () => {
  const leaves = [0, 1, 2].map((i) => holdingLeaf(G.holders[i]!, G.answerKeys[i]!, G.nkCommit));
  assert.deepEqual(leaves, G.leaves);
  const tag = keccak256(toUtf8Bytes("woco/holding/v1/leaf"));
  for (let i = 0; i < 3; i++) {
    const enc = AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "address", "bytes32"], [tag, G.holders[i], G.answerKeys[i], G.nkCommit]);
    assert.equal(keccak256(enc), G.leaves[i]);
  }
  assert.equal(holdingRoot(leaves), G.root);
  assert.equal(keccak256(concat(G.leaves)), G.root);
  assert.notEqual(holdingRoot([leaves[1]!, leaves[0]!, leaves[2]!]), G.root);
  assert.notEqual(holdingRoot(leaves.slice(0, 2)), G.root);
  assert.throws(() => holdingRoot([]));
  assert.throws(() => holdingRoot(new Array(101).fill(leaves[0])));
  assert.throws(() => holdingLeaf(G.holders[0]!.toUpperCase().replace("0X", "0x"), G.answerKeys[0]!, G.nkCommit));
});
