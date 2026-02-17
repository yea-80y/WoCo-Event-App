<script lang="ts">
  import WalletLogin from "./WalletLogin.svelte";
  import LocalLogin from "./LocalLogin.svelte";
  import ZupassLogin from "./ZupassLogin.svelte";

  interface Props {
    open: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(), onclose }: Props = $props();

  function close() {
    open = false;
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

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Login">
      <header>
        <h2>Sign in to WoCo</h2>
        <button class="close-btn" onclick={close} aria-label="Close">
          &times;
        </button>
      </header>

      <div class="options">
        <WalletLogin oncomplete={close} />

        <div class="divider"><span>or</span></div>

        <LocalLogin oncomplete={close} />

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
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    min-width: 340px;
    max-width: 400px;
    width: 90vw;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
  }

  .close-btn {
    color: var(--text-muted);
    font-size: 1.375rem;
    line-height: 1;
    transition: color var(--transition);
  }

  .close-btn:hover {
    color: var(--text);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
</style>
