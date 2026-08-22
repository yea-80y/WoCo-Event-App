/**
 * Ordering owner reads (#200) — the truth table, pinned without an RPC.
 *
 * The property under test: a read is accepted or discarded by how it relates to
 * what the server already knows, and the only thing that can move the record is
 * a DIFFERENT owner from a LATER block. Everything else either confirms the
 * record or predates it.
 *
 * Every row is a case a load-balanced RPC can actually produce. The one that
 * motivated the module is "different owner, earlier block" — a replica lagging
 * behind a recovery naming the retired key — which used to be cached as current.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeOwnerRead } from "../src/lib/auth/kernel-owner-ordering.js";

const X = "0xaaaa000000000000000000000000000000000001";
const Y = "0xbbbb000000000000000000000000000000000002";

test("no record: any read is fresh and is not a rotation", () => {
  assert.deepEqual(judgeOwnerRead(undefined, { owner: X, block: 100 }), { verdict: "fresh", rotation: false });
  assert.deepEqual(judgeOwnerRead(undefined, { owner: null, block: 100 }), { verdict: "fresh", rotation: false });
});

test("same owner is fresh at ANY block — replica jitter in steady state must never refuse", () => {
  const rec = { owner: X, block: 100 };
  assert.deepEqual(judgeOwnerRead(rec, { owner: X, block: 150 }), { verdict: "fresh", rotation: false });
  assert.deepEqual(judgeOwnerRead(rec, { owner: X, block: 100 }), { verdict: "fresh", rotation: false });
  // Earlier than the record: a lagging replica that agrees with us contradicts
  // nothing. Discarding it would turn ordinary lag into 403s right after an
  // account's first observation, which is the #273 lesson in reverse.
  assert.deepEqual(judgeOwnerRead(rec, { owner: X, block: 90 }), { verdict: "fresh", rotation: false });
});

test("different owner at a LATER block is a rotation", () => {
  assert.deepEqual(judgeOwnerRead({ owner: X, block: 100 }, { owner: Y, block: 101 }), { verdict: "fresh", rotation: true });
});

test("different owner at an EARLIER block is stale — the retired key from a lagging replica", () => {
  // Record says Y was first seen at 200 (the rotation we observed). A replica
  // still at 150 names X: that answer predates what we know. Caching it would
  // hand X its access back for another cache lifetime.
  assert.deepEqual(judgeOwnerRead({ owner: Y, block: 200 }, { owner: X, block: 150 }), { verdict: "stale" });
});

test("different owner at the SAME block is stale — one block has one state", () => {
  // Two honest answers for one block cannot disagree. Withhold.
  assert.deepEqual(judgeOwnerRead({ owner: Y, block: 200 }, { owner: X, block: 200 }), { verdict: "stale" });
});

test("a null owner is never a rotation: later is fresh (caller's #208 rule refuses), earlier is stale", () => {
  const rec = { owner: X, block: 100 };
  assert.deepEqual(judgeOwnerRead(rec, { owner: null, block: 150 }), { verdict: "fresh", rotation: false });
  assert.deepEqual(judgeOwnerRead(rec, { owner: null, block: 50 }), { verdict: "stale" });
});

test("re-admission: an owner can legitimately come back, because the order is by block", () => {
  // web3auth → passkey → web3auth is two rotations at increasing blocks. A
  // "retired set" would refuse the second forever; the block order admits it.
  assert.deepEqual(judgeOwnerRead({ owner: Y, block: 200 }, { owner: X, block: 300 }), { verdict: "fresh", rotation: true });
});

test("the judgement can only withhold, never manufacture access", () => {
  // For every record/read pair, the owner returned to the caller is either the
  // read's own owner (fresh) or nothing (stale). No path yields a different
  // owner than the chain named — the record is memory, not authority.
  const owners = [X, Y, null] as const;
  for (const recOwner of [X, Y]) {
    for (const recBlock of [100, 200]) {
      for (const owner of owners) {
        for (const block of [50, 100, 150, 200, 250]) {
          const j = judgeOwnerRead({ owner: recOwner, block: recBlock }, { owner, block });
          if (j.verdict === "fresh") {
            // fresh → the caller acts on `owner` itself; rotation only when it differs at a later block
            assert.equal(j.rotation, owner !== null && owner !== recOwner && block > recBlock);
          } else {
            // stale → only ever for a disagreeing read no later than the record
            assert.ok(owner !== recOwner && block <= recBlock, `stale verdict for ${owner}@${block} vs ${recOwner}@${recBlock}`);
          }
        }
      }
    }
  }
});
