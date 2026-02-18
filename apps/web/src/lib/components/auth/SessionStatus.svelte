<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { restoreLocalAccount } from "../../auth/local-account.js";

  let showExportKey = $state(false);
  let exportedKey = $state<string | null>(null);

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  const kindLabel = $derived(
    auth.kind === "web3" ? "wallet" : auth.kind === "local" ? "local" : auth.kind,
  );

  async function handleExportKey() {
    if (exportedKey) {
      // Toggle off
      exportedKey = null;
      showExportKey = false;
      return;
    }
    const account = await restoreLocalAccount();
    if (account) {
      showExportKey = true;
      exportedKey = account.privateKey;
    }
  }

  function handleCopyKey() {
    if (exportedKey) {
      navigator.clipboard.writeText(exportedKey);
    }
  }

  function handleCloseExport() {
    showExportKey = false;
    exportedKey = null;
  }
</script>

{#if auth.isConnected && auth.parent}
  <div class="session-status">
    <span class="kind-badge">{kindLabel}</span>
    <span class="address" title={auth.parent}>
      {truncateAddress(auth.parent)}
    </span>
    {#if auth.kind === "local"}
      <button class="action-btn" onclick={handleExportKey} title="Backup private key">
        &#128274;
      </button>
    {/if}
    <button class="action-btn logout-btn" onclick={() => auth.logout()} title="Sign out">
        &#10005;
    </button>
  </div>

  {#if showExportKey && exportedKey}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="export-backdrop" role="presentation" onclick={handleCloseExport}>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div class="export-modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
        <h3>Private Key Backup</h3>
        <p class="export-warning">
          Anyone with this key has full control of this account.
          Store it somewhere safe and never share it.
        </p>
        <code class="key-display">{exportedKey}</code>
        <div class="export-actions">
          <button class="copy-btn" onclick={handleCopyKey}>Copy to clipboard</button>
          <button class="close-btn" onclick={handleCloseExport}>Close</button>
        </div>
      </div>
    </div>
  {/if}
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

  /* Export key modal */
  .export-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .export-modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    min-width: 340px;
    max-width: 440px;
    width: 90vw;
  }

  .export-modal h3 {
    margin: 0 0 0.75rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
  }

  .export-warning {
    color: var(--error);
    font-size: 0.8125rem;
    margin: 0 0 1rem;
    line-height: 1.4;
  }

  .key-display {
    display: block;
    padding: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    word-break: break-all;
    line-height: 1.5;
    margin-bottom: 1rem;
    user-select: all;
  }

  .export-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .copy-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
  }

  .copy-btn:hover {
    background: var(--accent-hover);
  }

  .close-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .close-btn:hover {
    border-color: var(--text-secondary);
    color: var(--text);
  }
</style>
