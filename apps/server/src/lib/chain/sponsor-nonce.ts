/**
 * Serialised nonce management for the platform sponsor wallet.
 *
 * Every module that spends from the sponsor EOA (event register/claim, EAS
 * badges, referral relay, sub-ENS mint, Stylus keeper pokes) shares ONE key,
 * so they share one nonce sequence. Two sends that overlap — or two sends that
 * merely follow each other faster than the RPC's `pending` view updates — will
 * otherwise be handed the same nonce and one will fail NONCE_EXPIRED.
 *
 * That is not hypothetical: a `registerEvent` died with
 *   nonce too low: address 0x7b318c46…, tx: 148 state: 149
 * because nonce 148 had already been mined when ethers re-derived it. The
 * organiser saw an error, retried, and created a duplicate event.
 *
 * Two guarantees, and BOTH are needed:
 *
 *  1. A single queue per (chain, signer) across all modules. Per-module locks
 *     (which eas-campaign and stylus-aggregator each grew independently) do not
 *     exclude each other, and the money path had no lock at all.
 *
 *  2. A locally-tracked nonce, not one re-fetched per send. `getTransactionCount(
 *     addr, "pending")` lags behind freshly-mined txs on real RPCs, so a mutex
 *     alone still reissues a spent nonce. We ask the chain once, then count.
 *
 * The lock is held across build → sign → broadcast only. Confirmation waits
 * outside it, so throughput is unchanged: txs still confirm concurrently, they
 * just enter the mempool in a defined order.
 *
 * TERMINOLOGY, because it matters: this is an ACCOUNT nonce — a protocol-level
 * replay counter — not a cryptographic nonce. Reusing one cannot leak the key;
 * ethers signs with RFC-6979 deterministic `k`, so two txs at the same account
 * nonce still derive different `k` from different message digests. The blast
 * radius of getting this wrong is failed transactions and duplicated work, not
 * key compromise. It is still a money-path bug: see `isNonceError` for the
 * double-mint hazard on the retry path.
 *
 * REORGS: a reorg can un-mine a tx and leave the local counter ahead of chain
 * state. Later txs then sit pending behind the gap until the reorged tx re-lands
 * at its original nonce, which it will. Self-healing on an L2; no action needed.
 *
 * LIMITATION: per-process. Two server replicas sharing one sponsor key would
 * still race — that needs a distributed lock or a key per replica.
 */

import type { Provider, TransactionResponse } from "ethers";

/** Nonce override handed to the caller's send function. */
export interface NonceOverride {
  nonce: number;
}

/** Serialisation queue tail per (chainId, signer). */
const _queues = new Map<string, Promise<unknown>>();
/** Next nonce to use per (chainId, signer). Absent = re-sync from chain. */
const _nonces = new Map<string, number>();

const keyOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

/**
 * True ONLY for failures where the node definitively REJECTED our transaction,
 * so it is not in the mempool and re-sending it under a corrected nonce runs
 * the action exactly once.
 *
 * The safety rule this encodes: never auto-retry a transaction that might still
 * be in flight. A retry re-signs the same call under a NEW nonce, so if the
 * original were pending, both would mine and the action would execute TWICE —
 * a double-mint on `batchClaimFor`, a duplicate registration on `registerEvent`.
 *
 *   nonce too low / NONCE_EXPIRED    rejected; the nonce was already consumed
 *                                    by a different tx    → retry is safe
 *   replacement underpriced          rejected; a different tx holds our nonce
 *                                    and we did not outbid it → retry is safe
 *   "already known"                  ACCEPTED — the identical tx is pending and
 *                                    WILL mine → retrying double-executes.
 *                                    Deliberately NOT matched here.
 *
 * "already known" therefore falls through to the non-nonce branch: the caller
 * gets an error even though the tx will land. That false negative is the
 * correct direction to fail on a money path — a caller retrying a level up is
 * recoverable, a double-mint is not.
 */
function isNonceError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; info?: { error?: { message?: string } } };
  const msg = `${e?.message ?? ""} ${e?.info?.error?.message ?? ""}`.toLowerCase();

  // Checked before the code test: ethers reports some "already known" responses
  // under a generic nonce code, and in-flight always wins over the code.
  if (msg.includes("already known")) return false;

  if (e?.code === "NONCE_EXPIRED" || e?.code === "REPLACEMENT_UNDERPRICED") return true;
  return (
    msg.includes("nonce too low") ||
    msg.includes("nonce has already been used") ||
    msg.includes("replacement transaction underpriced")
  );
}

/** Run `fn` after every previously-queued send for `key` has broadcast. */
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = _queues.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous send resolved or rejected — one
  // module's failure must not wedge the queue for every other module.
  const run = tail.then(fn, fn);
  _queues.set(key, run.then(() => {}, () => {}));
  return run;
}

/** Discard the tracked nonce so the next send re-syncs from chain. */
export function resetSponsorNonce(chainId: number, address: string): void {
  _nonces.delete(keyOf(chainId, address));
}

/**
 * Broadcast a sponsor transaction with a correct, non-colliding nonce.
 *
 * `send` receives the nonce to use and must pass it straight through as the
 * ethers overrides argument, e.g.
 *
 *   const tx = await sendSponsorTx(
 *     { chainId, address: wallet.address, provider, label: "registerEvent" },
 *     (o) => contract.registerEvent(supply, manifestRef, o),
 *   );
 *   const receipt = await tx.wait(1);   // outside the lock, by design
 *
 * Resolves as soon as the tx is broadcast. The caller awaits confirmation.
 */
export async function sendSponsorTx<T extends TransactionResponse>(
  ctx: { chainId: number; address: string; provider: Provider; label: string },
  send: (overrides: NonceOverride) => Promise<T>,
): Promise<T> {
  const { chainId, address, provider, label } = ctx;
  const key = keyOf(chainId, address);

  return enqueue(key, async () => {
    let nonce = _nonces.get(key);
    if (nonce === undefined) {
      nonce = await provider.getTransactionCount(address, "pending");
      _nonces.set(key, nonce);
    }

    try {
      const tx = await send({ nonce });
      _nonces.set(key, nonce + 1);
      return tx;
    } catch (err) {
      if (!isNonceError(err)) {
        // Revert, gas-estimation failure, RPC outage: the nonce was never
        // consumed. Drop it rather than advance — advancing would leave a gap
        // that stalls every later tx until the chain catches up.
        _nonces.delete(key);
        throw err;
      }

      // Our view of the sequence is wrong (RPC lag, or a tx sent outside this
      // process). Re-sync and make exactly one more attempt; a second failure
      // is a real problem and must surface rather than spin.
      const fresh = await provider.getTransactionCount(address, "pending");
      console.warn(
        `[sponsor-nonce] ${label}: nonce ${nonce} rejected on chain ${chainId}, re-syncing to ${fresh}`,
      );
      const tx = await send({ nonce: fresh });
      _nonces.set(key, fresh + 1);
      return tx;
    }
  });
}
