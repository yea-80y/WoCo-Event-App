<script lang="ts">
  /**
   * Checkout drawer/modal for the web storefront.
   *
   * Mirrors ClaimButton's fees + checkout structure. Calls:
   *   - createOrder  → pending order (server prices it)
   *   - For card: Stripe checkout session (via api/stripe)
   *   - For crypto: fetchShopPaymentQuote → user pays on-chain → submitShopCryptoPayment
   *
   * Funds/signature flow is in shop-payment.ts — this component only calls it.
   */
  import type {
    Shop,
    FiatCurrency,
    PaymentChainId,
    ShopPaymentQuote,
    ShopPaymentBinding,
  } from "@woco/shared";
  import type { CartLine } from "./Storefront.svelte";
  import { createOrder } from "../../api/shops.js";
  import { fetchShopPaymentQuote } from "../../api/shop-payment.js";
  import { isWalletAvailable } from "../../wallet/provider.js";

  interface Props {
    shop: Shop;
    cart: CartLine[];
    onClose: () => void;
    onBump: (productId: string, delta: number) => void;
    onSuccess: (orderId: string, code: string) => void;
  }

  let { shop, cart, onClose, onBump, onSuccess }: Props = $props();

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  const toMinor = (s: string) => Math.round(Number(s) * 100);

  function money(minor: number, ccy: FiatCurrency): string {
    const sym = SYMBOLS[ccy] ?? "";
    const body = (minor / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return sym ? `${sym}${body}` : `${body} ${ccy}`;
  }

  const CARD_FEE_BP = 150;   // 1.5%
  const CRYPTO_FEE_BP = 25;  // 0.25%

  const totalMinor = $derived(cart.reduce((n, l) => n + toMinor(l.unitPrice) * l.qty, 0));
  const itemCount = $derived(cart.reduce((n, l) => n + l.qty, 0));

  type Rail = "card" | "crypto";
  let rail = $state<Rail>("card");

  const cardFeeMinor = $derived(Math.round(totalMinor * CARD_FEE_BP / 10000));
  const cryptoFeeMinor = $derived(Math.round(totalMinor * CRYPTO_FEE_BP / 10000));

  const merchantTotal = $derived(totalMinor); // buyer always pays full; fee is on merchant cut

  type Phase = "cart" | "paying" | "success" | "error";
  let phase = $state<Phase>("cart");
  let errorMsg = $state("");
  let successCode = $state("");
  let payStatus = $state("");

  /**
   * Proof of a USDC payment whose funds have ALREADY left the wallet but whose
   * server-side settlement has not yet confirmed. While this is set, retrying
   * re-submits the same proof — it must never trigger a second on-chain charge.
   */
  type PendingSettle = {
    orderId: string;
    chainId: PaymentChainId;
    quote: ShopPaymentQuote;
    txHash: string;
    binding: ShopPaymentBinding;
  };
  let pendingSettle = $state<PendingSettle | null>(null);

  /** Submit a confirmed on-chain payment for settlement. Idempotent server-side. */
  async function settleCrypto(p: PendingSettle) {
    const { submitShopCryptoPayment } = await import("../../api/shop-payment.js");
    payStatus = "Finalising order…";
    const settled = await submitShopCryptoPayment({
      shopId: shop.shopId,
      orderId: p.orderId,
      txHash: p.txHash,
      chainId: p.chainId,
      quote: p.quote,
      binding: p.binding,
    });
    successCode = settled.code;
    phase = "success";
    pendingSettle = null;
    onSuccess(settled.orderId, settled.code);
  }

  async function pay() {
    if (phase === "paying") return;
    if (!pendingSettle && cart.length === 0) return;
    phase = "paying";
    errorMsg = "";
    payStatus = "";
    try {
      // Recovery: a prior on-chain payment confirmed but settling failed — the
      // funds are already gone, so re-submit the SAME proof, never re-charge.
      if (pendingSettle) {
        await settleCrypto(pendingSettle);
        return;
      }

      const lines = cart.map((l) => ({ productId: l.productId, qty: l.qty }));
      const order = await createOrder(shop.shopId, { lines, rail });

      if (rail === "card") {
        // Stripe checkout — dynamic import to keep bundle lean
        const { createShopCheckout } = await import("../../api/stripe.js");
        const { url } = await createShopCheckout(shop.shopId, order.orderId, window.location.href);
        window.location.href = url;
        return;
      }

      // Crypto path — fetch the server-signed quote, transfer the EXACT quoted
      // USDC amount on-chain (with EIP-712 payer binding), then settle the order.
      // The amount comes solely from the signed quote; we never re-derive it.
      if (!isWalletAvailable()) {
        throw new Error("Connect a wallet to pay with USDC, or use card instead.");
      }
      const chainId = (shop.payment.acceptedChains?.[0] ?? 421614) as PaymentChainId;
      const quote = await fetchShopPaymentQuote({ shopId: shop.shopId, orderId: order.orderId, chainId });

      const { payShopUSDC } = await import("../../payment/shop-usdc-pay.js");
      const { txHash, binding } = await payShopUSDC({
        quote,
        onProgress: (ev) => {
          if (ev.phase === "switch-chain") payStatus = "Switching network…";
          else if (ev.phase === "sign-binding") payStatus = "Authorise in your wallet…";
          else if (ev.phase === "send-tx") payStatus = "Confirm the USDC payment…";
          else if (ev.phase === "waiting-confirmations") payStatus = `Confirming on-chain… ${ev.current ?? 0}/${ev.total ?? ""}`;
          else if (ev.phase === "confirmed") payStatus = "Confirmed";
        },
      });

      // Funds have left the wallet — pin the proof so any settle failure resolves
      // by re-submitting (settleCrypto), not by charging again. Use quote.chainId
      // as authoritative.
      pendingSettle = { orderId: order.orderId, chainId: quote.chainId, quote, txHash, binding };
      await settleCrypto(pendingSettle);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Payment failed";
      phase = "error";
    } finally {
      payStatus = "";
    }
  }

  function retry() {
    errorMsg = "";
    payStatus = "";
    // If funds already moved, re-submit the pinned proof (never re-charge);
    // otherwise return to the cart for a fresh attempt.
    if (pendingSettle) {
      void pay();
    } else {
      phase = "cart";
    }
  }
</script>

<!-- backdrop -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onClose()}></div>

<div class="drawer" role="dialog" aria-modal="true" aria-label="Cart">
  <div class="drawer-head">
    <span class="kicker">Your order · {itemCount} item{itemCount !== 1 ? "s" : ""}</span>
    <button class="close" onclick={onClose} aria-label="Close cart">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
        <path d="M2 2l10 10M12 2L2 12" />
      </svg>
    </button>
  </div>

  {#if phase === "success"}
    <div class="success">
      <span class="ok-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
          <path d="M3.5 10.5l4 4 9-9" />
        </svg>
      </span>
      <span class="kicker">Order confirmed</span>
      <span class="pickup-code mono">{successCode}</span>
      <p class="pickup-hint">Show this code to collect your order.</p>
      <button class="btn btn--ghost" onclick={onClose}>Done</button>
    </div>

  {:else}
    <!-- line items -->
    <div class="lines">
      {#each cart as l (l.productId)}
        <div class="line">
          <div class="l-name">{l.name}</div>
          <div class="stepper">
            <button onclick={() => onBump(l.productId, -1)} aria-label="Remove one">–</button>
            <span class="mono">{l.qty}</span>
            <button onclick={() => onBump(l.productId, 1)} aria-label="Add one">+</button>
          </div>
          <span class="l-amt mono">
            {money(toMinor(l.unitPrice) * l.qty, shop.currency)}
          </span>
        </div>
      {/each}
    </div>

    <!-- rail picker -->
    <div class="rail-pick">
      <span class="kicker kicker--plain">Pay with</span>
      <div class="rail-btns">
        <button
          class="rail-btn"
          class:active={rail === "card"}
          onclick={() => { rail = "card"; }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><rect x="1" y="3" width="11" height="7" /><path d="M1 6h11" /></svg>
          Card
        </button>
        <button
          class="rail-btn"
          class:active={rail === "crypto"}
          onclick={() => { rail = "crypto"; }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><circle cx="6.5" cy="6.5" r="5.5" /><path d="M6.5 3v7M4.5 4.5h3a1.5 1.5 0 010 3h-3 3a1.5 1.5 0 010 3h-3" /></svg>
          USDC
        </button>
      </div>
    </div>

    <!-- fees -->
    <div class="fees">
      <div class="fee-row">
        <span>Subtotal</span>
        <span class="mono">{money(merchantTotal, shop.currency)}</span>
      </div>
      {#if rail === "card"}
        <div class="fee-row fee-note">
          <span>Platform fee (1.5% — absorbed by merchant)</span>
          <span class="mono">–{money(cardFeeMinor, shop.currency)}</span>
        </div>
      {:else}
        <div class="fee-row fee-note">
          <span>Platform fee (0.25% — absorbed by merchant)</span>
          <span class="mono">–{money(cryptoFeeMinor, shop.currency)}</span>
        </div>
      {/if}
      <div class="fee-row fee-total">
        <span>You pay</span>
        <span class="mono">{money(merchantTotal, shop.currency)}</span>
      </div>
    </div>

    {#if phase === "error"}
      <div class="err-box mono">{errorMsg}</div>
    {/if}

    <button
      class="btn btn--primary pay-btn"
      onclick={phase === "error" ? retry : pay}
      disabled={phase === "paying" || (cart.length === 0 && !pendingSettle)}
    >
      {#if phase === "paying"}
        {payStatus || "Processing…"}
      {:else if phase === "error"}
        Try again
      {:else if rail === "card"}
        Pay {money(merchantTotal, shop.currency)} by card
      {:else}
        Pay {money(merchantTotal, shop.currency)} with USDC
      {/if}
    </button>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 48;
    background: rgba(0, 0, 0, 0.6);
    animation: fadein 0.15s ease;
  }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  .drawer {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 49;
    max-width: 520px; margin: 0 auto;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    padding: 0 0 env(safe-area-inset-bottom, 0);
    animation: slideup 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    display: flex; flex-direction: column;
    max-height: 90dvh; overflow-y: auto;
  }
  @keyframes slideup {
    from { transform: translateY(100%); }
    to { transform: none; }
  }

  .drawer-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1.125rem 0.875rem;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-surface); z-index: 1;
  }
  .kicker {
    font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  .kicker--plain { letter-spacing: 0.08em; }
  .close {
    width: 1.75rem; height: 1.75rem; display: grid; place-items: center;
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .close:hover { color: var(--text); background: var(--bg-surface-hover); }

  /* ── line items ── */
  .lines { padding: 0.375rem 0; border-bottom: 1px solid var(--border); }
  .line {
    display: grid; grid-template-columns: 1fr auto auto;
    align-items: center; gap: 0.75rem;
    padding: 0.625rem 1.125rem;
    border-bottom: 1px solid var(--border);
  }
  .line:last-child { border-bottom: none; }
  .l-name { font-size: 0.875rem; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l-amt { font-size: 0.875rem; font-weight: 600; color: var(--text); min-width: 3.5rem; text-align: right; }

  .stepper { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .stepper button { width: 1.5rem; height: 1.5rem; background: none; border: none; color: var(--text-secondary); font-size: 1rem; line-height: 1; cursor: pointer; }
  .stepper button:hover { color: var(--accent-text); }
  .stepper .mono { min-width: 1.5rem; text-align: center; font-size: 0.8125rem; font-weight: 600; color: var(--text); font-family: var(--font-mono); }

  /* ── rail picker ── */
  .rail-pick {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.75rem 1.125rem;
    border-bottom: 1px solid var(--border);
  }
  .rail-btns { display: flex; gap: 0.375rem; }
  .rail-btn {
    display: inline-flex; align-items: center; gap: 0.375rem;
    padding: 0.3125rem 0.75rem;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-sm); font-size: 0.75rem; font-weight: 500;
    color: var(--text-secondary); cursor: pointer; transition: border-color 0.1s, color 0.1s, background 0.1s;
  }
  .rail-btn:hover { border-color: var(--border-hover); color: var(--text); }
  .rail-btn.active { border-color: var(--accent); color: var(--text); background: var(--bg-surface); }

  /* ── fees ── */
  .fees { padding: 0.75rem 1.125rem; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.375rem; }
  .fee-row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; font-size: 0.8125rem; color: var(--text-secondary); }
  .fee-row .mono { font-family: var(--font-mono); font-size: 0.8125rem; }
  .fee-note { color: var(--text-muted); font-size: 0.75rem; }
  .fee-total { color: var(--text); font-weight: 600; padding-top: 0.375rem; border-top: 1px solid var(--border); margin-top: 0.125rem; }
  .fee-total .mono { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; }

  /* ── pay button ── */
  .pay-btn { width: calc(100% - 2.25rem); margin: 0.875rem 1.125rem; justify-content: center; font-size: 0.9375rem; }

  /* ── error ── */
  .err-box {
    background: var(--error-subtle); color: var(--error);
    border: 1px solid var(--error); border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem; font-size: 0.6875rem;
    margin: 0 1.125rem;
  }

  /* ── success ── */
  .success {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    padding: 2rem 1.5rem;
    gap: 0.5rem;
  }
  .ok-mark {
    width: 3rem; height: 3rem; display: grid; place-items: center;
    background: var(--accent); color: var(--accent-ink);
    border-radius: var(--radius-md); margin-bottom: 0.375rem;
  }
  .pickup-code {
    font-size: 2.5rem; font-weight: 700; color: var(--accent-text);
    letter-spacing: 0.06em; line-height: 1;
    margin: 0.25rem 0;
  }
  .pickup-hint { color: var(--text-muted); font-size: 0.8125rem; margin: 0 0 0.875rem; }
</style>
