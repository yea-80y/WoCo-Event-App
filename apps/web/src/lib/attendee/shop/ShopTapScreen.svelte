<script lang="ts">
  /**
   * Attendee "tap to pay" activation landing — the target of a festival gate QR
   * (#/shops/:id/tap). Loads the shop, gates on a passkey/Kernel login, and opens
   * the SpendGrantModal so the attendee authorises a capped, time-boxed spend
   * permission for the venue. One approval; staff then pull each round.
   *
   * Funds/grant logic lives in SpendGrantModal + the audited API wrappers — this
   * screen only orchestrates load + login gate + modal.
   */
  import type { Shop } from "@woco/shared";
  import { onMount } from "svelte";
  import { getShop } from "../../api/shops.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import SpendGrantModal from "./SpendGrantModal.svelte";

  interface Props {
    shopId: string;
  }
  let { shopId }: Props = $props();

  let shop = $state<Shop | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let modalOpen = $state(false);
  let granted = $state(false);

  const connected = $derived(auth.isConnected);
  const isPasskey = $derived(auth.kind === "passkey");

  onMount(async () => {
    try {
      shop = await getShop(shopId);
      if (!shop) loadError = "This shop could not be found.";
    } catch {
      loadError = "Couldn't load this shop. Check your connection and try again.";
    } finally {
      loading = false;
    }
  });

  async function connect() {
    await loginRequest.request({ context: "attendee" });
  }

  function activate() {
    modalOpen = true;
  }
</script>

<div class="tap-screen">
  <div class="scan-frame" aria-hidden="true">
    <span class="corner tl"></span><span class="corner tr"></span>
    <span class="corner bl"></span><span class="corner br"></span>
  </div>

  {#if loading}
    <div class="panel skeleton-panel">
      <div class="sk sk-kicker"></div>
      <div class="sk sk-title"></div>
      <div class="sk sk-line"></div>
    </div>

  {:else if loadError}
    <div class="panel">
      <span class="kicker">Tap to pay</span>
      <p class="err-text">{loadError}</p>
    </div>

  {:else if shop}
    <div class="panel">
      <span class="kicker">Tap to pay · {shop.currency}</span>
      <h1 class="shop-name">{shop.name}</h1>
      <p class="lede">
        Approve one spending cap and pay all event with a tap — no wallet popup per round.
        Your money stays in your own wallet until you spend it.
      </p>

      <ul class="trust">
        <li>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M2 6l2.5 2.5L10 3"/></svg>
          Venue can only ever pay its own address
        </li>
        <li>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M2 6l2.5 2.5L10 3"/></svg>
          Capped — they can never exceed your limit
        </li>
        <li>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M2 6l2.5 2.5L10 3"/></svg>
          Auto-expires at event end · revoke anytime
        </li>
      </ul>

      {#if granted}
        <div class="ready">
          <span class="ready-dot" aria-hidden="true"></span>
          You're set — show your code at the bar.
          <button class="link-btn" onclick={() => { modalOpen = true; }}>View code</button>
        </div>
      {:else if !connected}
        <button class="btn btn--primary cta" onclick={connect}>Connect to activate</button>
        <p class="foot">You'll sign in with a passkey — no app, no seed phrase.</p>
      {:else if !isPasskey}
        <div class="notice">
          Tap-to-pay needs a <strong>passkey</strong> account. Sign out and sign back in with a passkey to use it.
        </div>
      {:else}
        <button class="btn btn--primary cta" onclick={activate}>Activate tap-to-pay</button>
        <p class="foot">One passkey approval. That's it for the whole event.</p>
      {/if}
    </div>
  {/if}
</div>

{#if modalOpen && shop}
  <SpendGrantModal
    shopId={shop.shopId}
    shopName={shop.name}
    currency={shop.currency}
    onClose={() => { modalOpen = false; }}
    onGranted={() => { granted = true; }}
  />
{/if}

<style>
  .tap-screen {
    position: relative;
    min-height: calc(100dvh - var(--shell-top, 0px) - var(--shell-bottom, 0px));
    display: grid; place-items: center;
    padding: 2rem 1.125rem 3rem;
    /* faint engineering grid — "gate scanner" atmosphere */
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 28px 28px;
    background-position: center;
    overflow: hidden;
  }
  /* fade the grid out toward the edges so it reads as texture, not a table */
  .tap-screen::before {
    content: ""; position: absolute; inset: 0;
    background: radial-gradient(ellipse 80% 60% at 50% 45%, transparent 30%, var(--bg) 85%);
    pointer-events: none;
  }

  .scan-frame { position: absolute; inset: 1.25rem; pointer-events: none; }
  .corner { position: absolute; width: 20px; height: 20px; border: 2px solid var(--accent); opacity: 0.5; }
  .corner.tl { top: 0; left: 0; border-right: none; border-bottom: none; }
  .corner.tr { top: 0; right: 0; border-left: none; border-bottom: none; }
  .corner.bl { bottom: 0; left: 0; border-right: none; border-top: none; }
  .corner.br { bottom: 0; right: 0; border-left: none; border-top: none; }

  .panel {
    position: relative; z-index: 1;
    width: min(420px, 100%);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.5rem 1.375rem 1.625rem;
    display: flex; flex-direction: column; gap: 0.875rem;
    box-shadow: 0 24px 60px -28px rgba(0,0,0,0.7);
    animation: rise 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .kicker {
    font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-muted);
  }
  .shop-name {
    margin: 0; font-size: 1.875rem; font-weight: 800; letter-spacing: -0.02em;
    line-height: 1.05; color: var(--text);
  }
  .lede { margin: 0; font-size: 0.875rem; line-height: 1.5; color: var(--text-secondary); }

  .trust { list-style: none; margin: 0.125rem 0 0.25rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .trust li { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.75rem; line-height: 1.35; color: var(--text-secondary); }
  .trust svg { margin-top: 0.08rem; color: var(--accent-text); flex-shrink: 0; }

  .cta { width: 100%; justify-content: center; font-size: 0.9375rem; margin-top: 0.25rem; }
  .foot { margin: 0; font-size: 0.6875rem; color: var(--text-muted); text-align: center; }

  .notice {
    font-size: 0.8125rem; line-height: 1.45; color: var(--text-secondary);
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 0.75rem 0.875rem;
  }
  .notice strong { color: var(--text); }

  .ready {
    display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
    font-size: 0.8125rem; color: var(--text); font-weight: 600;
    background: var(--accent-subtle, var(--bg-elevated)); border: 1px solid var(--accent);
    border-radius: var(--radius-sm); padding: 0.75rem 0.875rem;
  }
  .ready-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .link-btn {
    margin-left: auto; background: none; border: none; cursor: pointer;
    color: var(--accent-text); font-weight: 600; font-size: 0.8125rem; text-decoration: underline;
    text-underline-offset: 2px; padding: 0;
  }

  .err-text { margin: 0; font-size: 0.875rem; color: var(--text-secondary); }

  /* skeleton */
  .skeleton-panel { gap: 0.75rem; }
  .sk { background: var(--bg-elevated); border-radius: var(--radius-sm); animation: pulse 1.3s ease-in-out infinite; }
  .sk-kicker { width: 35%; height: 0.75rem; }
  .sk-title { width: 70%; height: 1.75rem; }
  .sk-line { width: 100%; height: 2.75rem; }
  @keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
</style>
