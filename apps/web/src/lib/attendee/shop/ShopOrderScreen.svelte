<script lang="ts">
  /**
   * Post-Stripe shop order confirmation / cancellation page.
   *
   * Stripe redirects to /#/shop/{shopId}/order/{code}?stripe=success (or
   * ?stripe=cancelled).  We render optimistically from the URL — no polling
   * dependency on the webhook. The pickup `code` is in the path so it renders
   * on first paint. Shop name loaded best-effort for context.
   */
  import { onMount } from "svelte";
  import { getShop } from "../../api/shops.js";
  import type { Shop } from "@woco/shared";

  interface Props {
    shopId: string;
    code: string;
  }
  let { shopId, code }: Props = $props();

  let shop = $state<Shop | null>(null);

  // Read ?stripe= from hash query without a full router dependency.
  const hashQuery = typeof window !== "undefined"
    ? new URLSearchParams(window.location.hash.split("?")[1] ?? "")
    : new URLSearchParams();
  const stripeOutcome = hashQuery.get("stripe"); // "success" | "cancelled" | null

  const isSuccess = stripeOutcome !== "cancelled";

  onMount(async () => {
    try {
      shop = await getShop(shopId);
    } catch { /* non-fatal */ }
  });

  function goBack() {
    window.history.back();
  }
</script>

<div class="page">
  <div class="card">
    {#if isSuccess}
      <div class="icon icon--ok" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <h1 class="title">Payment confirmed</h1>
      {#if shop}
        <p class="shop-line">{shop.name}</p>
      {/if}
      <p class="lede">Your order is being prepared. Show the code below to collect it.</p>

      <div class="code-box">
        <span class="code-label">Pickup code</span>
        <span class="code-value mono">{code}</span>
      </div>

      <ul class="steps">
        <li><span class="bullet"></span>A confirmation email has been sent.</li>
        <li><span class="bullet"></span>Show this code at the counter to collect your order.</li>
      </ul>

    {:else}
      <div class="icon icon--cancel" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
          <path d="M3 3l16 16M19 3L3 19"/>
        </svg>
      </div>
      <h1 class="title">Payment cancelled</h1>
      <p class="lede">Your payment was not completed. No charge was made.</p>
    {/if}

    <div class="actions">
      <button class="btn-secondary" onclick={goBack}>
        {isSuccess ? "Back to shop" : "Try again"}
      </button>
    </div>
  </div>
</div>

<style>
  .page {
    min-height: 100%;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 2.5rem 1rem 3rem;
  }
  .card {
    width: 100%; max-width: 420px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    padding: 2.25rem 1.75rem 1.75rem;
    text-align: center;
    box-shadow: 0 24px 48px -16px rgba(0,0,0,0.35);
    animation: rise 360ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .icon {
    width: 3rem; height: 3rem;
    margin: 0 auto 1.25rem;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    animation: pop 380ms cubic-bezier(0.2, 0.9, 0.3, 1) 80ms backwards;
  }
  .icon--ok { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
  .icon--cancel { background: color-mix(in srgb, var(--error) 12%, transparent); color: var(--error); }
  @keyframes pop {
    from { opacity: 0; transform: scale(0.8); }
    to   { opacity: 1; transform: scale(1); }
  }
  .title {
    font-size: 1.5rem; font-weight: 600;
    color: var(--text); letter-spacing: -0.015em;
    margin: 0 0 0.375rem;
  }
  .shop-line {
    font-size: 0.875rem; font-weight: 500;
    color: var(--text-secondary); margin: 0 0 0.75rem;
  }
  .lede {
    font-size: 0.9375rem; color: var(--text-secondary);
    line-height: 1.5; margin: 0 0 1.25rem;
  }
  .code-box {
    background: var(--bg-input, var(--bg-elevated));
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 0.875rem 1rem;
    margin: 0 0 1.25rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.3rem;
  }
  .code-label {
    font-size: 0.625rem; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-muted);
  }
  .code-value {
    font-size: 1.625rem; font-weight: 700; letter-spacing: 0.12em;
    color: var(--accent-text, var(--accent));
  }
  .steps {
    list-style: none; margin: 0 0 1.5rem; padding: 0;
    display: flex; flex-direction: column; gap: 0.5rem; text-align: left;
  }
  .steps li {
    display: flex; align-items: baseline; gap: 0.625rem;
    font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.5;
  }
  .bullet {
    flex-shrink: 0; width: 4px; height: 4px;
    border-radius: 50%; background: var(--text-muted);
    transform: translateY(-3px);
  }
  .actions { margin-bottom: 0.5rem; }
  .btn-secondary {
    width: 100%; padding: 0.75rem 1rem;
    font-weight: 600; font-size: 0.9375rem;
    border-radius: var(--radius-md); cursor: pointer;
    background: transparent; color: var(--text-secondary);
    border: 1px solid var(--border);
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-secondary:hover { border-color: var(--text-muted); color: var(--text); }
  @media (max-width: 480px) {
    .card { padding: 1.75rem 1.125rem 1.125rem; }
    .title { font-size: 1.3125rem; }
  }
</style>
