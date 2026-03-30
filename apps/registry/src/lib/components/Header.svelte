<script lang="ts">
  import { navigate } from '../router/router.svelte.ts';
  import { wallet, connectWallet, disconnect } from '../wallet/connection.svelte.ts';

  function truncateAddress(addr: string): string {
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }
</script>

<header class="header">
  <div class="header-left">
    <a href="#/" class="logo" onclick={(e) => { e.preventDefault(); navigate('/'); }}>
      <span class="logo-icon">&#x1f6e1;</span>
      <span class="logo-text">
        <span class="logo-wc">World Computer</span>
        <span class="logo-reg">Registry</span>
      </span>
    </a>
  </div>

  <nav class="nav">
    <a href="#/" class="nav-link">Verify</a>
    <a href="#/register" class="nav-link">Register</a>
    <a href="#/browse" class="nav-link">Browse</a>
    {#if wallet.connected}
      <a href="#/my" class="nav-link">My Hashes</a>
    {/if}
  </nav>

  <div class="header-right">
    {#if wallet.connected}
      <span class="wallet-address">{truncateAddress(wallet.address!)}</span>
      <button class="btn btn-secondary btn-sm" onclick={disconnect}>Disconnect</button>
    {:else}
      <button class="btn btn-primary btn-sm" onclick={connectWallet} disabled={wallet.connecting}>
        {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    {/if}
  </div>
</header>

{#if wallet.error}
  <div class="wallet-error">{wallet.error}</div>
{/if}

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-left {
    display: flex;
    align-items: center;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--text);
  }

  .logo:hover {
    text-decoration: none;
  }

  .logo-icon {
    font-size: 1.5rem;
  }

  .logo-text {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
  }

  .logo-wc {
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .logo-reg {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
  }

  .nav {
    display: flex;
    gap: 0.25rem;
  }

  .nav-link {
    padding: 0.375rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    text-decoration: none;
    transition: all var(--transition);
  }

  .nav-link:hover {
    color: var(--text);
    background: var(--bg-surface-hover);
    text-decoration: none;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .wallet-address {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-family: monospace;
  }

  .btn-sm {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }

  .wallet-error {
    background: var(--error-subtle);
    color: var(--error);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 640px) {
    .header {
      flex-direction: column;
      align-items: flex-start;
    }

    .nav {
      order: 3;
      width: 100%;
    }

    .header-right {
      order: 2;
    }
  }
</style>
