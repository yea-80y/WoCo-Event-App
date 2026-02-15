<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }
</script>

{#if auth.isAuthenticated && auth.parent}
  <div class="session-status">
    <span class="address" title={auth.parent}>
      {truncateAddress(auth.parent)}
    </span>
    <button class="logout-btn" onclick={() => auth.logout()}>
      Disconnect
    </button>
  </div>
{/if}

<style>
  .session-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .address {
    font-family: monospace;
    font-size: 0.875rem;
    color: #94a3b8;
    background: #1e1e3a;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
  }

  .logout-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border: 1px solid #374151;
    border-radius: 6px;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    transition: all 0.15s;
  }

  .logout-btn:hover {
    border-color: #ef4444;
    color: #ef4444;
  }
</style>
