<script lang="ts">
  import { isWalletAvailable } from "../../wallet/provider.js";
  import { connectWallet } from "../../wallet/connection.js";

  interface Props {
    /** Called when a wallet is successfully connected */
    onConnect: (address: string) => void;
    /** Called when the modal is dismissed */
    onClose: () => void;
  }

  let { onConnect, onClose }: Props = $props();

  let connecting = $state(false);
  let error = $state<string | null>(null);

  const hasInjectedWallet = isWalletAvailable();

  async function handleMetaMask() {
    if (!hasInjectedWallet) {
      error = "No wallet extension detected. Install MetaMask or another Web3 wallet to continue.";
      return;
    }
    connecting = true;
    error = null;
    try {
      const addr = await connectWallet();
      if (addr) {
        onConnect(addr);
      } else {
        error = "Connection cancelled.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to connect wallet";
    } finally {
      connecting = false;
    }
  }

  function handleParaEmail() {
    // Close modal and redirect to login — Para creates an EVM wallet from email
    onClose();
    // The login modal with Para option will handle it from the nav bar
    import("../../auth/login-request.svelte.js").then(({ loginRequest }) => {
      loginRequest.request();
    });
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={handleBackdrop}>
  <div class="modal-card">
    <div class="modal-header">
      <h3>Connect a wallet</h3>
      <button class="modal-close" onclick={onClose}>&times;</button>
    </div>

    <p class="modal-desc">You need a crypto wallet to pay with ETH or USDC. Choose how to connect:</p>

    <div class="modal-options">
      <button
        class="option-btn"
        onclick={handleMetaMask}
        disabled={connecting}
      >
        <span class="option-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2"/><path d="M2 10h20"/>
          </svg>
        </span>
        <span class="option-text">
          <span class="option-title">{connecting ? "Connecting..." : "Connect MetaMask"}</span>
          <span class="option-sub">Use your existing browser wallet</span>
        </span>
      </button>

      <button class="option-btn" onclick={handleParaEmail}>
        <span class="option-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
          </svg>
        </span>
        <span class="option-text">
          <span class="option-title">Create wallet with email</span>
          <span class="option-sub">Get a wallet via Para (no extension needed)</span>
        </span>
      </button>
    </div>

    {#if error}
      <p class="modal-error">{error}</p>
    {/if}

    <p class="modal-hint">You can also manage your wallet from your <a href="#/profile" onclick={(e: MouseEvent) => { e.preventDefault(); onClose(); import("../../router/router.svelte.js").then(r => r.navigate("/profile")); }}>Profile</a>.</p>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 12px);
    padding: 1.5rem;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .modal-header h3 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
  }

  .modal-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .modal-close:hover {
    color: var(--text);
  }

  .modal-desc {
    margin: 0 0 1.25rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .modal-options {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .option-btn {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    width: 100%;
    padding: 0.875rem 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition);
    text-align: left;
  }

  .option-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-elevated);
  }

  .option-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .option-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--accent-text);
  }

  .option-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .option-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
  }

  .option-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .modal-error {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: var(--danger, #ef4444);
  }

  .modal-hint {
    margin: 1rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
  }

  .modal-hint a {
    color: var(--accent-text);
    text-decoration: underline;
  }
</style>
