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
    align-items: center;
    gap: 0.75rem;
  }

  .wallet-btn {
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    background: #4f46e5;
    color: #fff;
    cursor: pointer;
    transition: background 0.15s;
  }

  .wallet-btn:hover:not(:disabled) {
    background: #4338ca;
  }

  .wallet-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .error {
    color: #ef4444;
    font-size: 0.875rem;
    margin: 0;
  }

  .no-wallet {
    color: #9ca3af;
    font-size: 0.875rem;
    text-align: center;
    margin: 0;
  }
</style>
