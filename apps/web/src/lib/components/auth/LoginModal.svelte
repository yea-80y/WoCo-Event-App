<script lang="ts">
  import WalletLogin from "./WalletLogin.svelte";
  import PasskeyLogin from "./PasskeyLogin.svelte";
  import ParaLogin from "./ParaLogin.svelte";
  import ZupassLogin from "./ZupassLogin.svelte";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(false), onclose }: Props = $props();

  // Modal is visible if either prop-driven or store-driven
  const visible = $derived(open || loginRequest.pending);

  function close() {
    open = false;
    loginRequest.resolve(false);
    onclose?.();
  }

  function handleComplete() {
    open = false;
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
          <h2>Sign in</h2>
        </div>
        <button class="close-btn" onclick={close} aria-label="Close">
          &times;
        </button>
      </header>

      <div class="options">
        <WalletLogin oncomplete={handleComplete} />

        <div class="divider"><span>or</span></div>

        <PasskeyLogin oncomplete={handleComplete} />

        <div class="divider"><span>or</span></div>

        <ParaLogin oncomplete={handleComplete} />

        <div class="divider"><span>or</span></div>

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

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
</style>
