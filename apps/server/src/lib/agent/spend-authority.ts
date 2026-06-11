/**
 * Agent spend-authority — the non-custodial budget rail behind the agent
 * commerce surface (`/api/agent/*`). An autonomous agent buys EVENT tickets on
 * the user's behalf, bounded by an on-chain ZeroDev spend permission the user
 * grants directly to the AGENT's own key.
 *
 * CUSTODY MODEL (the headline — review before touching this file):
 *  - The agent holds its OWN session key. The user's Kernel grants a permission
 *    naming the agent's address as spender (ERC-7710 delegation), pinned to
 *    `USDC.transfer(organiser, ≤ceiling)`, expiring at `validUntil`, ≤ maxDraws.
 *  - The agent reconstructs that approval with its own key and draws DIRECTLY
 *    via ZeroDev. THIS SERVER NEVER HOLDS THE AGENT KEY, NEVER HOLDS FUNDS, AND
 *    NEVER DRAWS. Unlike the shop rail (server is the spender), here the server's
 *    only crypto job is READ-ONLY verification of the agent's on-chain draw plus
 *    minting the ticket. That is why this module has no spender secret.
 *  - Funds are non-custodial end to end: USDC stays in the user's Kernel until a
 *    draw moves it Kernel→organiser directly. A leaked/malicious agent key can
 *    only fire `transfer` to the pinned organiser, ≤ the per-draw ceiling, ≤ N
 *    times, before expiry — the smart account rejects anything else on-chain.
 *
 * VERIFICATION INVARIANT: we verify the USDC `Transfer` LOG (from = user Kernel),
 * NOT the outer `tx.from`. A 4337 userOp's `tx.from` is the bundler, so the
 * public claim endpoint's `tx.from === claimer` binding cannot be used here — the
 * log proof (from = exactly the user Kernel, to = organiser, exact amount) is the
 * stronger guarantee, and we mint via the internal `claimTicket()` directly.
 *
 * Only Arbitrum Sepolia (421614) — the locked Kernel/paymaster chain.
 */

import type { Hex0x, PaymentChainId, SealedBox, ClaimedTicket } from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";
import { JsonRpcProvider } from "ethers";
import { getRpcUrl, ERC20_TRANSFER_TOPIC, getMinConfirmations } from "../payment/constants.js";
import { checkAndConsumeTxHash } from "../payment/tx-registry.js";
import { claimTicket } from "../event/claim-service.js";

/** Locked rail — ZeroDev Kernel + gasless paymaster run here (Arb Sepolia). */
export const AGENT_SPEND_CHAIN_ID = 421614 as const;

/** Server-dictated scope bounds for an agent budget (the client builds its
 *  approval to match these exactly; the on-chain policy embeds them). */
export const AGENT_SPEND_WINDOW_SECONDS = 24 * 60 * 60; // 24h — one agent session
/** Largest single draw, 6-dec atomic ($100). One ticket buy must fit under this. */
export const AGENT_PER_DRAW_CEILING_ATOMIC = "100000000";
/** Largest cumulative budget a user may grant an agent, 6-dec atomic ($500). */
export const AGENT_MAX_CAP_ATOMIC = "500000000";
/** Max draws (purchases) over the window. */
export const AGENT_MAX_DRAWS = 20;

/**
 * Server-dictated bounds the user's client embeds into the spend-permission
 * approval it grants to `agentAddress`. Recipient is the ORGANISER (the only
 * address a draw may pay); spender is the agent's own address (it holds the key).
 */
export interface AgentBudgetParams {
  chainId: PaymentChainId;
  /** USDC token on `chainId` — the call policy pins `target` to this. */
  usdcAddress: Hex0x;
  /** Organiser recipient (lowercased) — the ONLY address a draw may pay. */
  recipient: Hex0x;
  /** The AGENT's own address (it holds the matching key and draws itself). */
  spenderAddress: Hex0x;
  /** Unix seconds — permission expiry (timestamp policy `validUntil`). */
  validUntil: number;
  /** Max single-draw amount, 6-dec atomic (call-policy `value` ceiling). */
  perDrawCeilingAtomic: string;
  /** Max number of draws in the window (rate-limit policy `count`). */
  maxDraws: number;
  /** Cumulative cap the user is advised to fund/intend (6-dec atomic). The
   *  on-chain policies bound per-draw/target/window; the cap is the user's
   *  intent surfaced for the grant UI (no on-chain spending-limit policy yet). */
  maxCapAtomic: string;
}

/**
 * Build the server-authoritative bounds for an agent budget targeting one
 * organiser. The user's client must embed recipient/usdc/ceiling/window/maxDraws
 * verbatim into its approval so what the agent later draws matches the policy.
 */
export function agentBudgetParams(agentAddress: Hex0x, organiserRecipient: Hex0x): AgentBudgetParams {
  const usdc = USDC_ADDRESSES[AGENT_SPEND_CHAIN_ID as PaymentChainId];
  if (!usdc) throw new Error(`USDC not configured for chain ${AGENT_SPEND_CHAIN_ID}`);
  return {
    chainId: AGENT_SPEND_CHAIN_ID as PaymentChainId,
    usdcAddress: usdc.toLowerCase() as Hex0x,
    recipient: organiserRecipient.toLowerCase() as Hex0x,
    spenderAddress: agentAddress.toLowerCase() as Hex0x,
    validUntil: Math.floor(Date.now() / 1000) + AGENT_SPEND_WINDOW_SECONDS,
    perDrawCeilingAtomic: AGENT_PER_DRAW_CEILING_ATOMIC,
    maxDraws: AGENT_MAX_DRAWS,
    maxCapAtomic: AGENT_MAX_CAP_ATOMIC,
  };
}

// ---------------------------------------------------------------------------
// On-chain verification of the agent's draw (read-only — no key, no funds).
// ---------------------------------------------------------------------------

const providers = new Map<PaymentChainId, JsonRpcProvider>();
function provider(chainId: PaymentChainId): JsonRpcProvider {
  let p = providers.get(chainId);
  if (!p) {
    p = new JsonRpcProvider(getRpcUrl(chainId), chainId, { staticNetwork: true });
    providers.set(chainId, p);
  }
  return p;
}

/**
 * Confirm the settlement tx contains a USDC `Transfer` log that is EXACTLY
 * from = userKernel, to = organiser, value = amount, at the per-chain
 * confirmation depth. Mirrors the shop rail's `verifyDrawOnChain` — log-based,
 * never the outer `tx.from` (which is the 4337 bundler). Returns the block
 * timestamp so the caller can enforce purchase-intent freshness.
 */
async function verifyUsdcTransferLog(
  chainId: PaymentChainId,
  txHash: string,
  from: string,
  to: string,
  usdcAddress: string,
  amount: bigint,
): Promise<{ ok: true; blockTimestamp: number } | { ok: false; error: string }> {
  const p = provider(chainId);
  let receipt: Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>;
  try {
    receipt = await p.waitForTransaction(txHash, getMinConfirmations(chainId), 30_000);
  } catch {
    receipt = null;
  }
  if (!receipt) return { ok: false, error: "Settlement tx not confirmed in time" };
  if (receipt.status !== 1) return { ok: false, error: "Settlement tx reverted" };

  const usdc = usdcAddress.toLowerCase();
  const fromTopic = "0x" + from.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const toTopic = "0x" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[1].toLowerCase() !== fromTopic) continue;
    if (log.topics[2].toLowerCase() !== toTopic) continue;
    if (BigInt(log.data) !== amount) continue;
    // Matched. Resolve the block timestamp for the freshness (intent) check.
    const block = await p.getBlock(receipt.blockNumber);
    if (!block) return { ok: false, error: "Settlement block not found" };
    return { ok: true, blockTimestamp: block.timestamp };
  }
  return { ok: false, error: "No matching USDC Transfer (userKernel→organiser, exact amount) in tx" };
}

// ---------------------------------------------------------------------------
// Settle — verify the agent's draw and mint the ticket to the user's Kernel.
// ---------------------------------------------------------------------------

export interface SettleAgentPurchaseOpts {
  chainId: PaymentChainId;
  /** The agent's on-chain draw tx (USDC userKernel→organiser). */
  settlementTxHash: string;
  /** The user's Kernel — funds source AND ticket recipient (claimer). Lowercased. */
  userKernel: Hex0x;
  /** Organiser recipient the draw must have paid. Lowercased. */
  organiser: Hex0x;
  /** USDC token address on `chainId`. */
  usdcAddress: Hex0x;
  /** Exact USDC amount (6-dec atomic) the ticket costs — recomputed server-side. */
  amountAtomic: string;
  eventId: string;
  seriesId: string;
  /** Unix seconds — the draw's block timestamp must be at/after this (minus a
   *  small clock-skew tolerance). The purchase-intent `issuedAt`: rejects draws
   *  that predate the intent, so a pre-existing matching transfer can't be bound. */
  notBeforeUnix: number;
  /** Optional encrypted order form payload (organiser dashboard). */
  encryptedOrder?: SealedBox;
}

/** Clock-skew tolerance (seconds) between the intent issuer and chain block time. */
const FRESHNESS_SKEW_SECONDS = 120;

export type SettleResult =
  | { ok: true; ticket: ClaimedTicket; settlementTxHash: string }
  | { ok: false; error: string; code: 400 | 402 | 403 | 404 | 409 | 502 };

/** In-flight settlement lock per draw tx — reject concurrent duplicate buys. */
const settling = new Set<string>();

/**
 * Verify the agent's on-chain draw, then mint the ticket to the user's Kernel.
 * The draw tx is one-shot (consumed in the global tx registry) so the same draw
 * can never mint two tickets. We mint via the internal `claimTicket()` directly,
 * bypassing the public claim endpoint's `tx.from === claimer` binding (invalid
 * for a 4337 payment) — the log proof here is the stronger guarantee.
 */
export async function settleAgentTicketPurchase(opts: SettleAgentPurchaseOpts): Promise<SettleResult> {
  const txHash = opts.settlementTxHash.toLowerCase();

  let amount: bigint;
  try {
    amount = BigInt(opts.amountAtomic);
  } catch {
    return { ok: false, error: "Invalid amount", code: 400 };
  }
  if (amount <= 0n) return { ok: false, error: "Amount must be positive", code: 400 };

  if (settling.has(txHash)) {
    return { ok: false, error: "Settlement already in progress for this draw", code: 409 };
  }
  settling.add(txHash);
  try {
    // 1. Verify the draw moved exactly the expected USDC userKernel→organiser.
    const verified = await verifyUsdcTransferLog(
      opts.chainId,
      txHash,
      opts.userKernel,
      opts.organiser,
      opts.usdcAddress,
      amount,
    );
    if (!verified.ok) return { ok: false, error: verified.error, code: 402 };

    // 1b. Freshness: the draw must post-date the purchase intent. A pre-existing
    //     matching transfer (older than the intent) cannot be bound to this buy.
    if (verified.blockTimestamp < opts.notBeforeUnix - FRESHNESS_SKEW_SECONDS) {
      return { ok: false, error: "Settlement tx predates the purchase intent", code: 402 };
    }

    // 2. One-shot the draw tx BEFORE minting so concurrent/replayed buys can't
    //    mint twice off the same payment. Atomic check-and-set.
    if (!checkAndConsumeTxHash(txHash)) {
      return { ok: false, error: "This draw has already been settled", code: 409 };
    }

    // 3. Mint to the user's Kernel (it funded the draw and receives the ticket).
    try {
      const ticket = await claimTicket({
        seriesId: opts.seriesId,
        identifier: { type: "wallet", address: opts.userKernel },
        encryptedOrder: opts.encryptedOrder,
        paid: true,
        via: "crypto",
      });
      const { _pendingId, ...clean } = ticket;
      void _pendingId;
      return { ok: true, ticket: clean, settlementTxHash: txHash };
    } catch (err) {
      // Funds DID move but the mint failed — surface loudly. The draw tx is
      // already consumed (charged-without-ticket); the user is owed a refund or
      // a manual mint. Rare: only "already claimed / sold out / series missing".
      console.error(`[agent/settle] mint failed after verified draw ${txHash}:`, err);
      return { ok: false, error: `Ticket mint failed after payment: ${(err as Error).message}`, code: 502 };
    }
  } finally {
    settling.delete(txHash);
  }
}
