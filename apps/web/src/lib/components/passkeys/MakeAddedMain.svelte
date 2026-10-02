<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import type { PairedDevice } from "../../auth/device-link.js";

  /**
   * "Make this the main passkey" (#746 step 4), on the main device, for a passkey this
   * device added: no code, both passkeys are here. One tap per passkey sheet - the
   * current main first, then the one in the row. This tab carries on as the new main.
   */

  let {
    target,
    name,
    onchanged,
    onclose,
  }: { target: PairedDevice; name: string | null; onchanged: () => void; onclose: () => void } = $props();

  let stage = $state<"intro" | "confirming" | "second" | "confirming-new" | "changing" | "finishing" | "done" | "failed">("intro");
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let finish: Awaited<ReturnType<typeof auth.prepareMakeAddedMain>>["finish"] | null = null;
  let el = $state<HTMLElement | null>(null);
  let declined = 0;

  const theNew = $derived(name ? `the passkey in ${name}` : "the new passkey");

  // The row's button is further down the page than this panel.
  $effect(() => el?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

  const cancelled = (e: unknown) =>
    e instanceof Error && (e.name === "PasskeyCeremonyCancelledError" || e.name === "NotAllowedError");

  function failed(e: unknown): string {
    return e instanceof Error && !cancelled(e) ? e.message : "Nothing was changed.";
  }

  async function confirmMain(): Promise<void> {
    if (stage !== "intro") return;
    error = null;
    stage = "confirming";
    try {
      ({ finish } = await auth.prepareMakeAddedMain(target));
      stage = "second";
    } catch (e) {
      error = failed(e);
      stage = "intro";
    }
  }

  async function confirmNew(): Promise<void> {
    if (stage !== "second" || !finish) return;
    error = null;
    stage = "confirming-new";
    try {
      const { registered } = await finish((s) => (stage = s));
      if (!registered) note = "Some of your other passkeys are still being updated - this finishes by itself next time you open Your passkeys.";
      stage = "done";
      onchanged();
    } catch (e) {
      if (e instanceof Error && e.name === "MakeMainHandedOverError") {
        // The main passkey changed: never offer to start again (Fable sign-off SHOULD-1).
        error = null;
        finish = null;
        stage = "failed";
        return;
      }
      error = failed(e);
      if (cancelled(e)) {
        // Only the second sheet was declined - or that passkey is gone from this phone.
        if (++declined >= 2) error = `Nothing was changed. If ${theNew} is no longer on this phone, remove it instead.`;
        stage = "second";
        return;
      }
      finish = null;
      stage = "intro";
    }
  }
</script>

<div class="make-added" bind:this={el}>
  {#if stage === "intro" || stage === "confirming"}
    <p>
      Make {theNew} your main passkey? The main passkey is the one that can add or remove passkeys, change names and set
      up backups. Your current one stays as a linked passkey - you can remove it afterwards.
    </p>
    <p class="muted">You'll confirm twice: with your current main passkey, then with {theNew}.</p>
    <button class="btn btn--primary" onclick={confirmMain} disabled={stage === "confirming"}>
      {stage === "confirming" ? "Confirming…" : "Continue"}
    </button>
    <button class="btn btn--ghost" onclick={onclose} disabled={stage === "confirming"}>Not now</button>
  {:else if stage === "second"}
    <p>Now confirm with {theNew}.</p>
    <button class="btn btn--primary" onclick={confirmNew}>Confirm with {theNew}</button>
    <button class="btn btn--ghost" onclick={onclose}>Cancel</button>
  {:else if stage === "confirming-new"}
    <p class="muted">Confirming with {theNew}…</p>
  {:else if stage === "changing" || stage === "finishing"}
    <p class="muted">{stage === "changing" ? "Changing your main passkey…" : "Finishing…"}</p>
  {:else if stage === "failed"}
    <p class="muted">Your main passkey changed, but this tab couldn't switch to it. Sign out, then sign in with {theNew}.</p>
    <button class="btn btn--ghost" onclick={onclose}>Done</button>
  {:else}
    <p class="ok">{name ? `The passkey in ${name}` : "The new passkey"} is now your main passkey. Next time you sign in, use it.</p>
    {#if note}<p class="muted">{note}</p>{/if}
    <button class="btn btn--ghost" onclick={onclose}>Done</button>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</div>

<style>
  .make-added {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
  }
  .make-added p {
    margin: 0;
    color: var(--text-secondary);
  }
  .err {
    margin: 0;
    color: var(--error);
  }
  .ok {
    margin: 0;
    color: var(--accent-text);
  }
</style>
