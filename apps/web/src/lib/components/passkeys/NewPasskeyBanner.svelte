<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  /**
   * Shown on this device when a passkey was added to the account since it last
   * looked (#746). Once per app open, only with a session already here, and only for
   * passkey accounts. "No - remove it" asks this device to confirm it's you, as every
   * removal does.
   */

  let added = $state<string[]>([]);
  let working = $state(false);
  let error = $state<string | null>(null);
  let checked = false;

  $effect(() => {
    if (checked || auth.kind !== "passkey" || !auth.hasSession || !auth.parent || !auth.seedAddress || !auth.isAccountOwner) return;
    checked = true;
    const parent = auth.parent;
    const self = auth.seedAddress;
    void import("../../auth/new-passkey-alert.js")
      .then((m) => m.passkeysAddedSinceLastLook(parent, self))
      .then((keys) => (added = keys))
      .catch(() => {});
  });

  async function itWasMe(): Promise<void> {
    if (!auth.parent) return;
    const shown = added;
    added = [];
    (await import("../../auth/new-passkey-alert.js")).acknowledgePasskeys(auth.parent, shown);
  }

  async function removeThem(): Promise<void> {
    working = true;
    error = null;
    const shown = added;
    try {
      // One confirm and one list change for all of them.
      await auth.removePasskeys(shown);
      added = [];
      if (auth.parent) (await import("../../auth/new-passkey-alert.js")).acknowledgePasskeys(auth.parent, shown);
    } catch (e) {
      error = e instanceof Error && e.name !== "PasskeyCeremonyCancelledError" ? e.message : "Nothing was removed.";
    } finally {
      working = false;
    }
  }
</script>

{#if added.length > 0}
  <div class="alert" role="alert">
    <p class="title">{added.length === 1 ? "A new passkey was added to your account" : `${added.length} new passkeys were added to your account`}</p>
    <p class="body">If that wasn't you, remove {added.length === 1 ? "it" : "them"} now - {added.length === 1 ? "it stops" : "they stop"} working straight away.</p>
    <div class="pair">
      <button class="btn btn--ghost" onclick={itWasMe} disabled={working}>Yes, it was me</button>
      <button class="btn btn--danger-outline" onclick={removeThem} disabled={working}>
        {working ? "Removing…" : added.length === 1 ? "No - remove it" : "No - remove them"}
      </button>
    </div>
    {#if error}<p class="err">{error}</p>{/if}
  </div>
{/if}

<style>
  .alert {
    display: grid;
    gap: 0.5rem;
    margin: 0.75rem 1rem 0;
    padding: 0.9rem 1rem;
    border: 1px solid var(--error);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .title {
    margin: 0;
    color: var(--text);
    font-weight: 600;
  }
  .body {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.925rem;
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .btn--danger-outline {
    background: transparent;
    color: var(--error);
    border: 1px solid var(--error);
  }
  .err {
    margin: 0;
    color: var(--error);
    font-size: 0.875rem;
  }
</style>
