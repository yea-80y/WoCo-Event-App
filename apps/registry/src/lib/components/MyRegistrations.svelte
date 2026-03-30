<script lang="ts">
  import { wallet, connectWallet } from '../wallet/connection.svelte.ts';
  import { getOwnerHashes, verifyHash, revokeHash, type VerificationResult } from '../contract/registry.ts';

  interface HashEntry {
    hash: string;
    result: VerificationResult | null;
    loading: boolean;
  }

  let entries = $state<HashEntry[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  function truncateHash(hash: string): string {
    if (hash.length <= 18) return hash;
    return hash.slice(0, 10) + '...' + hash.slice(-8);
  }

  async function loadMyHashes() {
    if (!wallet.address) return;

    loading = true;
    error = null;

    try {
      const hashes = await getOwnerHashes(wallet.address);
      entries = hashes.map(h => ({ hash: h, result: null, loading: true }));

      // Load details for each hash
      for (let i = 0; i < entries.length; i++) {
        try {
          entries[i].result = await verifyHash(entries[i].hash);
        } catch {
          // Skip failed lookups
        }
        entries[i].loading = false;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load registrations';
    } finally {
      loading = false;
    }
  }

  async function handleRevoke(contentHash: string) {
    if (!wallet.signer || !wallet.chainId) return;

    revoking = contentHash;
    try {
      await revokeHash(wallet.signer, wallet.chainId, contentHash);
      // Reload after revocation
      await loadMyHashes();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Revocation failed';
    } finally {
      revoking = null;
    }
  }

  $effect(() => {
    if (wallet.address) {
      loadMyHashes();
    }
  });
</script>

<div class="my-page">
  <h1>My Registrations</h1>
  <p class="subtitle">Content hashes registered by your connected wallet.</p>

  {#if !wallet.connected}
    <div class="card connect-prompt">
      <p>Connect your wallet to view your registrations.</p>
      <button class="btn btn-primary" onclick={connectWallet} disabled={wallet.connecting}>
        {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    </div>
  {:else if loading}
    <div class="card loading-card">
      <p>Loading your registrations...</p>
    </div>
  {:else if error}
    <div class="card error-card">
      <p>{error}</p>
      <button class="btn btn-secondary" onclick={loadMyHashes}>Retry</button>
    </div>
  {:else if entries.length === 0}
    <div class="card empty-card">
      <p>You haven't registered any content hashes yet.</p>
      <a href="#/register" class="btn btn-primary">Register your first hash</a>
    </div>
  {:else}
    <div class="entries">
      {#each entries as entry}
        <div class="card entry-card" class:revoked={entry.result?.registration?.revoked}>
          <div class="entry-header">
            {#if entry.loading}
              <span class="entry-project">Loading...</span>
            {:else if entry.result?.registration}
              <span class="entry-project">{entry.result.registration.projectName}</span>
              <div class="entry-badges">
                <span class="entry-platform">{entry.result.registration.platform}</span>
                {#if entry.result.registration.revoked}
                  <span class="badge-revoked">Revoked</span>
                {:else}
                  <span class="badge-active">Active</span>
                {/if}
              </div>
            {/if}
          </div>

          <div class="entry-hash" title={entry.hash}>
            {truncateHash(entry.hash)}
          </div>

          {#if entry.result?.registration && !entry.result.registration.revoked}
            <div class="entry-actions">
              <button
                class="btn btn-secondary btn-sm"
                onclick={() => handleRevoke(entry.hash)}
                disabled={revoking === entry.hash}
              >
                {revoking === entry.hash ? 'Revoking...' : 'Revoke'}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .my-page {
    padding-bottom: 3rem;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin: 0 0 0.5rem;
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    margin: 0 0 2rem;
  }

  .connect-prompt,
  .loading-card,
  .error-card,
  .empty-card {
    text-align: center;
    padding: 2rem;
  }

  .connect-prompt p,
  .loading-card p,
  .error-card p,
  .empty-card p {
    color: var(--text-secondary);
    margin: 0 0 1rem;
  }

  .entries {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .entry-card {
    padding: 1rem 1.25rem;
  }

  .entry-card.revoked {
    opacity: 0.6;
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .entry-project {
    font-weight: 600;
    font-size: 0.9375rem;
  }

  .entry-badges {
    display: flex;
    gap: 0.375rem;
  }

  .entry-platform {
    background: var(--bg-elevated);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .badge-active {
    background: var(--success-subtle);
    color: var(--success);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .badge-revoked {
    background: var(--error-subtle);
    color: var(--error);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .entry-hash {
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--accent-text);
    margin-bottom: 0.5rem;
    word-break: break-all;
  }

  .entry-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn-sm {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
  }
</style>
