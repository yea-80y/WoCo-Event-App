<script lang="ts">
  /**
   * "Tap to pay" spend-permission grant modal.
   *
   * Attendee flow (passkey/Kernel account only):
   *   1. Display shop name + default cap + window.
   *   2. On "Authorise" → fetchSpendGrantParams → auth.grantSpendPermission
   *      (one passkey ceremony, delegates to kernel-account.grantShopSpendPermission)
   *      → registerSpendPermission → show QR of permissionId + copy.
   *
   * ⛔ No signing logic here — this only calls the already-audited API wrappers.
   *    Any change to the grant/register sequence goes back to Opus.
   */
  import type { ShopSpendPermission } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import {
    fetchSpendGrantParams,
    registerSpendPermission,
  } from "../../api/shop-spend-permission.js";

  interface Props {
    shopId: string;
    shopName: string;
    /** Default cap in fiat minor units (e.g. 5000 = £50.00). */
    defaultCapMinor?: number;
    currency?: string;
    onClose: () => void;
    onGranted?: (permission: ShopSpendPermission) => void;
  }

  let {
    shopId,
    shopName,
    defaultCapMinor = 5000,
    currency = "GBP",
    onClose,
    onGranted,
  }: Props = $props();

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  const DECIMALS = 6;

  function fiatToAtomic(minor: number): string {
    // fiat minor (pence/cents) → fiat major → USDC atomic (6 dec)
    // Approximation: 1 fiat major ≈ 1 USDC (close enough for a cap — the real
    // rate is applied at draw time by the server; the cap is the drain ceiling).
    const major = minor / 100;
    return String(Math.round(major * 10 ** DECIMALS));
  }

  type Phase = "form" | "signing" | "done" | "error";
  let phase = $state<Phase>("form");
  let errorMsg = $state("");
  let permission = $state<ShopSpendPermission | null>(null);
  // Form seed — one-time capture of the suggested cap is intentional.
  // svelte-ignore state_referenced_locally
  let capInput = $state(String(defaultCapMinor / 100));
  let copied = $state(false);
  let qrSvg = $state<string | null>(null);

  // Scannable token staff's POS reads to pull against this permission. Display
  // only — versioned so the scanner can validate the shopId and extract the id.
  async function makeQr(permissionId: string) {
    try {
      const { renderSVG } = await import("uqr");
      qrSvg = renderSVG(`woco-spend-v1:${shopId}:${permissionId}`, {
        ecc: "M",
        blackColor: "#0B0B09",
        whiteColor: "#ffffff",
      });
    } catch {
      qrSvg = null;
    }
  }

  const sym = $derived(SYMBOLS[currency] ?? "");
  const capNumber = $derived(Number(capInput));
  const capValid = $derived(Number.isFinite(capNumber) && capNumber > 0);

  async function authorise() {
    if (!capValid) return;
    if (auth.kind !== "passkey") {
      errorMsg = "Spend permissions require a passkey account. Connect with a passkey to continue.";
      phase = "error";
      return;
    }
    if (!auth.isConnected || !auth.parent) {
      errorMsg = "Not connected. Please sign in first.";
      phase = "error";
      return;
    }
    phase = "signing";
    errorMsg = "";
    try {
      const params = await fetchSpendGrantParams(shopId);

      const capAtomic = fiatToAtomic(Math.round(capNumber * 100));

      const approval = await auth.grantSpendPermission({
        shopId,
        spenderAddress: params.spenderAddress,
        usdcAddress: params.usdcAddress,
        recipient: params.recipient,
        perDrawCeilingAtomic: params.perDrawCeilingAtomic,
        maxDraws: params.maxDraws,
        validUntil: params.validUntil,
      });

      const perm = await registerSpendPermission(shopId, {
        chainId: params.chainId,
        kernelAddress: auth.parent as `0x${string}`,
        capAtomic,
        validUntil: params.validUntil,
        spenderAddress: params.spenderAddress,
        perDrawCeilingAtomic: params.perDrawCeilingAtomic,
        maxDraws: params.maxDraws,
        approval,
      });

      permission = perm;
      onGranted?.(perm);
      void makeQr(perm.permissionId);
      phase = "done";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Authorisation failed";
      phase = "error";
    }
  }

  function retry() { phase = "form"; errorMsg = ""; }

  async function copyId() {
    if (!permission) return;
    await navigator.clipboard.writeText(permission.permissionId);
    copied = true;
    setTimeout(() => { copied = false; }, 1800);
  }

  function expiryLabel(unix: number): string {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }).format(new Date(unix * 1000));
    } catch {
      return String(unix);
    }
  }
</script>

<!-- backdrop -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onClose()}></div>

<div class="modal" role="dialog" aria-modal="true" aria-label="Tap to pay authorisation">
  <div class="modal-head">
    <div class="head-text">
      <span class="kicker">Tap to pay</span>
      <span class="shop-name">{shopName}</span>
    </div>
    <button class="close" onclick={onClose} aria-label="Close">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
        <path d="M2 2l9 9M11 2L2 11" />
      </svg>
    </button>
  </div>

  {#if phase === "form" || phase === "signing"}
    <div class="body">
      <p class="desc">
        Authorise the venue to draw up to this amount from your wallet during the event —
        no approval prompt needed per purchase. Your USDC stays in your wallet until spent.
      </p>

      <label class="field">
        <span class="f-label kicker--plain">Spending cap</span>
        <div class="cap-input-wrap">
          <span class="sym mono">{sym}</span>
          <input
            class="input mono cap-input"
            type="number"
            min="1"
            step="1"
            bind:value={capInput}
            disabled={phase === "signing"}
            placeholder="50.00"
          />
        </div>
        <span class="f-hint">Max the venue can spend from your wallet. Set it to what you plan to spend.</span>
      </label>

      <div class="trust-list">
        <div class="trust-item">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1.5 5.5l2.5 2.5L9.5 2.5"/></svg>
          <span>Venue can only pay their own merchant address</span>
        </div>
        <div class="trust-item">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1.5 5.5l2.5 2.5L9.5 2.5"/></svg>
          <span>Expires automatically at event end</span>
        </div>
        <div class="trust-item">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1.5 5.5l2.5 2.5L9.5 2.5"/></svg>
          <span>You can revoke any time from your wallet</span>
        </div>
      </div>

      <button
        class="btn btn--primary auth-btn"
        onclick={authorise}
        disabled={!capValid || phase === "signing"}
      >
        {#if phase === "signing"}
          <span class="spinner" aria-hidden="true"></span>
          Waiting for passkey…
        {:else}
          Authorise {sym}{capNumber > 0 ? capNumber.toFixed(2) : "—"} spend cap
        {/if}
      </button>
    </div>

  {:else if phase === "error"}
    <div class="body">
      <div class="err-box mono">{errorMsg}</div>
      {#if errorMsg.includes("passkey")}
        <p class="hint">Log out and log back in with a passkey account to use this feature.</p>
      {/if}
      <button class="btn btn--ghost" onclick={retry}>Try again</button>
    </div>

  {:else if phase === "done" && permission}
    <div class="body done">
      <span class="ok-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
          <path d="M3.5 10.5l4 4 9-9" />
        </svg>
      </span>
      <span class="kicker">Spend permission granted</span>
      <p class="done-desc">
        Show this code at the bar — staff scan it to charge your tab. No further approval needed each round.
      </p>

      {#if qrSvg}
        <div class="qr-panel">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- generated SVG, no user input -->
          {@html qrSvg}
        </div>
      {/if}

      <div class="perm-id-block">
        <span class="perm-id mono">{permission.permissionId.slice(0, 24)}…</span>
        <button class="copy-btn" onclick={copyId}>
          {#if copied}
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1.5 5.5l2.5 2.5L9.5 2.5"/></svg>
            Copied
          {:else}
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><rect x="1.5" y="3.5" width="6" height="7"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5H9a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H8"/></svg>
            Copy ID
          {/if}
        </button>
      </div>

      <div class="perm-meta">
        <div class="meta-row">
          <span class="meta-label kicker--plain">Cap</span>
          <span class="meta-val mono">{sym}{(Number(permission.capAtomic) / 10 ** DECIMALS).toFixed(2)} USDC</span>
        </div>
        <div class="meta-row">
          <span class="meta-label kicker--plain">Expires</span>
          <span class="meta-val mono">{expiryLabel(permission.validUntil)}</span>
        </div>
      </div>

      <button class="btn btn--ghost" onclick={onClose}>Done</button>
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 58;
    background: rgba(0,0,0,0.65);
    animation: fadein 0.15s ease;
  }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    position: fixed; inset: 0; z-index: 59;
    margin: auto;
    width: min(440px, 100%);
    height: fit-content;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    animation: popin 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    max-height: 90dvh;
    overflow-y: auto;
  }
  @keyframes popin { from { opacity: 0; transform: scale(0.97) translateY(8px); } to { opacity: 1; transform: none; } }

  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    padding: 1rem 1.125rem 0.875rem;
    border-bottom: 1px solid var(--border);
  }
  .head-text { display: flex; flex-direction: column; gap: 0.2rem; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  .kicker--plain { font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .shop-name { font-size: 1rem; font-weight: 700; color: var(--text); }
  .close { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.25rem; line-height: 0; }
  .close:hover { color: var(--text); }

  .body { padding: 1rem 1.125rem 1.25rem; display: flex; flex-direction: column; gap: 1rem; }

  .desc { margin: 0; font-size: 0.8125rem; line-height: 1.45; color: var(--text-secondary); }

  .field { display: flex; flex-direction: column; gap: 0.375rem; }
  .f-label { display: block; }
  .f-hint { font-size: 0.6875rem; color: var(--text-dim); }
  .cap-input-wrap { display: flex; align-items: center; gap: 0; }
  .sym {
    background: var(--bg-elevated); border: 1px solid var(--border); border-right: none;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    padding: 0.5rem 0.625rem; font-size: 0.9375rem; font-weight: 700; color: var(--text);
    line-height: 1.5; flex-shrink: 0;
  }
  .cap-input {
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    color: var(--text); padding: 0.5rem 0.75rem;
    font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; width: 100%;
    transition: border-color 0.1s;
  }
  .cap-input:focus { outline: none; border-color: var(--accent); }
  input[type=number]::-webkit-inner-spin-button { opacity: 0; }

  .trust-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .trust-item {
    display: flex; align-items: flex-start; gap: 0.5rem;
    font-size: 0.75rem; color: var(--text-secondary); line-height: 1.35;
  }
  .trust-item svg { margin-top: 0.1rem; color: var(--accent-text); flex-shrink: 0; }

  .auth-btn { width: 100%; justify-content: center; display: flex; align-items: center; gap: 0.5rem; }
  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid var(--accent-ink); border-top-color: transparent;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .err-box {
    background: var(--error-subtle); color: var(--error); border: 1px solid var(--error);
    border-radius: var(--radius-sm); padding: 0.5rem 0.75rem; font-size: 0.6875rem;
  }
  .hint { margin: 0; font-size: 0.75rem; color: var(--text-muted); }

  /* ── done state ── */
  .done { align-items: center; text-align: center; }
  .ok-mark {
    width: 3rem; height: 3rem; display: grid; place-items: center;
    background: var(--accent); color: var(--accent-ink);
    border-radius: var(--radius-md); margin-bottom: 0.25rem;
  }
  .done-desc { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.4; max-width: 300px; }

  .qr-panel {
    background: #ffffff; border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 0.875rem;
    width: 188px; height: 188px; display: grid; place-items: center;
    box-shadow: 0 0 0 4px var(--bg-surface), 0 0 0 5px var(--border);
  }
  .qr-panel :global(svg) { width: 100%; height: 100%; display: block; }

  .perm-id-block {
    display: flex; align-items: center; gap: 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 0.5rem 0.75rem;
    width: 100%;
  }
  .perm-id { font-size: 0.6875rem; color: var(--text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .copy-btn {
    display: inline-flex; align-items: center; gap: 0.3rem;
    background: none; border: none; cursor: pointer; color: var(--text-muted);
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.1em;
    padding: 0.25rem 0.375rem;
    border-radius: var(--radius-sm); flex-shrink: 0;
    transition: color 0.1s, background 0.1s;
  }
  .copy-btn:hover { color: var(--accent-text); background: var(--bg-surface-hover); }

  .perm-meta {
    display: flex; flex-direction: column; gap: 0.375rem;
    width: 100%; border-top: 1px solid var(--border); padding-top: 0.875rem;
  }
  .meta-row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .meta-label { color: var(--text-muted); }
  .meta-val { font-size: 0.75rem; color: var(--text-secondary); }
</style>
