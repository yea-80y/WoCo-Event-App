<script lang="ts">
  import { onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();
  let error = $state<string | null>(null);
  let step = $state<"connect" | "authorize">("connect");
  let authorizeBtn = $state<HTMLButtonElement | null>(null);

  // Warm the @coinbase/wallet-sdk chunk before the user clicks so the dynamic
  // import doesn't eat into the click's user-activation budget.
  onMount(() => {
    auth.prefetchCoinbaseSdk();
  });

  async function handleConnect() {
    error = null;
    try {
      const ok = await auth.loginCoinbase();
      if (!ok) {
        if (!auth.isConnected) error = "Connection cancelled or failed.";
        return;
      }
      step = "authorize";
      await tick();
      authorizeBtn?.focus();
    } catch (e: any) {
      console.error("[CoinbaseLogin] connect", e);
      error = e?.message?.slice(0, 120) || "Coinbase Smart Wallet error";
    }
  }

  // Step 2 is a separate click so the browser grants fresh transient activation
  // for the second popup. CSW SDK v4.3.7's connect popup closes on approval and
  // its Communicator rejects in-flight requests when the popup unloads, so
  // chaining sign into the same click hits a 4001 race.
  async function handleAuthorize() {
    error = null;
    try {
      const ok = await auth.ensureSession();
      if (!ok) {
        error = "Authorization cancelled. Click to try again.";
        return;
      }
      oncomplete?.();
    } catch (e: any) {
      console.error("[CoinbaseLogin] authorize", e);
      error = e?.message?.slice(0, 120) || "Authorization failed";
    }
  }
</script>

<div class="cb-login">
  <div class="progress" aria-hidden="true">
    <span class="dot" class:active={step === "connect"} class:done={step === "authorize"}>1</span>
    <span class="bar" class:done={step === "authorize"}></span>
    <span class="dot" class:active={step === "authorize"}>2</span>
  </div>

  {#if step === "connect"}
    <div in:slide={{ duration: 180 }}>
      <p class="step-label">Step 1 of 2 — Connect your wallet</p>
      <button
        class="cb-btn"
        onclick={handleConnect}
        onpointerenter={() => auth.prefetchCoinbaseSdk()}
        onfocus={() => auth.prefetchCoinbaseSdk()}
        disabled={auth.busy}
      >
        <svg class="cb-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="16" cy="16" r="16" fill="#0052FF"/>
          <path d="M16 22.667a6.667 6.667 0 1 1 6.553-7.94.667.667 0 0 1-.655.793h-3.45a.667.667 0 0 1-.61-.4 2.667 2.667 0 1 0 0 2.16c.107-.243.35-.4.61-.4h3.45c.418 0 .733.378.655.793A6.667 6.667 0 0 1 16 22.667Z" fill="#fff"/>
        </svg>
        {auth.busy ? "Connecting..." : "Connect with Coinbase Smart Wallet"}
      </button>
      <p class="hint">Passkey-secured smart wallet — no extension, no seed phrase</p>
    </div>
  {:else}
    <div in:slide={{ duration: 180 }}>
      <p class="step-label">Step 2 of 2 — Authorize this session</p>
      <button
        class="cb-btn"
        bind:this={authorizeBtn}
        onclick={handleAuthorize}
        disabled={auth.busy}
      >
        <svg class="cb-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 2L4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
          <path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {auth.busy ? "Authorizing..." : "Authorize this session"}
      </button>
      <p class="hint">Sign once to authorize a 30-day session — you won't be prompted again until it expires.</p>
    </div>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .cb-login {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: center;
    margin-bottom: 0.25rem;
  }

  .dot {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6875rem;
    font-weight: 700;
    background: var(--surface-2, #1f1f1f);
    color: var(--text-muted, #888);
    border: 1px solid var(--border, #333);
    transition: background var(--transition), color var(--transition), border-color var(--transition);
  }

  .dot.active {
    background: #0052FF;
    color: #fff;
    border-color: #0052FF;
  }

  .dot.done {
    background: #0052FF;
    color: #fff;
    border-color: #0052FF;
    opacity: 0.6;
  }

  .bar {
    flex: 0 0 2.5rem;
    height: 2px;
    background: var(--border, #333);
    border-radius: 1px;
    transition: background var(--transition);
  }

  .bar.done {
    background: #0052FF;
  }

  .step-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    margin: 0 0 0.5rem;
    letter-spacing: 0.02em;
  }

  .cb-btn {
    width: 100%;
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: #0052FF;
    color: #fff;
    transition: background var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
  }

  .cb-btn:hover:not(:disabled) {
    background: #0041cc;
  }

  .cb-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .cb-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0.5rem 0 0;
    text-align: center;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }
</style>
