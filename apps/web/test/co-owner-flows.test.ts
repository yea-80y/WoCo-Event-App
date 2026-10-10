/**
 * The co-owner flows (#746) against a fake chain - executable, not source pins (Fable
 * sign-off SHOULD-6): what a record failure undoes, what it never undoes, a loud undo
 * failure, one list change for several removals, and never the last passkey.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCoOwnerWithRecord, removeCoOwners, type CoOwnerHost } from "../src/lib/auth/co-owner-flows.js";
import { signerFromRead, NOT_ON_LIST, LAST_PASSKEY_MESSAGE } from "../src/lib/auth/co-owner-calls.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const SELF = a(1);

function host(start: { root: "ecdsa" | "weighted"; list: string[] }, opts: { failSetOn?: number } = {}) {
  const state = { ...start, list: [...start.list] };
  const writes: string[][] = [];
  let sets = 0;
  const h: CoOwnerHost = {
    ensureKernel: async () => {},
    kernel: () => ({ address: a(99) }) as never,
    self: () => SELF,
    parent: () => a(99),
    dropKernel: () => {},
    lockedMessage: () => "locked",
    chain: {
      readKernelRoot: async () => state.root,
      readCoOwners: async () => (state.root === "weighted" ? [...state.list] : null),
      setCoOwners: async (_k, _root, signers) => {
        sets++;
        if (opts.failSetOn === sets) throw new Error("chain refused");
        writes.push([...signers]);
        state.root = "weighted";
        state.list = [...signers];
      },
    },
  };
  return { h, state, writes };
}

test("the first add switches with [self, new]; a failed record takes the new key off again", async () => {
  const { h, state, writes } = host({ root: "ecdsa", list: [SELF] });
  await assert.rejects(addCoOwnerWithRecord(h, a(2), async () => { throw new Error("record refused"); }), { message: "record refused" });
  assert.deepEqual(writes[0].sort(), [SELF, a(2)].sort(), "switched with both");
  assert.deepEqual(state.list, [SELF], "and the new one taken off again");
});

test("a key already on the list is never taken off by a failed record", async () => {
  const { h, state, writes } = host({ root: "weighted", list: [SELF, a(2)] });
  await assert.rejects(addCoOwnerWithRecord(h, a(2), async () => { throw new Error("record refused"); }));
  assert.equal(writes.length, 0, "nothing written: it was already listed");
  assert.deepEqual(state.list.sort(), [SELF, a(2)].sort());
});

test("an undo that fails says the key may still have access", async () => {
  const { h, state } = host({ root: "weighted", list: [SELF] }, { failSetOn: 2 });
  await assert.rejects(addCoOwnerWithRecord(h, a(3), async () => { throw new Error("record refused"); }), /couldn't be saved\. Remove it in Your passkeys/);
  assert.ok(state.list.includes(a(3)), "still listed - which is exactly what the message says");
});

test("a successful add returns the record and keeps the key", async () => {
  const { h, state } = host({ root: "weighted", list: [SELF] });
  assert.equal(await addCoOwnerWithRecord(h, a(4), async () => "ok"), "ok");
  assert.ok(state.list.includes(a(4)));
});

test("several removals are one list change; keys not listed are ignored; never the last passkey", async () => {
  const { h, state, writes } = host({ root: "weighted", list: [SELF, a(2), a(3)] });
  await removeCoOwners(h, [a(2), a(3), a(77)]);
  assert.equal(writes.length, 1);
  assert.deepEqual(state.list, [SELF]);
  await assert.rejects(removeCoOwners(h, [SELF]), { message: LAST_PASSKEY_MESSAGE });
});

test("who controls the account, as a key's checks need it", () => {
  const base = { owner: null, weight: 0, threshold: 1 };
  assert.equal(signerFromRead({ ...base, root: "weighted", weight: 1 }, a(5)), a(5));
  assert.equal(signerFromRead({ ...base, root: "weighted", weight: 0 }, a(5)), NOT_ON_LIST);
  assert.equal(signerFromRead({ ...base, root: "weighted", weight: 1, threshold: 2 }, a(5)), NOT_ON_LIST, "under the threshold");
  assert.equal(signerFromRead({ ...base, root: "weighted", weight: 1, threshold: 0 }, a(5)), NOT_ON_LIST, "a zero threshold is no list");
  assert.equal(signerFromRead({ ...base, root: "ecdsa", owner: a(6).toUpperCase().replace("0X", "0x") }, a(5)), a(6));
  assert.equal(signerFromRead({ ...base, root: "none" }, a(5)), null, "undeployed");
  assert.equal(signerFromRead({ ...base, root: "weighted", weight: 1, owner: a(6) }, a(6)), a(6), "the dropped ECDSA storage is ignored once co-owned");
});
