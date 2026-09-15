<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    /** A plain "Sign out" button: the member shell puts no account address on screen. */
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  let signingOut = $state(false);
  let signOutError = $state<string | null>(null);

  function truncateAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  const kindLabel = $derived(
    auth.kind === "web3" ? "wallet" : auth.kind === "passkey" ? "passkey" : auth.kind,
  );

  // Sign-out can now FAIL honestly (#182: ending the provider session is part
  // of signing out) — a fire-and-forget click would swallow that and leave the
  // user believing they signed out on a shared device.
  async function handleSignOut() {
    if (signingOut) return;
    signingOut = true;
    signOutError = null;
    try {
      await auth.logout();
    } catch (e) {
      signOutError = e instanceof Error ? e.message : "Sign-out failed — please try again.";
    } finally {
      signingOut = false;
    }
  }
</script>

{#if auth.isConnected && auth.parent}
  {#if compact}
    <button class="signout-text" onclick={handleSignOut} disabled={signingOut}>
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  {:else}
    <div class="session-status">
      <span class="kind-badge">{kindLabel}</span>
      <span class="address" title={auth.parent}>
        {truncateAddress(auth.parent)}
      </span>
      <button class="action-btn logout-btn" onclick={handleSignOut} disabled={signingOut} title="Sign out">
          &#10005;
      </button>
    </div>
  {/if}
  {#if signOutError}
    <p class="signout-error" role="alert">{signOutError}</p>
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

  .signout-text {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    white-space: nowrap;
    transition: color var(--transition);
  }
  .signout-text:hover { color: var(--text); }
  .signout-text:disabled { opacity: 0.6; cursor: default; }

  .signout-error {
    font-size: 0.6875rem;
    color: var(--error);
    max-width: 14rem;
    margin: 0.25rem 0 0;
  }

  @media (max-width: 480px) {
    .address, .kind-badge { display: none; }
  }
</style>
