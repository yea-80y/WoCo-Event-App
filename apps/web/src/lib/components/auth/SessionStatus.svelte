<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  const kindLabel = $derived(
    auth.kind === "web3" ? "wallet" : auth.kind === "passkey" ? "passkey" : auth.kind,
  );
</script>

{#if auth.isConnected && auth.parent}
  <div class="session-status">
    <span class="kind-badge">{kindLabel}</span>
    <span class="address" title={auth.parent}>
      {truncateAddress(auth.parent)}
    </span>
    <button class="action-btn logout-btn" onclick={() => auth.logout()} title="Sign out">
        &#10005;
    </button>
  </div>
{/if}

<style>
  .session-status {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 1;
    min-width: 0;
  }

  .kind-badge {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent-text);
    background: var(--accent-subtle);
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .address {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-surface);
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
    flex-shrink: 0;
    line-height: 1;
  }

  .action-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .action-btn.logout-btn:hover {
    border-color: var(--error);
    color: var(--error);
  }

  @media (max-width: 480px) {
    .address, .kind-badge { display: none; }
  }
</style>
