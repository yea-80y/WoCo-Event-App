<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isWalletAvailable } from "../../wallet/provider.js";

  let error = $state<string | null>(null);
  const walletAvailable = isWalletAvailable();

  async function handleLogin() {
    error = null;
    const ok = await auth.login();
    if (!ok && !auth.isAuthenticated) {
      error = "Login cancelled or failed. Please try again.";
    }
  }
</script>

{#if !walletAvailable}
  <div class="wallet-login">
    <p class="no-wallet">No wallet detected. Install MetaMask or another Ethereum wallet to continue.</p>
  </div>
{:else}
  <div class="wallet-login">
    <button
      class="wallet-btn"
      onclick={handleLogin}
      disabled={auth.busy}
    >
      {#if auth.busy}
        Connecting...
      {:else}
        Connect Wallet
      {/if}
    </button>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
{/if}

<style>
  .wallet-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
  }

  .wallet-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
  }

  .wallet-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .wallet-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }

  .no-wallet {
    color: var(--text-secondary);
    font-size: 0.875rem;
    text-align: center;
    margin: 0;
  }
</style>
