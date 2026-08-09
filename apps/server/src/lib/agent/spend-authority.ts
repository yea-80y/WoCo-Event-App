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
 * stronger guarantee.
 *
 * Only Arbitrum Sepolia (421614) — the locked Kernel/paymaster chain.
 */

import type { Hex0x, PaymentChainId, SealedBox, ClaimedTicket } from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";

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

export type SettleResult =
  | { ok: true; ticket: ClaimedTicket; settlementTxHash: string }
  | { ok: false; error: string; code: 400 | 402 | 403 | 404 | 409 | 502 };

/**
 * RETIRED. The agent rail settled by minting through the v1 Swarm rail
 * (`claimTicket`), which no longer exists — so a verified draw could move the
 * buyer's USDC and mint nothing. Refuse before verifying or consuming
 * anything: the draw tx is NOT consumed, so it stays bindable to a future
 * settlement path. Unreachable while `agentCommerceAllowed` is false; this
 * guard is for the day the flag flips back before a v2 mint path (claimFor
 * keyed by the paying Kernel — a new design, see the v1-retirement handover)
 * exists. The deleted verification invariants worth carrying into that
 * design: USDC Transfer LOG proof (never tx.from — 4337 bundler), intent
 * freshness against block timestamp, one-shot draw-tx consumption.
 */
export async function settleAgentTicketPurchase(_opts: SettleAgentPurchaseOpts): Promise<SettleResult> {
  return {
    ok: false,
    error:
      "Agent purchases cannot be settled: the ticket mint path has been retired. " +
      "The draw has not been consumed.",
    code: 409,
  };
}
