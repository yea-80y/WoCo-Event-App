// ---------------------------------------------------------------------------
// Loyalty milestone issuance (Step 4, item C) — mint a badge POD to a buyer's
// wallet when their cumulative PAID spend crosses a configured threshold.
//
// Spend is derived from the order feed (no stored ledger). Badges are on-chain
// PODs, so issuance needs a WALLET: the crypto + spend-permission rails bind one
// (buyerRef = payer / Kernel address); card buyers (email-hash buyerRef) earn
// points only and get no on-chain badge until they connect a wallet — the locked
// loyalty decision (card earns, crypto is the portable/trustless tier).
//
// Always fire-and-forget from the paid-flip: a badge-mint hiccup must never fail
// a settled order.
// ---------------------------------------------------------------------------

import { keccak256, toUtf8Bytes } from "ethers";
import type { Shop, Order, Hex0x } from "@woco/shared";
import { crossedThresholds, paidSpendMinor, moneyToMinor } from "@woco/shared";
import { getOrders } from "./service.js";
import { getOnChainHolding } from "../pod/holdings.js";
import { claimForOnChain } from "../chain/sponsor-wallet.js";
import { getActiveChainId } from "../chain/event-contract.js";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

// Per-(wallet|badge) serialization. Two concurrent paid orders for the same
// buyer crossing the same threshold could both see count==0 and double-mint;
// the lock makes the holdings dedup authoritative within the process.
const awardLocks = new Map<string, Promise<unknown>>();
function withAwardLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = awardLocks.get(key) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(fn);
  awardLocks.set(key, task.catch(() => undefined));
  return task as Promise<T>;
}

/**
 * Award any spend-milestone badges this order's payment unlocked for `buyerWallet`.
 * No-op unless loyalty is enabled, the buyer is a wallet, and a threshold was
 * crossed. Dedups against the trustless on-chain holding (soulbound → holding ≥1
 * means already awarded). Each badge is independent; one failing doesn't block
 * the others.
 */
export async function awardSpendMilestones(shop: Shop, order: Order, buyerWallet: string): Promise<void> {
  const cfg = shop.loyalty;
  if (!cfg?.enabled || !cfg.spendThresholds?.length) return;
  // Wallet-only: card/email-hash buyers earn points (derived) but no on-chain badge.
  if (!WALLET_RE.test(buyerWallet)) return;
  const wallet = buyerWallet.toLowerCase() as Hex0x;

  // Cumulative paid spend INCLUDING this just-flipped order (it's in the feed),
  // and the prior total (before it) — the crossing is the window between them.
  const orders = await getOrders(shop.shopId);
  const currentMinor = paidSpendMinor(orders, wallet);
  const priorMinor = Math.max(0, currentMinor - moneyToMinor(order.total));

  const crossed = crossedThresholds(priorMinor, currentMinor, cfg.spendThresholds);
  if (crossed.length === 0) return;

  const activeChain = getActiveChainId();
  for (const reward of crossed) {
    // claimForOnChain mints on the active chain; a badge registered elsewhere
    // can't be minted by this primitive — skip rather than mis-mint.
    if (reward.chainId !== activeChain) {
      console.warn(`[loyalty] badge ${reward.badgeManifestRef.slice(0, 10)}… on chain ${reward.chainId} != active ${activeChain} — skipped`);
      continue;
    }
    const lockKey = `${wallet}:${reward.badgeManifestRef.toLowerCase()}`;
    await withAwardLock(lockKey, async () => {
      try {
        const holding = await getOnChainHolding({
          holder: wallet,
          onChainEventId: reward.badgeEventId,
          chainId: reward.chainId,
          manifestRef: reward.badgeManifestRef,
        });
        if (holding.count > 0) return; // already awarded (soulbound)

        // Deterministic, unique per (shop, order, badge) — collision-free orderRef.
        const orderRef = keccak256(
          toUtf8Bytes(`woco-loyalty-v1:${shop.shopId}:${order.orderId}:${reward.badgeManifestRef}`),
        );
        const slot = await claimForOnChain(reward.badgeEventId, wallet, orderRef);
        console.log(
          `[loyalty] minted "${reward.badgeName ?? reward.badgeManifestRef.slice(0, 10)}" → ${wallet} ` +
          `slot=${slot} (crossed ${reward.threshold} ${order.currency})`,
        );
      } catch (err) {
        console.error(`[loyalty] badge mint failed (${reward.badgeManifestRef.slice(0, 10)}… → ${wallet}):`, err);
      }
    });
  }
}
