<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  /**
   * Where the account's keys stand on this device (#186), wherever the person is: a
   * passkey removal under way (it takes a minute or two), one that didn't finish, one
   * that just finished, and the keys having changed from another passkey. Mounted only
   * when there is something to say.
   */

  const STEPS = [
    { step: "keys", label: "Making new keys" },
    { step: "events", label: "Moving your events" },
    { step: "sites", label: "Moving your websites" },
    { step: "profile", label: "Updating your profile" },
    { step: "onchain", label: "Saving onchain" },
  ] as const;
  const ORDER = ["keys", "events", "sites", "profile", "onchain", "after"];

  const progress = $derived(auth.removalProgress);
  const at = $derived(progress ? ORDER.indexOf(progress.step) : -1);

  let finishing = $state(false);
  let error = $state<string | null>(null);

  async function finish(): Promise<void> {
    finishing = true;
    error = null;
    try {
      await auth.finishRemoval();
    } catch (e) {
      error =
        e instanceof Error && (e.name === "PasskeyCeremonyCancelledError" || e.name === "NotAllowedError")
          ? "Nothing changed."
          : e instanceof Error
            ? e.message
            : "Couldn't finish - try again.";
    } finally {
      finishing = false;
    }
  }
</script>

{#if progress}
  <div class="box" role="status" aria-live="polite">
    <p class="title">Securing your account</p>
    <ol class="steps">
      {#each STEPS as s, i (s.step)}
        <li class:done={i < at} class:now={i === at}>
          {s.label}{#if s.step === "events" && progress.step === "events" && progress.total > 0}&nbsp;({progress.done} of {progress.total}){/if}
        </li>
      {/each}
    </ol>
    <p class="body">Keep this page open.</p>
  </div>
{:else if auth.pendingRemoval}
  <div class="box warn" role="alert">
    <p class="title">Removal didn't finish.</p>
    <p class="body">The passkey still works until it does - nothing else changed.</p>
    <div class="pair">
      <button class="btn btn--primary" onclick={finish} disabled={finishing}>{finishing ? "Finishing…" : "Finish removing"}</button>
    </div>
    {#if error}<p class="err">{error}</p>{/if}
  </div>
{:else if auth.removalDone}
  <div class="box" role="status">
    <p class="title">Passkey removed.</p>
    <p class="body">Your account now uses new keys.</p>
    {#if auth.removalDone.hadEvents}
      <p class="body">Door passes made before now have stopped working - make new ones from the event's Check-in tab.</p>
    {/if}
    <div class="pair">
      <button class="btn btn--ghost" onclick={auth.dismissRemovalDone}>Done</button>
    </div>
  </div>
{:else if auth.keyRingNotice === "changed"}
  <div class="box warn" role="alert">
    <p class="body">
      Your account's keys were changed from another of your passkeys. If that wasn't you, remove any passkey you don't recognise.
    </p>
    <div class="pair">
      <button class="btn btn--ghost" onclick={auth.dismissKeyRingNotice}>OK</button>
    </div>
  </div>
{:else if auth.keyRingNotice === "keyless"}
  <div class="box warn" role="alert">
    <p class="body">This passkey doesn't have your account's latest keys. Open WoCo on another of your passkeys to set it up.</p>
  </div>
{/if}

<style>
  .box {
    display: grid;
    gap: 0.5rem;
    margin: 0.75rem 1rem 0;
    padding: 0.9rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .warn {
    border-color: var(--error);
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
  .steps {
    margin: 0;
    padding-left: 1.25rem;
    display: grid;
    gap: 0.25rem;
    color: var(--text-muted);
    font-size: 0.925rem;
  }
  .steps .now {
    color: var(--text);
    font-weight: 600;
  }
  .steps .done {
    color: var(--text-secondary);
  }
  .steps .done::marker {
    content: "✓ ";
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .err {
    margin: 0;
    color: var(--error);
    font-size: 0.875rem;
  }
</style>
