<script lang="ts">
  import { wallet, connectWallet } from '../wallet/connection.svelte.ts';
  import { registerHash } from '../contract/registry.ts';

  let contentHash = $state('');
  let projectName = $state('');
  let platform = $state('swarm');
  let ensName = $state('');
  let repoUrl = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let txHash = $state<string | null>(null);

  const platforms = ['swarm', 'ipfs', 'web', 'arweave'];

  const canSubmit = $derived(
    wallet.connected &&
    contentHash.trim().length > 0 &&
    projectName.trim().length > 0 &&
    !submitting
  );

  async function handleSubmit() {
    if (!canSubmit || !wallet.signer || !wallet.chainId) return;

    submitting = true;
    error = null;
    txHash = null;

    try {
      const hash = await registerHash(
        wallet.signer,
        wallet.chainId,
        contentHash.trim(),
        projectName.trim(),
        platform,
        ensName.trim(),
        repoUrl.trim(),
      );
      txHash = hash;
      // Reset form
      contentHash = '';
      projectName = '';
      platform = 'swarm';
      ensName = '';
      repoUrl = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      // Extract revert reason if present
      if (msg.includes('Hash already registered')) {
        error = 'This content hash is already registered. The owner must revoke it first.';
      } else if (msg.includes('user rejected')) {
        error = 'Transaction rejected in wallet.';
      } else {
        error = msg;
      }
    } finally {
      submitting = false;
    }
  }
</script>

<div class="register-page">
  <h1>Register a Content Hash</h1>
  <p class="subtitle">
    Register your frontend deployment hash on-chain so users and wallets can verify
    it's genuine. You'll sign a transaction from the wallet that will be listed as the owner.
  </p>

  {#if !wallet.connected}
    <div class="card connect-prompt">
      <p>Connect your wallet to register a content hash.</p>
      <button class="btn btn-primary" onclick={connectWallet} disabled={wallet.connecting}>
        {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    </div>
  {:else}
    <form class="card register-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <div class="field">
        <label class="label" for="contentHash">Content Hash *</label>
        <input
          id="contentHash"
          type="text"
          placeholder="64-char hex (Swarm ref) or any content hash"
          bind:value={contentHash}
          class="mono-input"
        />
        <span class="hint">Swarm: 64 hex chars. IPFS: paste the CID (will be hashed to bytes32).</span>
      </div>

      <div class="field">
        <label class="label" for="projectName">Project Name *</label>
        <input
          id="projectName"
          type="text"
          placeholder="e.g. WoCo Events, Uniswap, My Dapp"
          bind:value={projectName}
        />
      </div>

      <div class="field">
        <label class="label" for="platform">Platform *</label>
        <select id="platform" bind:value={platform}>
          {#each platforms as p}
            <option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label class="label" for="ensName">ENS Name</label>
        <input
          id="ensName"
          type="text"
          placeholder="e.g. myproject.eth (optional)"
          bind:value={ensName}
        />
      </div>

      <div class="field">
        <label class="label" for="repoUrl">Source Repository</label>
        <input
          id="repoUrl"
          type="text"
          placeholder="e.g. https://github.com/org/repo (optional)"
          bind:value={repoUrl}
        />
      </div>

      {#if error}
        <div class="form-error">{error}</div>
      {/if}

      {#if txHash}
        <div class="form-success">
          Hash registered successfully!
          <a
            href={`https://etherscan.io/tx/${txHash}`}
            target="_blank"
            rel="noopener"
          >
            View transaction
          </a>
        </div>
      {/if}

      <button type="submit" class="btn btn-primary btn-full" disabled={!canSubmit}>
        {submitting ? 'Registering...' : 'Register Hash'}
      </button>
    </form>
  {/if}
</div>

<style>
  .register-page {
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

  .connect-prompt {
    text-align: center;
    padding: 2rem;
  }

  .connect-prompt p {
    color: var(--text-secondary);
    margin: 0 0 1rem;
  }

  .register-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .field {
    display: flex;
    flex-direction: column;
  }

  .mono-input {
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .form-error {
    background: var(--error-subtle);
    color: var(--error);
    padding: 0.625rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
  }

  .form-success {
    background: var(--success-subtle);
    color: var(--success);
    padding: 0.625rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
  }

  .form-success a {
    color: var(--accent-text);
    margin-left: 0.5rem;
  }

  .btn-full {
    width: 100%;
    padding: 0.75rem;
  }
</style>
