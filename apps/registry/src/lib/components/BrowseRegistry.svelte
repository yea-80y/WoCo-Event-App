<script lang="ts">
  import { queryRegistrations, getRegistrationCount } from '../contract/registry.ts';

  interface RegistrationEntry {
    contentHash: string;
    owner: string;
    projectName: string;
    platform: string;
    blockNumber: number;
  }

  let entries = $state<RegistrationEntry[]>([]);
  let totalCount = $state<number | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  function truncateHash(hash: string): string {
    if (hash.length <= 18) return hash;
    return hash.slice(0, 10) + '...' + hash.slice(-8);
  }

  function truncateAddress(addr: string): string {
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  async function loadRegistrations() {
    loading = true;
    error = null;

    try {
      const [regs, count] = await Promise.all([
        queryRegistrations(),
        getRegistrationCount(),
      ]);
      entries = regs.reverse(); // Most recent first
      totalCount = count;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load registrations';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loadRegistrations();
  });
</script>

<div class="browse-page">
  <h1>Browse Registry</h1>
  <p class="subtitle">
    All content hashes registered on the World Computer Registry.
    {#if totalCount !== null}
      <strong>{totalCount}</strong> total registrations.
    {/if}
  </p>

  {#if loading}
    <div class="card loading-card">
      <p>Loading registrations...</p>
    </div>
  {:else if error}
    <div class="card error-card">
      <p>{error}</p>
      <button class="btn btn-secondary" onclick={loadRegistrations}>Retry</button>
    </div>
  {:else if entries.length === 0}
    <div class="card empty-card">
      <p>No registrations yet. Be the first to <a href="#/register">register a hash</a>.</p>
    </div>
  {:else}
    <div class="entries">
      {#each entries as entry}
        <div class="card entry-card">
          <div class="entry-header">
            <span class="entry-project">{entry.projectName}</span>
            <span class="entry-platform">{entry.platform}</span>
          </div>
          <div class="entry-hash" title={entry.contentHash}>
            {truncateHash(entry.contentHash)}
          </div>
          <div class="entry-footer">
            <span class="entry-owner" title={entry.owner}>
              {truncateAddress(entry.owner)}
            </span>
            <span class="entry-block">Block #{entry.blockNumber.toLocaleString()}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .browse-page {
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

  .loading-card,
  .error-card,
  .empty-card {
    text-align: center;
    padding: 2rem;
  }

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

  .entry-platform {
    background: var(--bg-elevated);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .entry-hash {
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--accent-text);
    margin-bottom: 0.5rem;
    word-break: break-all;
  }

  .entry-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .entry-owner {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .entry-block {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
