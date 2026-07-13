/**
 * Sponsor nonce queue — the regression suite for the NONCE_EXPIRED class of
 * bug that silently duplicated an event in production (see #30/#36).
 *
 * Each test uses a distinct chainId: the queue keys state by (chainId, signer)
 * in module-level maps, so a unique chain gives a test its own clean sequence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider, TransactionResponse } from "ethers";
import { sendSponsorTx, resetSponsorNonce } from "../src/lib/chain/sponsor-nonce.js";

const ADDR = "0x7b318c46a6FDC544212ebd83335f6b7414A97925";

/** Provider stub that reports a fixed on-chain count and records every query. */
function fakeProvider(count: number) {
  const calls = { getTransactionCount: 0 };
  const provider = {
    getTransactionCount: async () => {
      calls.getTransactionCount++;
      return count;
    },
  } as unknown as Provider;
  return { provider, calls, setCount: (n: number) => (count = n) };
}

const tx = (nonce: number) => ({ nonce, hash: `0x${nonce}` }) as unknown as TransactionResponse;

/** The shape ethers throws when a nonce has already been mined. */
function nonceExpired(): Error {
  const err = new Error("nonce has already been used") as Error & { code: string };
  err.code = "NONCE_EXPIRED";
  return err;
}

test("concurrent sends get unique, sequential nonces", async () => {
  const { provider } = fakeProvider(10);
  const seen: number[] = [];

  // Fire ten sends at once — the exact condition that collided in production.
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      sendSponsorTx({ chainId: 90001, address: ADDR, provider, label: `send${i}` }, async (o) => {
        seen.push(o.nonce);
        return tx(o.nonce);
      }),
    ),
  );

  assert.deepEqual(seen, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(new Set(seen).size, 10, "no nonce reused");
});

test("the chain is queried once, not per send — immune to a lagging `pending` view", async () => {
  // Reproduces the real failure: the RPC keeps reporting 148 even after 148 is
  // mined. Anything that re-derives the nonce per send reissues 148 and dies
  // with "nonce too low: tx: 148 state: 149". A locally-tracked nonce cannot.
  const { provider, calls } = fakeProvider(148);
  const seen: number[] = [];

  for (let i = 0; i < 3; i++) {
    await sendSponsorTx({ chainId: 90002, address: ADDR, provider, label: "seq" }, async (o) => {
      seen.push(o.nonce);
      return tx(o.nonce);
    });
  }

  assert.deepEqual(seen, [148, 149, 150]);
  assert.equal(calls.getTransactionCount, 1, "nonce re-fetched from a stale RPC");
});

test("NONCE_EXPIRED re-syncs from chain and retries once", async () => {
  const { provider, setCount } = fakeProvider(5);
  const attempts: number[] = [];

  const result = await sendSponsorTx(
    { chainId: 90003, address: ADDR, provider, label: "resync" },
    async (o) => {
      attempts.push(o.nonce);
      if (attempts.length === 1) {
        setCount(9); // chain has moved on
        throw nonceExpired();
      }
      return tx(o.nonce);
    },
  );

  assert.deepEqual(attempts, [5, 9], "retried with the re-synced nonce");
  assert.equal(result.nonce, 9);

  // The re-synced value must carry forward, not revert to the stale sequence.
  const next: number[] = [];
  await sendSponsorTx({ chainId: 90003, address: ADDR, provider, label: "after" }, async (o) => {
    next.push(o.nonce);
    return tx(o.nonce);
  });
  assert.deepEqual(next, [10]);
});

test("`already known` is NEVER retried — double-mint guard", async () => {
  // "already known" means the identical signed tx is ALREADY pending and will
  // mine. Retrying re-signs the same call under a fresh nonce, so BOTH would
  // land and the action would run twice — minting a buyer's tickets twice on
  // batchClaimFor. It must surface as a failure, not a retry, even though that
  // means reporting an error for a tx that ultimately succeeds.
  const { provider } = fakeProvider(30);
  let attempts = 0;

  await assert.rejects(
    sendSponsorTx({ chainId: 90009, address: ADDR, provider, label: "batchClaimFor" }, async () => {
      attempts++;
      const err = new Error("already known") as Error & { code: string };
      err.code = "NONCE_EXPIRED"; // ethers can report it under a nonce code
      throw err;
    }),
    /already known/,
  );

  assert.equal(attempts, 1, "an in-flight tx was re-broadcast — double-mint");
});

test("a revert does not consume the nonce — no gap is left behind", async () => {
  // A gas-estimation revert never reaches the mempool, so the nonce is still
  // unspent. Advancing past it would strand every later tx behind a gap.
  const { provider } = fakeProvider(20);

  await assert.rejects(
    sendSponsorTx({ chainId: 90004, address: ADDR, provider, label: "revert" }, async () => {
      throw new Error("execution reverted: SalesClosed");
    }),
    /SalesClosed/,
  );

  const seen: number[] = [];
  await sendSponsorTx({ chainId: 90004, address: ADDR, provider, label: "next" }, async (o) => {
    seen.push(o.nonce);
    return tx(o.nonce);
  });

  assert.deepEqual(seen, [20], "nonce 20 must be reused, not skipped");
});

test("one send's failure does not wedge the queue for other modules", async () => {
  const { provider } = fakeProvider(0);

  const failing = sendSponsorTx(
    { chainId: 90005, address: ADDR, provider, label: "badge" },
    async () => {
      throw new Error("execution reverted");
    },
  );
  const following = sendSponsorTx(
    { chainId: 90005, address: ADDR, provider, label: "registerEvent" },
    async (o) => tx(o.nonce),
  );

  await assert.rejects(failing);
  const result = await following;
  assert.equal(result.nonce, 0, "the next module still gets the unspent nonce");
});

test("all modules sharing one signer share one sequence", async () => {
  // registerEvent, batchClaimFor, a badge attestation and a Stylus keeper poke
  // all spend from the same EOA. Per-module locks (which is what the code had)
  // do not exclude each other; one shared queue does.
  const { provider } = fakeProvider(100);
  const seen: number[] = [];
  const send = (label: string) =>
    sendSponsorTx({ chainId: 90006, address: ADDR, provider, label }, async (o) => {
      seen.push(o.nonce);
      return tx(o.nonce);
    });

  await Promise.all([
    send("registerEvent"),
    send("batchClaimFor"),
    send("attestJoinedBadge"),
    send("stylus.record"),
  ]);

  assert.deepEqual(seen.slice().sort((a, b) => a - b), [100, 101, 102, 103]);
  assert.equal(new Set(seen).size, 4, "cross-module nonce collision");
});

test("separate signers keep independent sequences", async () => {
  const { provider } = fakeProvider(7);
  const other = "0x0000000000000000000000000000000000000042";
  const a: number[] = [];
  const b: number[] = [];

  await sendSponsorTx({ chainId: 90007, address: ADDR, provider, label: "a" }, async (o) => {
    a.push(o.nonce);
    return tx(o.nonce);
  });
  await sendSponsorTx({ chainId: 90007, address: other, provider, label: "b" }, async (o) => {
    b.push(o.nonce);
    return tx(o.nonce);
  });

  assert.deepEqual(a, [7]);
  assert.deepEqual(b, [7], "a second signer must not inherit the first's counter");
});

test("resetSponsorNonce forces a re-sync", async () => {
  const { provider, setCount } = fakeProvider(1);
  const seen: number[] = [];
  const send = () =>
    sendSponsorTx({ chainId: 90008, address: ADDR, provider, label: "reset" }, async (o) => {
      seen.push(o.nonce);
      return tx(o.nonce);
    });

  await send();
  setCount(50);
  resetSponsorNonce(90008, ADDR);
  await send();

  assert.deepEqual(seen, [1, 50]);
});
