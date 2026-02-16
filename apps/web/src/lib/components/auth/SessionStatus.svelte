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
    gap: 0.5rem;
  }

  .address {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    background: var(--bg-surface);
    padding: 0.375rem 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .logout-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .logout-btn:hover {
    border-color: var(--error);
    color: var(--error);
  }
</style>
