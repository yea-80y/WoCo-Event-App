/**
 * Moving the account's events onto its new organiser key at a passkey removal (#186,
 * ledger v2): the call the app builds, and the flows that carry it - in the removal's
 * own op (with the list change, or with the ring alone) or in an op of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";
import { organiserKeyMoveCall, CoOwnerListError, type OrganiserKeyMove } from "../src/lib/auth/co-owner-calls.js";
import { removeCoOwnersWithRing, moveOrganiserKey, type CoOwnerHost } from "../src/lib/auth/co-owner-flows.js";

const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const SELF = a(1);
const LEDGER = "0x" + "1E".repeat(20);
const KEY = "0x" + "0E".repeat(20);
const ID = "0x" + "AB".repeat(32);
const MOVE: OrganiserKeyMove = { ledger: LEDGER, ids: [ID], key: KEY };

test("the call: setOrganiserKey on the ledger, every value lowercased, nothing sent", () => {
  const c = organiserKeyMoveCall(enc, MOVE);
  assert.equal(c.to, LEDGER.toLowerCase());
  assert.equal(c.value, 0n);
  const d = decodeFunctionData({ abi: parseAbi(["function setOrganiserKey(bytes32[] eventIds, address key)"]), data: c.data });
  assert.equal(d.functionName, "setOrganiserKey");
  const [ids, key] = d.args as readonly [readonly string[], string];
  assert.deepEqual(ids, [ID.toLowerCase()]);
  // viem decodes an address checksummed: compare the value, not its case.
  assert.equal(key.toLowerCase(), KEY.toLowerCase());
});

test("the call: never built for a move the policy would refuse", () => {
  const bad: OrganiserKeyMove[] = [
    { ledger: LEDGER, ids: [], key: KEY },
    { ledger: LEDGER, ids: Array.from({ length: 51 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0")), key: KEY },
    { ledger: LEDGER, ids: [ID, ID], key: KEY },
    { ledger: LEDGER, ids: [ID], key: "0x" + "0".repeat(40) },
    { ledger: LEDGER, ids: [ID], key: LEDGER },
  ];
  for (const m of bad) assert.throws(() => organiserKeyMoveCall(enc, m), CoOwnerListError);
});

function host(start: { list: string[]; anchorAfter?: string | null }) {
  const sent: Array<{ via: string; signers?: string[]; ring?: unknown; move?: OrganiserKeyMove }> = [];
  let anchor: string | null = null;
  const h: CoOwnerHost = {
    ensureKernel: async () => {},
    kernel: () => ({ address: a(99) }) as never,
    self: () => SELF,
    parent: () => a(99),
    dropKernel: () => {},
    lockedMessage: () => "locked",
    chain: {
      readKernelRoot: async () => "weighted",
      readCoOwners: async () => [...start.list],
      setCoOwners: async (_k, _root, signers, ring, move) => {
        sent.push({ via: "list", signers: [...signers], ring, move });
        anchor = start.anchorAfter === undefined ? (ring?.next ?? null) : start.anchorAfter;
      },
      setKeyRingAlone: async (_k, ring, move) => {
        sent.push({ via: "ring", ring, move });
        anchor = start.anchorAfter === undefined ? ring.next : start.anchorAfter;
        return { confirmed: true };
      },
      setOrganiserKeyAlone: async (_k, move) => {
        sent.push({ via: "alone", move });
      },
      readRingAnchor: async () => anchor,
    },
  };
  return { h, sent };
}

const RING = { prev: null, next: "aa".repeat(32) };

test("a removal's flip carries the key move in the list change", async () => {
  const { h, sent } = host({ list: [SELF, a(2)] });
  await removeCoOwnersWithRing(h, [a(2)], RING, MOVE);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.via, "list");
  assert.deepEqual(sent[0]!.signers, [SELF]);
  assert.deepEqual(sent[0]!.move, MOVE);
});

test("passkeys another device already took off: the ring alone carries the key move", async () => {
  const { h, sent } = host({ list: [SELF] });
  await removeCoOwnersWithRing(h, [a(2)], RING, MOVE);
  assert.deepEqual(sent, [{ via: "ring", ring: RING, move: MOVE }]);
});

test("no events to move: the flip carries none", async () => {
  const { h, sent } = host({ list: [SELF, a(2)] });
  await removeCoOwnersWithRing(h, [a(2)], RING);
  assert.equal(sent[0]!.move, undefined);
});

test("a flip whose ring did not land is never reported done, key move or not", async () => {
  const { h } = host({ list: [SELF, a(2)], anchorAfter: "bb".repeat(32) });
  await assert.rejects(removeCoOwnersWithRing(h, [a(2)], RING, MOVE), /new keys didn't land/);
});

test("what the flip could not carry goes in an op of its own", async () => {
  const { h, sent } = host({ list: [SELF] });
  await moveOrganiserKey(h, MOVE);
  assert.deepEqual(sent, [{ via: "alone", move: MOVE }]);
});
