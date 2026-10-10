<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { unsentLapsOnDevice, type UnsentLaps } from "../../credits/unsent-laps.js";

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
  /**
   * Set when signing out would destroy coaster laps that exist only on this
   * device. Sign-out wipes the lap journal along with every other user-scoped
   * cache — correctly, for a shared family phone — so this is the one place a
   * rider can lose laps they believe are recorded, and the one place to ask.
   * Only THIS control asks: the forced sign-outs on security paths must never
   * be blockable.
   */
  let unsent = $state<UnsentLaps | null>(null);

  async function handleSignOut(opts: { discard?: boolean } = {}) {
    if (signingOut) return;
    if (!opts.discard) {
      const found = unsentLapsOnDevice(auth.parent);
      if (found.waiting > 0 || found.unsealed > 0) {
        unsent = found;
        return;
      }
    }
    unsent = null;
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
    <button class="signout-text" onclick={() => handleSignOut()} disabled={signingOut}>
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  {:else}
    <div class="session-status">
      <span class="kind-badge">{kindLabel}</span>
      <span class="address" title={auth.parent}>
        {truncateAddress(auth.parent)}
      </span>
      <button class="action-btn logout-btn" onclick={() => handleSignOut()} disabled={signingOut} title="Sign out">
          &#10005;
      </button>
    </div>
  {/if}
  {#if unsent}
    <div class="unsent" role="alertdialog" aria-label="Laps not saved yet">
      <p>
        {#if unsent.waiting > 0}
          {unsent.waiting} {unsent.waiting === 1 ? "lap has" : "laps have"} not been sent yet.
        {/if}
        {#if unsent.unsealed > 0}
          Times for {unsent.unsealed} {unsent.unsealed === 1 ? "lap are" : "laps are"} still saving.
        {/if}
        Signing out now discards them. Open the coaster page with signal and they send on their own.
      </p>
      <div class="unsent-actions">
        <button class="signout-text" onclick={() => (unsent = null)}>Stay signed in</button>
        <button class="signout-text discard" onclick={() => handleSignOut({ discard: true })}>Discard and sign out</button>
      </div>
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

  .unsent {
    max-width: 16rem;
    margin: 0.375rem 0 0;
    padding: 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .unsent p { margin: 0; font-size: 0.75rem; line-height: 1.45; color: var(--text-secondary); }
  .unsent-actions { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
  .discard { color: var(--error); }

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
