<script lang="ts">
  /**
   * The organiser workspace for an account that is not a passkey account (#746
   * step 5): organising needs one, so this says so and offers to make one. The
   * account keeps its tickets, names and profile; the new one is separate.
   */
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { ORGANISER_PASSKEY_MESSAGE } from "../../auth/organiser-account.js";

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function createPasskeyAccount(): Promise<void> {
    busy = true;
    error = null;
    try {
      await auth.logout();
    } catch (e) {
      // Sign-out refuses rather than leave an email session behind (#182); say
      // so here, or the button just stops spinning with nothing explained.
      error = e instanceof Error ? e.message : "Couldn't sign out - please try again.";
      busy = false;
      return;
    }
    try {
      if (await loginRequest.request({ context: "invite" })) navigate("/creator");
    } finally {
      busy = false;
    }
  }
</script>

<section class="needs-passkey">
  <h1>Organising uses a passkey account</h1>
  <p>{ORGANISER_PASSKEY_MESSAGE}</p>
  <p class="muted">Your attendees' details are protected by your passkey, so only you can open them.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="btn btn--primary" onclick={createPasskeyAccount} disabled={busy}>
    {busy ? "Signing out…" : "Create a passkey account"}
  </button>
  <button class="btn btn--ghost" onclick={() => navigate("/")} disabled={busy}>Back to Home</button>
</section>

<style>
  .needs-passkey {
    display: grid;
    gap: 0.85rem;
    justify-items: start;
    max-width: 34rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
  }
  p {
    margin: 0;
    color: var(--text);
  }
  .muted {
    color: var(--text-secondary);
  }
  .error {
    color: var(--error);
  }
</style>
