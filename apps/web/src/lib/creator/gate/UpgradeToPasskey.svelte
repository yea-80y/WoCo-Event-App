<script lang="ts">
  /**
   * An email or Google account's two ways to organise (#746): upgrade THIS account to
   * a passkey in place, or make a separate passkey account. The upgrade keeps the
   * account's address - its tickets, names, profile, likes and follows - and ends its
   * email sign-in. A half-done upgrade on this device is finished or undone here.
   */
  import { untrack } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { PASSKEY_ONLY_RECOVERY_NOTE } from "../../auth/organiser-account.js";
  import { isPasskeySupported } from "../../auth/passkey-account.js";
  import { localMarkerStore, planUpgrade, type UpgradeOffer } from "../../auth/upgrade-to-passkey.js";
  import { hostsSomething } from "../../auth/upgrade-to-passkey-live.js";

  let { onSeparate, separateBusy }: { onSeparate: () => void; separateBusy: boolean } = $props();

  let offer = $state<UpgradeOffer | null>(null);
  let pending = $state(false);
  let confirming = $state(false);
  let running = $state(false);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);

  function readPending(): boolean {
    const parent = auth.parent;
    const marker = parent ? localMarkerStore.read(parent) : null;
    return !!marker && marker.stage === "prepared" && marker.emailKey === auth.seedAddress?.toLowerCase();
  }

  async function load(): Promise<void> {
    offer = null;
    error = null;
    pending = readPending();
    if (pending) return;
    const parent = auth.parent;
    if (!parent) return;
    offer = planUpgrade({
      authKind: auth.kind,
      hostsSomething: await hostsSomething(parent).catch(() => "unknown" as const),
      passkeySupported: isPasskeySupported(),
    });
  }

  // Once per account: the upgrade itself changes the signer under this screen.
  $effect(() => {
    if (auth.parent) untrack(() => void load());
  });

  async function upgrade(): Promise<void> {
    running = true;
    error = null;
    try {
      await auth.upgradeToPasskey({ onProgress: (msg) => (progress = msg) });
      navigate("/creator");
    } catch (e) {
      error = e instanceof Error ? e.message : "The upgrade didn't go through - try again.";
      pending = readPending();
      confirming = false;
    } finally {
      running = false;
      progress = null;
    }
  }

  async function undo(): Promise<void> {
    running = true;
    error = null;
    try {
      await auth.cancelPasskeyUpgrade();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't undo it just now - try again.";
    } finally {
      running = false;
    }
  }
</script>

{#if running && progress}
  <p class="progress" aria-live="polite">{progress}</p>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

{#if pending}
  <div class="choice card">
    <h2>Your upgrade isn't finished</h2>
    <p>Your passkey is ready, but this account still opens with email. Finish to move it over, or undo to leave it as it was.</p>
    <div class="actions">
      <button class="btn btn--primary" onclick={upgrade} disabled={running}>Finish upgrade</button>
      <button class="btn btn--ghost" onclick={undo} disabled={running}>Undo</button>
    </div>
  </div>
{:else if offer === null}
  <p class="muted">Checking your account…</p>
{:else}
  {#if offer.kind === "upgrade"}
    <div class="choice card">
      <h2>Upgrade this account to a passkey</h2>
      <p>Keeps your tickets, names, profile, likes and follows. Email and Google sign-in for this account stop - your passkey opens it from then on.</p>
      {#if confirming}
        <p class="muted">
          Your passkey will be the only way into this account. It syncs through your password manager, so it's on your other devices
          too. Any email backups on this account are removed. {PASSKEY_ONLY_RECOVERY_NOTE}
        </p>
        <div class="actions">
          <button class="btn btn--primary" onclick={upgrade} disabled={running}>{running ? "Upgrading…" : "Upgrade now"}</button>
          <button class="btn btn--ghost" onclick={() => (confirming = false)} disabled={running}>Back</button>
        </div>
      {:else}
        <button class="btn btn--primary" onclick={() => (confirming = true)} disabled={running || separateBusy}>Upgrade to a passkey</button>
      {/if}
    </div>
  {:else}
    <p class={offer.kind === "unavailable" ? "error" : "muted"}>{offer.reason}</p>
    {#if offer.kind === "unavailable"}
      <button class="btn btn--ghost" onclick={load}>Try again</button>
    {/if}
  {/if}

  {#if !confirming}
    <div class="choice card">
      <h2>Make a separate organiser account</h2>
      <p>A new passkey account for hosting. This account keeps your tickets and stays as it is.</p>
      <button class="btn btn--ghost" onclick={onSeparate} disabled={running || separateBusy}>
        {separateBusy ? "Signing out…" : "Create a passkey account"}
      </button>
    </div>
  {/if}
{/if}

<style>
  .choice {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
    padding: 1rem 1.1rem;
    width: 100%;
    box-sizing: border-box;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  p {
    margin: 0;
    color: var(--text);
  }
  .muted,
  .progress {
    color: var(--text-secondary);
  }
  .error {
    color: var(--error);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
