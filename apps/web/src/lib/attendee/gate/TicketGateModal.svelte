<script lang="ts">
  /**
   * Ticket-unlock modal (attendee gate — docs/ATTENDEE_GATE_RESALE_PLAN.md §3).
   *
   * On-chain tickets are unlocked through the link in the ticket email (Route
   * A: HMAC token → /redeem, handled on the signup/landing path). This modal
   * is the answer to a gated action for an account with no binding yet: it
   * checks the live gate status (the user may have redeemed elsewhere) and
   * otherwise points at the ticket email. The old Route B form (ticket link +
   * purchase email → code) and the wallet one-click bind were deleted with the
   * v1 claim rail — both proved possession against v1 claim feeds that
   * on-chain tickets never wrote, so neither could ever succeed for a live
   * ticket.
   *
   * Globally mounted (App.svelte); opened via gate.request().
   */
  import { gate } from "./gate.svelte.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  type Phase = "boot" | "info" | "done";

  let phase = $state<Phase>("boot");
  let alreadyUnlocked = $state(false);

  // Each open gets a token so a stale async boot (user closed mid-flight,
  // reopened) can't write state into the new session.
  let bootToken = 0;

  $effect(() => {
    if (gate.pending) void boot();
    else resetState();
  });

  function resetState() {
    phase = "boot";
    alreadyUnlocked = false;
  }

  async function boot() {
    const token = ++bootToken;
    phase = "boot";

    // The gate binds a ticket TO an account — need one first. The modal
    // stays hidden during boot so LoginModal / the EIP-712 dialog sit alone.
    if (!auth.isConnected) {
      const ok = await loginRequest.request({ context: "attendee" });
      if (token !== bootToken) return;
      if (!ok) { gate.resolve(false); return; }
    }
    const ok = await auth.ensureSession();
    if (token !== bootToken) return;
    if (!ok) { gate.resolve(false); return; }

    const status = await gate.refresh();
    if (token !== bootToken) return;
    if (status?.gated) {
      alreadyUnlocked = true;
      phase = "done";
      return;
    }
    phase = "info";
  }

  function close() {
    bootToken++;
    gate.resolve(phase === "done");
  }
</script>

{#if gate.pending && phase !== "boot"}
  <!-- Backdrop click is a redundant mouse affordance — the Close button is the
       accessible path. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}></div>

  <div class="modal" role="dialog" aria-modal="true" aria-label="Unlock your account with a ticket">
    <div class="modal-head">
      <div class="head-text">
        <span class="kicker">Account unlock</span>
        <span class="title">
          {#if phase === "done"}
            {alreadyUnlocked ? "Already unlocked" : "Account unlocked"}
          {:else}
            Use your ticket
          {/if}
        </span>
      </div>
      <button class="close" onclick={close} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    {#if phase === "info"}
      <div class="body">
        <p class="desc">
          Profiles are unlocked by a ticket. Open the confirmation email for
          your ticket and follow its <strong>set up your profile</strong> link —
          that link is your proof of purchase, and clicking it while signed in
          here unlocks this account.
        </p>
        <p class="desc">
          Can't find the email or the link has expired? Ask the organiser to
          resend your ticket.
        </p>
        <button class="primary-btn" onclick={close}>OK</button>
      </div>

    {:else if phase === "done"}
      <div class="body done">
        <div class="ok-mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <p class="done-desc">
          {#if alreadyUnlocked}
            This account is already unlocked — you're good to go.
          {:else}
            Your ticket is linked to this account. You can now set up your
            profile, claim a name, and follow events.
          {/if}
        </p>
        <button class="primary-btn" onclick={close}>Done</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 900;
    background: rgba(0,0,0,0.65);
    animation: fadein 0.15s ease;
  }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    position: fixed; inset: 0; z-index: 901;
    margin: auto;
    width: min(420px, calc(100% - 2rem));
    height: fit-content;
    max-height: 90dvh;
    overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    animation: popin 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes popin { from { opacity: 0; transform: scale(0.97) translateY(8px); } to { opacity: 1; transform: none; } }

  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    padding: 1rem 1.125rem 0.875rem;
    border-bottom: 1px solid var(--border);
  }
  .head-text { display: flex; flex-direction: column; gap: 0.2rem; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  .title { font-size: 1rem; font-weight: 700; color: var(--text); }
  .close { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.25rem; line-height: 0; }
  .close:hover { color: var(--text); }

  .body { padding: 1rem 1.125rem 1.25rem; display: flex; flex-direction: column; gap: 1rem; }

  .desc { margin: 0; font-size: 0.8125rem; line-height: 1.5; color: var(--text-secondary); }
  .desc strong { color: var(--text); }

  .primary-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
    padding: 0.625rem 1.375rem;
    font-size: 0.8125rem; font-weight: 700;
    background: var(--accent); color: #000;
    border: none; border-radius: var(--radius-sm);
    cursor: pointer; transition: opacity var(--transition), transform 0.1s ease;
    letter-spacing: -0.01em;
  }
  .primary-btn:hover:not(:disabled) { opacity: 0.88; }
  .primary-btn:active:not(:disabled) { transform: scale(0.97); }
  .primary-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  /* done state */
  .done { align-items: center; text-align: center; }
  .ok-mark {
    width: 3rem; height: 3rem; display: grid; place-items: center;
    background: var(--accent); color: #000;
    border-radius: var(--radius-md);
  }
  .done-desc { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.5; max-width: 300px; }
</style>
