<script lang="ts">
  import { verifyHash, type VerificationResult } from '../contract/registry.ts';

  let hashInput = $state('');
  let loading = $state(false);
  let result = $state<VerificationResult | null>(null);
  let error = $state<string | null>(null);

  async function handleVerify() {
    const hash = hashInput.trim();
    if (!hash) return;

    loading = true;
    error = null;
    result = null;

    try {
      result = await verifyHash(hash);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Verification failed';
    } finally {
      loading = false;
    }
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncateAddress(addr: string): string {
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }
</script>

<div class="verify-page">
  <div class="hero">
    <h1>Verify a Content Hash</h1>
    <p class="subtitle">
      Paste a Swarm reference, IPFS CID, or content hash to check if it has been
      registered by a known project owner.
    </p>
  </div>

  <div class="card search-card">
    <div class="search-row">
      <input
        type="text"
        placeholder="Enter content hash (e.g. 64-char hex Swarm ref)"
        bind:value={hashInput}
        onkeydown={(e) => e.key === 'Enter' && handleVerify()}
      />
      <button class="btn btn-primary" onclick={handleVerify} disabled={loading || !hashInput.trim()}>
        {loading ? 'Checking...' : 'Verify'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="card result-card result-error">
      <div class="result-icon">&#x26a0;</div>
      <div class="result-body">
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    </div>
  {/if}

  {#if result}
    {#if result.verified && result.registration}
      <div class="card result-card result-verified">
        <div class="result-icon">&#x2705;</div>
        <div class="result-body">
          <h3>Verified</h3>
          <p>This content hash is registered and active.</p>

          <div class="reg-details">
            <div class="detail-row">
              <span class="label">Project</span>
              <span class="value">{result.registration.projectName}</span>
            </div>
            <div class="detail-row">
              <span class="label">Platform</span>
              <span class="value platform-badge">{result.registration.platform}</span>
            </div>
            <div class="detail-row">
              <span class="label">Owner</span>
              <span class="value mono">{truncateAddress(result.registration.owner)}</span>
            </div>
            {#if result.registration.ensName}
              <div class="detail-row">
                <span class="label">ENS</span>
                <span class="value">{result.registration.ensName}</span>
              </div>
            {/if}
            {#if result.registration.repoUrl}
              <div class="detail-row">
                <span class="label">Repo</span>
                <a class="value" href={result.registration.repoUrl} target="_blank" rel="noopener">
                  {result.registration.repoUrl}
                </a>
              </div>
            {/if}
            <div class="detail-row">
              <span class="label">Registered</span>
              <span class="value">{formatDate(result.registration.registeredAt)}</span>
            </div>
          </div>
        </div>
      </div>
    {:else if result.registration && result.registration.revoked}
      <div class="card result-card result-revoked">
        <div class="result-icon">&#x1f6ab;</div>
        <div class="result-body">
          <h3>Revoked</h3>
          <p>
            This content hash was previously registered by
            <span class="mono">{truncateAddress(result.registration.owner)}</span>
            but has been revoked. It may no longer be safe.
          </p>
        </div>
      </div>
    {:else}
      <div class="card result-card result-unknown">
        <div class="result-icon">&#x2753;</div>
        <div class="result-body">
          <h3>Not Registered</h3>
          <p>
            This content hash is not in the registry. This doesn't necessarily mean
            it's malicious — the project owner may not have registered it yet.
          </p>
        </div>
      </div>
    {/if}
  {/if}

  <div class="info-section">
    <h2>What is this?</h2>
    <p>
      The World Computer Registry is an on-chain record of verified frontend content hashes.
      When a project deploys its app to Swarm, IPFS, or any hosting platform, the owner
      registers the content hash here. Users and wallets can then verify that a frontend
      is genuine before interacting with it.
    </p>
    <div class="use-cases">
      <div class="use-case">
        <strong>Anti-phishing</strong>
        <span>Detect cloned frontends before they steal your funds</span>
      </div>
      <div class="use-case">
        <strong>Decentralised trust</strong>
        <span>No central authority — project owners self-register on Ethereum</span>
      </div>
      <div class="use-case">
        <strong>Wallet integration</strong>
        <span>Wallets can query the registry before showing signing prompts</span>
      </div>
    </div>
  </div>
</div>

<style>
  .verify-page {
    padding-bottom: 3rem;
  }

  .hero {
    text-align: center;
    margin-bottom: 2rem;
  }

  .hero h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin: 0 0 0.5rem;
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    max-width: 480px;
    margin: 0 auto;
  }

  .search-card {
    margin-bottom: 1.5rem;
  }

  .search-row {
    display: flex;
    gap: 0.75rem;
  }

  .search-row input {
    flex: 1;
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .search-row .btn {
    white-space: nowrap;
  }

  .result-card {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
    align-items: flex-start;
  }

  .result-icon {
    font-size: 2rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .result-body h3 {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
  }

  .result-body p {
    margin: 0 0 0.75rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .result-verified {
    border-color: var(--success);
    background: var(--success-subtle);
  }

  .result-verified h3 {
    color: var(--success);
  }

  .result-revoked {
    border-color: var(--warning);
    background: var(--warning-subtle);
  }

  .result-revoked h3 {
    color: var(--warning);
  }

  .result-unknown {
    border-color: var(--border-hover);
  }

  .result-error {
    border-color: var(--error);
    background: var(--error-subtle);
  }

  .result-error h3 {
    color: var(--error);
  }

  .reg-details {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .detail-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .detail-row .label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-width: 80px;
    margin-bottom: 0;
  }

  .detail-row .value {
    font-size: 0.875rem;
    color: var(--text);
  }

  .mono {
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .platform-badge {
    background: var(--bg-elevated);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .info-section {
    margin-top: 3rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border);
  }

  .info-section h2 {
    font-size: 1.25rem;
    margin: 0 0 0.75rem;
  }

  .info-section > p {
    color: var(--text-secondary);
    font-size: 0.875rem;
    line-height: 1.6;
    margin: 0 0 1.5rem;
  }

  .use-cases {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .use-case {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .use-case strong {
    font-size: 0.875rem;
  }

  .use-case span {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  @media (max-width: 640px) {
    .search-row {
      flex-direction: column;
    }

    .detail-row {
      flex-direction: column;
      gap: 0.125rem;
    }

    .detail-row .label {
      min-width: unset;
    }
  }
</style>
