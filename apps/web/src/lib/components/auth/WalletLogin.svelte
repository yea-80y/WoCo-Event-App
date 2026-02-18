<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { isWalletAvailable } from "../../wallet/provider.js";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();
  let error = $state<string | null>(null);
  let wcConnecting = $state(false);
  // Reactive — MetaMask injects window.ethereum asynchronously after page load,
  // so we poll briefly to catch it. After 2s we stop (wallet truly not present).
  let walletAvailable = $state(isWalletAvailable());
  $effect(() => {
    if (walletAvailable) return;
    let tries = 0;
    const id = setInterval(() => {
      if (isWalletAvailable()) { walletAvailable = true; clearInterval(id); return; }
      if (++tries >= 20) clearInterval(id); // give up after 2s
    }, 100);
    return () => clearInterval(id);
  });
  const isMobile = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  // Deep links open the current page inside the wallet's built-in browser,
  // where window.ethereum is injected automatically.
  const currentUrl = typeof window !== "undefined" ? window.location.href : "";
  const metamaskLink = `https://metamask.app.link/dapp/${typeof window !== "undefined" ? window.location.host + window.location.pathname + window.location.hash : ""}`;
  const trustLink = `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(currentUrl)}`;

  async function handleLogin() {
    error = null;
    const ok = await auth.login("web3");
    if (ok) {
      oncomplete?.();
    } else if (!auth.isConnected) {
      error = "Login cancelled or failed. Please try again.";
    }
  }

  async function handleWalletConnect() {
    wcConnecting = true;
    error = null;
    try {
      const { connectViaWalletConnect } = await import("../../wallet/wc-provider.js");
      const address = await connectViaWalletConnect();
      if (!address) {
        error = "Connection cancelled";
        return;
      }
      const ok = await auth.loginWeb3();
      if (ok) {
        oncomplete?.();
      } else {
        error = "Login failed after wallet connect";
      }
    } catch (e: any) {
      console.error("[WalletLogin] WC error:", e);
      const msg = e?.message || String(e);
      error = `WalletConnect error: ${msg.slice(0, 120)}`;
    } finally {
      wcConnecting = false;
    }
  }
</script>

{#if !walletAvailable}
  <div class="wallet-login">
    <!-- WalletConnect (primary — works on all platforms including mobile browsers) -->
    <button class="wallet-btn wc-btn" onclick={handleWalletConnect} disabled={wcConnecting || auth.busy}>
      <svg class="wallet-icon wc-icon" viewBox="0 0 300 185" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M61.4 36.7c48.9-47.9 128.2-47.9 177.1 0l5.9 5.8a6.1 6.1 0 0 1 0 8.7l-20.1 19.7a3.2 3.2 0 0 1-4.4 0l-8.1-7.9c-34.1-33.4-89.4-33.4-123.5 0l-8.7 8.5a3.2 3.2 0 0 1-4.4 0L54.9 51.8a6.1 6.1 0 0 1 0-8.7l6.5-6.4zm218.6 40.7 17.9 17.5a6.1 6.1 0 0 1 0 8.7L205 196.8a6.3 6.3 0 0 1-8.9 0l-58-56.8a1.6 1.6 0 0 0-2.2 0l-58 56.8a6.3 6.3 0 0 1-8.9 0L-.9 103.6a6.1 6.1 0 0 1 0-8.7l17.9-17.5a6.3 6.3 0 0 1 8.9 0l58 56.8a1.6 1.6 0 0 0 2.2 0l58-56.8a6.3 6.3 0 0 1 8.9 0l58 56.8a1.6 1.6 0 0 0 2.2 0l58-56.8a6.3 6.3 0 0 1 8.9 0z" fill="white"/>
      </svg>
      {wcConnecting ? "Connecting..." : "Connect with WalletConnect"}
    </button>

    {#if isMobile}
      <p class="divider-label">or open directly in:</p>
      <a class="wallet-app-btn metamask" href={metamaskLink} target="_blank" rel="noopener">
        <svg class="wallet-icon" viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M32.958 1L19.47 10.89l2.522-5.965L32.958 1z" fill="#E17726" stroke="#E17726" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2.042 1l13.37 9.981-2.396-6.056L2.042 1z" fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M28.226 23.533l-3.59 5.498 7.68 2.115 2.205-7.48-6.295-.133z" fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M.48 23.666l2.19 7.48 7.665-2.115-3.575-5.498L.48 23.666z" fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Open in MetaMask
      </a>
      <a class="wallet-app-btn trust" href={trustLink} target="_blank" rel="noopener">
        <svg class="wallet-icon" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="20" cy="20" r="20" fill="#3375BB"/>
          <path d="M20 8l-10 4.5v8.3c0 5.8 4.3 11.2 10 12.5 5.7-1.3 10-6.7 10-12.5v-8.3L20 8z" fill="white"/>
          <path d="M17 21.5l-3-3 1.4-1.4 1.6 1.6 4.6-4.6 1.4 1.4-6 6z" fill="#3375BB"/>
        </svg>
        Open in Trust Wallet
      </a>
      <p class="wallet-hint">These open the current page inside the wallet's built-in browser where it can connect.</p>
    {:else}
      <p class="wallet-hint">Scan QR with MetaMask, Trust Wallet, or any WalletConnect-compatible wallet</p>
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
{:else}
  <div class="wallet-login">
    <button
      class="wallet-btn"
      onclick={handleLogin}
      disabled={auth.busy}
    >
      {#if auth.busy}
        Connecting...
      {:else}
        Connect Wallet
      {/if}
    </button>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </div>
{/if}

<style>
  .wallet-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.625rem;
  }

  .wallet-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    transition: background var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
  }

  .wallet-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .wallet-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .wc-btn {
    background: #3b99fc;
  }

  .wc-btn:hover:not(:disabled) {
    background: #2a88eb;
  }

  .wc-icon {
    width: 22px;
    height: 14px;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }

  /* Mobile no-wallet state */
  .divider-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
    text-align: center;
  }

  .wallet-app-btn {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-sm);
    font-size: 0.9375rem;
    font-weight: 600;
    text-decoration: none;
    transition: opacity var(--transition);
  }

  .wallet-app-btn:hover {
    opacity: 0.85;
  }

  .wallet-app-btn.metamask {
    background: #f6851b;
    color: #fff;
  }

  .wallet-app-btn.trust {
    background: #3375bb;
    color: #fff;
  }

  .wallet-icon {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }

  .wallet-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    margin: 0.125rem 0 0;
    line-height: 1.5;
  }
</style>
