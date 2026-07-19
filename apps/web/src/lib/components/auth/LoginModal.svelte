<script lang="ts">
  import WalletLogin from "./WalletLogin.svelte";
  import CoinbaseLogin from "./CoinbaseLogin.svelte";
  import PasskeyLogin from "./PasskeyLogin.svelte";
  import Web3AuthLogin from "./Web3AuthLogin.svelte";
  import ZupassLogin from "./ZupassLogin.svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  type Method = "passkey" | "email" | "wallet" | "coinbase";

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(false), onclose }: Props = $props();

  // Modal is visible if either prop-driven or store-driven
  const visible = $derived(open || loginRequest.pending);

  // Which method is mid-flight — swaps the picker for the authenticating scene.
  // The picker stays MOUNTED (hidden) underneath so children keep their state
  // (CoinbaseLogin's two-step progress, per-method error text) across the scene.
  let authing = $state<Method | null>(null);

  const sceneCopy: Record<Method, { name: string; waiting: string; finalizing: string }> = {
    passkey: {
      name: "Passkey",
      waiting: "Check your device — approve with Face ID, fingerprint, or PIN.",
      finalizing: "Unlocking your account…",
    },
    email: {
      name: "Email",
      waiting: "Finish signing in via the secure pop-up.",
      finalizing: "Setting up your account…",
    },
    wallet: {
      name: "Wallet",
      waiting: "Check your wallet and approve the connection.",
      finalizing: "Connecting your wallet…",
    },
    coinbase: {
      name: "Coinbase",
      waiting: "Approve in the Coinbase pop-up.",
      finalizing: "Connecting your wallet…",
    },
  };

  // "waiting" until the credential step is done, then "finalizing". Wallet
  // flows that connect before auth.login runs (WalletConnect QR) read null —
  // treat that as still waiting.
  const stage = $derived(auth.loginStage ?? "waiting");

  function start(method: Method) {
    authing = method;
  }

  // A settled attempt (success or failure) always returns to the picker; on
  // success handleComplete closes the modal in the same tick, on failure the
  // child's own error text is visible again.
  function settle() {
    authing = null;
  }

  function close() {
    open = false;
    authing = null;
    loginRequest.resolve(false);
    onclose?.();
  }

  function handleComplete() {
    open = false;
    authing = null;
    loginRequest.resolve(true);
    onclose?.();
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Login">
      <header>
        <div class="modal-heading">
          <span class="kicker kicker--plain">WoCo</span>
          <h2>{authing ? "Signing in" : "Sign in"}</h2>
          {#if !authing && loginRequest.context === "attendee"}
            <p class="attendee-sub">WoCo accounts are for organisers right now — attendee accounts coming soon.</p>
          {/if}
        </div>
        <button class="close-btn" onclick={close} aria-label="Close">
          &times;
        </button>
      </header>

      {#if authing}
        {@const c = sceneCopy[authing]}
        <div class="scene" role="status" aria-live="polite">
          <div class="stamp" aria-hidden="true">
            <span class="ring"></span>
            <span class="ring ring--late"></span>
            <div class="glyph">
              {#if authing === "passkey"}
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12.01 3c-1.98 0-3.86.47-5.57 1.41-.24.13-.54.04-.68-.2-.13-.24-.04-.55.2-.68C7.82 2.52 9.86 2 12.01 2c2.13 0 3.99.47 6.03 1.52.25.13.34.43.21.67-.09.18-.26.28-.44.28zM3.5 9.72a.499.499 0 0 1-.25-.93C5.45 7.33 8.34 6.25 12 6.25c3.67 0 6.56 1.08 8.75 2.54.23.16.29.48.13.71-.16.23-.48.29-.71.13C18.14 8.31 15.36 7.25 12 7.25c-3.35 0-6.13 1.06-8.25 2.34-.08.09-.16.13-.25.13zM12 22c-1.23 0-2.4-.32-3.37-.96-.13-.09-.21-.23-.21-.39 0-.16.07-.32.21-.41l.66-.45a.678.678 0 0 1 .68-.03c.65.37 1.33.56 2.03.56 2.37 0 4.3-2.07 4.3-4.61 0-2.55-1.93-4.61-4.3-4.61-2.33 0-4.29 2.02-4.3 4.53v.08c-.01.53-.19 1.88-1.3 3.48-.07.1-.18.16-.3.18h-.02c-.12 0-.24-.05-.31-.15A8.24 8.24 0 0 1 4 14.35C4 9.73 7.59 6 12 6s8 3.73 8 8.35S16.41 22 12 22zM7.33 15.63c-.56 0-1.01-.49-1.01-1.09 0-.6.45-1.09 1.01-1.09.56 0 1.01.49 1.01 1.09 0 .6-.45 1.09-1.01 1.09z" fill="currentColor"/>
                </svg>
              {:else if authing === "email"}
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
                  <path d="m4 7 8 6 8-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {:else if authing === "coinbase"}
                <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="16" cy="16" r="13" stroke="currentColor" stroke-width="1.8"/>
                  <path d="M16 22.667a6.667 6.667 0 1 1 6.553-7.94.667.667 0 0 1-.655.793h-3.45a.667.667 0 0 1-.61-.4 2.667 2.667 0 1 0 0 2.16c.107-.243.35-.4.61-.4h3.45c.418 0 .733.378.655.793A6.667 6.667 0 0 1 16 22.667Z" fill="currentColor"/>
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                  <rect x="4" y="7" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
                  <circle cx="16" cy="13" r="1.25" fill="currentColor"/>
                </svg>
              {/if}
            </div>
          </div>
          <p class="scene-eyebrow">{c.name}</p>
          <p class="scene-copy">{stage === "finalizing" ? c.finalizing : c.waiting}</p>
        </div>
      {/if}

      <div class="options" class:offstage={authing !== null}>
        <PasskeyLogin oncomplete={handleComplete} onstart={() => start("passkey")} onsettle={settle} />

        <Web3AuthLogin oncomplete={handleComplete} onstart={() => start("email")} onsettle={settle} />

        <div class="group-label"><span>Wallets</span></div>

        <WalletLogin oncomplete={handleComplete} onstart={() => start("wallet")} onsettle={settle} />

        <CoinbaseLogin oncomplete={handleComplete} onstart={() => start("coinbase")} onsettle={settle} />

        <div class="group-label"><span>Coming soon</span></div>

        <ZupassLogin />
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: backdrop-in 0.12s ease-out;
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.5rem;
    min-width: 320px;
    max-width: 400px;
    width: 90vw;
    max-height: 90svh;
    overflow-y: auto;
    animation: modal-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @keyframes backdrop-in {
    from { opacity: 0; }
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .modal-heading {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.025em;
  }

  .attendee-sub {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.4;
    max-width: 28ch;
  }

  .close-btn {
    color: var(--text-dim);
    font-size: 1.25rem;
    line-height: 1;
    transition: color var(--transition);
    flex-shrink: 0;
    padding: 0.125rem;
  }

  .close-btn:hover {
    color: var(--text);
  }

  /* ------------------------------------------------------------------ */
  /* Authenticating scene — the stamp                                    */
  /* ------------------------------------------------------------------ */

  .scene {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 1.75rem 0 1.25rem;
    animation: scene-in 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @keyframes scene-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }

  .stamp {
    position: relative;
    width: 140px;
    height: 140px;
    display: grid;
    place-items: center;
    margin-bottom: 0.75rem;
  }

  .ring {
    position: absolute;
    inset: 22px;
    border: 1.5px solid var(--accent);
    border-radius: 50%;
    opacity: 0;
    animation: ring-pulse 1.8s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
  }

  .ring--late {
    animation-delay: 0.9s;
  }

  @keyframes ring-pulse {
    0% {
      transform: scale(0.78);
      opacity: 0.8;
    }
    100% {
      transform: scale(1.42);
      opacity: 0;
    }
  }

  .glyph {
    width: 72px;
    height: 72px;
    border-radius: var(--radius-lg);
    background: var(--accent-subtle);
    border: 1px solid var(--accent);
    display: grid;
    place-items: center;
    color: var(--accent-text);
    animation: glyph-breathe 1.8s ease-in-out infinite;
  }

  .glyph svg {
    width: 34px;
    height: 34px;
  }

  @keyframes glyph-breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.045);
    }
  }

  .scene-eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent-text);
  }

  .scene-copy {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9rem;
    line-height: 1.5;
    text-align: center;
    max-width: 30ch;
  }

  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .modal,
    .scene {
      animation: none;
    }
    .ring {
      animation: none;
      opacity: 0.3;
      transform: scale(1.1);
    }
    .glyph {
      animation: none;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Method picker                                                        */
  /* ------------------------------------------------------------------ */

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  /* Children stay mounted while the scene plays so their state (Coinbase's
     two-step progress, error text) survives the round-trip. */
  .options.offstage {
    display: none;
  }

  .group-label {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-top: 0.25rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .group-label::before,
  .group-label::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
</style>
