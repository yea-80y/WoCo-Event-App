<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  /**
   * A page whose content IS the secret, shown while the account keys are locked
   * (#746 fix 1). The passkey is asked for only when this button is tapped: never on
   * navigation (a sheet nobody asked for gets declined, and Safari refuses one
   * outside a tap), and a declined sheet leaves a page that still works.
   */
  let {
    subject,
    action,
    onUnlocked,
  }: {
    /** What is locked, as the heading's subject: "Attendee details". */
    subject: string;
    /** The button: "Show attendees". */
    action: string;
    /** Runs once the keys are unlocked. Pages that already react to
     *  `auth.hasIdentitySeed` leave it out, or the content loads twice. */
    onUnlocked?: () => void | Promise<void>;
  } = $props();

  let busy = $state(false);
  let declined = $state(false);

  async function unlock(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const ok = await auth.ensureAccountSetup({ identity: true });
      declined = !ok;
      if (ok) await onUnlocked?.();
    } catch {
      declined = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="unlock" role="region" aria-label="{subject} locked">
  <p class="unlock-title">{subject} are locked on this device</p>
  <p class="unlock-body">
    {auth.seedUnavailable
      ? "Your account keys aren't on this device. Sign in again to fetch them."
      : declined
        ? `${subject} stay locked until you confirm it's you.`
        : auth.kind === "passkey"
          ? "Confirm it's you to see them. WoCo asks once each time you open it."
          : "Confirm it's you to see them. WoCo asks once on this device."}
  </p>
  {#if !auth.seedUnavailable}
    <button class="btn btn--primary" onclick={unlock} disabled={busy}>
      {busy ? "Confirming it's you…" : declined ? "Try again" : action}
    </button>
  {/if}
</div>

<style>
  .unlock {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
    padding: 1.1rem;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .unlock-title {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 600;
    color: var(--text);
  }
  .unlock-body {
    margin: 0;
    color: var(--text-secondary);
  }
</style>
