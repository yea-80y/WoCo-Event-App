<script lang="ts">
  import WalletLogin from "./WalletLogin.svelte";

  interface Props {
    open: boolean;
    onclose?: () => void;
  }

  let { open = $bindable(), onclose }: Props = $props();

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      open = false;
      onclose?.();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      open = false;
      onclose?.();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Login">
      <header>
        <h2>Sign in to WoCo</h2>
        <button class="close-btn" onclick={() => { open = false; onclose?.(); }} aria-label="Close">
          &times;
        </button>
      </header>

      <div class="options">
        <WalletLogin />
        <!-- Phase 2: Zupass login will go here -->
        <!-- Phase 3: Para wallet login will go here -->
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    padding: 1.5rem;
    min-width: 340px;
    max-width: 420px;
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
    font-size: 1.25rem;
    color: #e2e8f0;
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .close-btn:hover {
    color: #e2e8f0;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
