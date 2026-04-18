<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isWalletAvailable } from "../../wallet/provider.js";
  import {
    connectWallet,
    getConnectedAddress,
    disconnectWallet,
    switchWalletAccount,
    onAccountsChanged,
  } from "../../wallet/connection.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount, onDestroy } from "svelte";

  /** Whether the user has created events (organiser) */
  let isOrganiser = $state(false);
  /** External wallet address connected for payments (passkey/local users) */
  let paymentWallet = $state<string | null>(null);
  let connecting = $state(false);
  let switching = $state(false);
  let disconnecting = $state(false);
  let connectError = $state<string | null>(null);
  /** When true, address-changing actions are blocked (e.g. payment in flight elsewhere) */
  let walletLocked = $state(false);
  let cleanupAccountsListener: (() => void) | null = null;

  const authKindLabel: Record<string, string> = {
    web3: "Web3 Wallet",
    para: "Para Wallet",
    passkey: "Passkey",
    local: "Browser Account",
  };

  /** Whether this user type has a native crypto wallet */
  const hasNativeWallet = $derived(auth.kind === "web3" || auth.kind === "para");

  /** The wallet address to display (native or connected payment wallet) */
  const displayWallet = $derived(hasNativeWallet ? auth.parent : paymentWallet);

  onMount(async () => {
    // Mid-payment lock: if any tab/window is processing a payment, block changes.
    // Set by ClaimButton via window.localStorage("woco:payment-in-flight").
    walletLocked = !!window.localStorage.getItem("woco:payment-in-flight");
    window.addEventListener("storage", handleStorageEvent);

    // Check if user has events (simple organiser detection)
    try {
      const { get } = await import("../../api/client.js");
      const resp = await get<Array<{ creatorAddress: string }>>("/api/events");
      if (resp.ok && resp.data) {
        isOrganiser = resp.data.some(
          (e) => e.creatorAddress.toLowerCase() === auth.parent?.toLowerCase(),
        );
      }
    } catch { /* silent */ }

    // Check if an external wallet is already connected (passkey/local users)
    if (!hasNativeWallet && isWalletAvailable()) {
      const addr = await getConnectedAddress();
      if (addr) paymentWallet = addr;

      // Listen for account changes from MetaMask UI — keep our display in sync.
      cleanupAccountsListener = onAccountsChanged((accounts) => {
        const next = accounts[0]?.toLowerCase() ?? null;
        // Only react to passkey/local users — wallet/para users have their own
        // listener in auth-store that handles full session lifecycle.
        if (!hasNativeWallet) {
          paymentWallet = next;
        }
      });
    }
  });

  onDestroy(() => {
    cleanupAccountsListener?.();
    window.removeEventListener("storage", handleStorageEvent);
  });

  function handleStorageEvent(e: StorageEvent) {
    if (e.key === "woco:payment-in-flight") {
      walletLocked = !!e.newValue;
    }
  }

  async function handleConnectMetaMask() {
    if (walletLocked) {
      connectError = "A payment is in progress. Wait for it to complete before changing wallets.";
      return;
    }
    connecting = true;
    connectError = null;
    try {
      if (!isWalletAvailable()) {
        connectError = "No wallet extension detected. Install MetaMask or another Web3 wallet.";
        return;
      }
      const addr = await connectWallet();
      if (addr) {
        paymentWallet = addr;
        // Re-attach listener on first connect
        if (!cleanupAccountsListener) {
          cleanupAccountsListener = onAccountsChanged((accounts) => {
            if (!hasNativeWallet) paymentWallet = accounts[0]?.toLowerCase() ?? null;
          });
        }
      } else {
        connectError = "Connection cancelled.";
      }
    } catch (err) {
      connectError = err instanceof Error ? err.message : "Failed to connect wallet";
    } finally {
      connecting = false;
    }
  }

  async function handleConnectPara() {
    // Navigate to login flow — Para creates an EVM wallet from email
    navigate("/");
    // The login modal handles Para flow; once they have a Para wallet
    // they can come back and pay with crypto
    // TODO: inline Para wallet creation flow
  }

  async function handleSwitch() {
    if (walletLocked) {
      connectError = "A payment is in progress. Wait for it to complete before changing wallets.";
      return;
    }
    switching = true;
    connectError = null;
    try {
      const addr = await switchWalletAccount();
      if (addr) {
        paymentWallet = addr;
      }
    } catch (err) {
      connectError = err instanceof Error ? err.message : "Failed to switch wallet";
    } finally {
      switching = false;
    }
  }

  async function handleDisconnect() {
    if (walletLocked) {
      connectError = "A payment is in progress. Wait for it to complete before changing wallets.";
      return;
    }
    if (!confirm("Disconnect this wallet? You'll need to reconnect to pay with crypto again.")) {
      return;
    }
    disconnecting = true;
    connectError = null;
    try {
      const revoked = await disconnectWallet();
      paymentWallet = null;
      if (!revoked) {
        connectError = "Wallet still appears connected in your extension. Open MetaMask → connected sites to fully revoke access.";
      }
    } finally {
      disconnecting = false;
    }
  }

  function truncate(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }
</script>

<div class="wallet-tab">
  <!-- Identity section -->
  <section class="wallet-section">
    <h3>Identity</h3>
    <div class="wallet-info-row">
      <span class="wallet-label">Account type</span>
      <span class="wallet-value">{authKindLabel[auth.kind ?? ""] ?? "Not connected"}</span>
    </div>
    {#if auth.parent}
      <div class="wallet-info-row">
        <span class="wallet-label">Address</span>
        <span class="wallet-value wallet-mono" title={auth.parent}>{truncate(auth.parent)}</span>
      </div>
    {/if}
  </section>

  <!-- Payment wallet section -->
  <section class="wallet-section">
    <h3>Payment Wallet</h3>
    {#if hasNativeWallet}
      <div class="wallet-info-row">
        <span class="wallet-label">Wallet</span>
        <span class="wallet-value wallet-mono" title={auth.parent ?? ""}>{truncate(auth.parent ?? "")}</span>
      </div>
      <p class="wallet-note">Your {auth.kind === "web3" ? "connected wallet" : "Para wallet"} is used for crypto payments and receiving funds.</p>
    {:else if paymentWallet}
      <div class="wallet-info-row">
        <span class="wallet-label">Connected wallet</span>
        <span class="wallet-value wallet-mono" title={paymentWallet}>{truncate(paymentWallet)}</span>
      </div>
      <p class="wallet-note">This wallet is used for crypto payments. It's separate from your {auth.kind === "passkey" ? "passkey" : "browser"} identity.</p>
      {#if walletLocked}
        <p class="wallet-lock">Payment in progress — wallet locked until it completes.</p>
      {/if}
      <div class="wallet-actions">
        <button
          class="btn-connect btn-connect--secondary"
          onclick={handleSwitch}
          disabled={switching || disconnecting || walletLocked}
        >
          {switching ? "Switching..." : "Switch wallet"}
        </button>
        <button
          class="btn-connect btn-connect--danger"
          onclick={handleDisconnect}
          disabled={switching || disconnecting || walletLocked}
        >
          {disconnecting ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>
      {#if connectError}
        <p class="wallet-error">{connectError}</p>
      {/if}
    {:else}
      <div class="wallet-empty">
        <p>No crypto wallet connected. Connect one to pay for tickets with ETH or USDC.</p>
        <div class="wallet-connect-actions">
          <button class="btn-connect" onclick={handleConnectMetaMask} disabled={connecting}>
            {#if connecting}
              Connecting...
            {:else}
              Connect MetaMask
            {/if}
          </button>
          <button class="btn-connect btn-connect--secondary" onclick={handleConnectPara}>
            Create wallet with email
          </button>
        </div>
        {#if connectError}
          <p class="wallet-error">{connectError}</p>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Organiser section -->
  {#if isOrganiser}
    <section class="wallet-section">
      <h3>Organiser Payments</h3>
      <div class="wallet-organiser">
        <p>Manage your Stripe account and view payouts from card payments.</p>
        <button class="btn-connect" onclick={() => navigate("/dashboard")}>
          Go to Dashboard
        </button>
      </div>
      {#if displayWallet}
        <div class="wallet-info-row" style="margin-top: 0.75rem;">
          <span class="wallet-label">Crypto payouts to</span>
          <span class="wallet-value wallet-mono" title={displayWallet}>{truncate(displayWallet)}</span>
        </div>
        <p class="wallet-note">Crypto ticket revenue is sent directly to this address (or held in escrow until event completion).</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .wallet-tab {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-top: 0.5rem;
  }

  .wallet-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    background: var(--bg-surface);
  }

  .wallet-section h3 {
    margin: 0 0 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .wallet-info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .wallet-info-row:last-of-type {
    border-bottom: none;
  }

  .wallet-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .wallet-value {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .wallet-mono {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
  }

  .wallet-note {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .wallet-empty {
    padding: 0.5rem 0 0;
  }

  .wallet-empty p {
    margin: 0 0 1rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .wallet-connect-actions {
    display: flex;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .btn-connect {
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
    border: none;
    cursor: pointer;
  }

  .btn-connect:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-connect:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-connect--secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .btn-connect--secondary:hover:not(:disabled) {
    background: var(--bg-elevated);
    border-color: var(--text-secondary);
    color: var(--text);
  }

  .btn-connect--danger {
    background: transparent;
    color: var(--danger, #ef4444);
    border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 30%, transparent);
  }

  .btn-connect--danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent);
    border-color: var(--danger, #ef4444);
  }

  .wallet-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    flex-wrap: wrap;
  }

  .wallet-lock {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: var(--accent-text, #d97706);
    background: color-mix(in srgb, var(--accent, #d97706) 8%, transparent);
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--accent, #d97706) 25%, transparent);
  }

  .wallet-error {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    color: var(--danger, #ef4444);
  }

  .wallet-organiser {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .wallet-organiser p {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }
</style>
