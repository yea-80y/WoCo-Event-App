<script lang="ts">
  /**
   * Ticket-unlock modal (attendee gate, Route B — docs/ATTENDEE_GATE_RESALE_PLAN.md §3).
   *
   * Proves rightful possession of a purchased ticket to unlock the account:
   *   - Email path: paste the /t link from the ticket email + the purchase
   *     email → server verifies the QR sig against the on-chain slotOwner and
   *     the email HMAC against the claim record → 6-digit code → binding.
   *   - Wallet path: claims already bound to this wallet on the feed are
   *     linked with one click (no email dance).
   *
   * The attendee's ed25519 POD pubkey is captured at bind time whenever it is
   * available — that is the owner-of-record later stamped into the ClaimedTicket,
   * the seam that makes ownership client-verifiable without the server.
   *
   * Globally mounted (App.svelte); opened via gate.request().
   */
  import { gate } from "./gate.svelte.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import {
    startTicketProof,
    confirmTicketProof,
    bindWalletTickets,
  } from "../../api/attendee-gate.js";
  import { getMyCollection } from "../../api/events.js";

  type Phase = "boot" | "form" | "code" | "done";

  let phase = $state<Phase>("boot");
  let busy = $state(false);
  let errorMsg = $state("");

  let ticketInput = $state("");
  let emailInput = $state("");
  let codeInput = $state("");
  let pendingTicket = $state<{ seriesId: string; edition: number } | null>(null);
  let codeSentTo = $state("");
  let alreadyUnlocked = $state(false);

  interface WalletSeries { eventId: string; seriesId: string; count: number }
  let walletSeries = $state<WalletSeries[]>([]);

  // Each open gets a token so a stale async boot (user closed mid-flight,
  // reopened) can't write state into the new session.
  let bootToken = 0;

  $effect(() => {
    if (gate.pending) void boot();
    else resetState();
  });

  function resetState() {
    phase = "boot";
    busy = false;
    errorMsg = "";
    ticketInput = "";
    emailInput = "";
    codeInput = "";
    pendingTicket = null;
    codeSentTo = "";
    alreadyUnlocked = false;
    walletSeries = [];
  }

  async function boot() {
    const token = ++bootToken;
    phase = "boot";

    // The whole flow binds a ticket TO an account — need one first. The modal
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

    ticketInput = gate.prefillTicket ?? "";
    phase = "form";

    // Wallet-claimed tickets live on the user's collection feed — detect in the
    // background and surface a one-click path when found.
    getMyCollection()
      .then((col) => {
        if (token !== bootToken) return;
        const bySeries = new Map<string, WalletSeries>();
        for (const e of col.entries) {
          const existing = bySeries.get(e.seriesId);
          if (existing) existing.count++;
          else bySeries.set(e.seriesId, { eventId: e.eventId, seriesId: e.seriesId, count: 1 });
        }
        walletSeries = [...bySeries.values()];
      })
      .catch(() => { /* no collection — email path remains */ });
  }

  /** Best-effort POD pubkey for the binding record (owner-of-record seam —
   *  never blocks the unlock if the identity can't be derived right now). */
  async function podPubKey(): Promise<string | undefined> {
    try {
      return (await auth.ensurePodIdentity()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function submitStart(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    errorMsg = "";
    const ticket = ticketInput.trim();
    const email = emailInput.trim();
    if (!ticket || !email) { errorMsg = "Both the ticket link and your email are needed."; return; }
    busy = true;
    try {
      const resp = await startTicketProof(ticket, email);
      if (resp.ok && resp.data) {
        pendingTicket = resp.data;
        codeSentTo = email;
        codeInput = "";
        phase = "code";
      } else {
        errorMsg = resp.error ?? "Could not verify the ticket — try again.";
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Network error — try again.";
    } finally {
      busy = false;
    }
  }

  async function submitCode(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !pendingTicket) return;
    errorMsg = "";
    const code = codeInput.trim();
    if (!/^\d{6}$/.test(code)) { errorMsg = "Enter the 6-digit code from the email."; return; }
    busy = true;
    try {
      const resp = await confirmTicketProof({
        seriesId: pendingTicket.seriesId,
        edition: pendingTicket.edition,
        code,
        podPubKey: await podPubKey(),
      });
      if (resp.ok) {
        void gate.refresh();
        phase = "done";
      } else {
        const err = resp.error ?? "";
        if (err.includes("wrong-code")) {
          errorMsg = "That code isn't right — check the email and try again.";
        } else if (err.includes("expired") || err.includes("not-found") || err.includes("too-many-attempts")) {
          errorMsg = "That code is no longer valid — request a new one.";
          phase = "form";
        } else {
          errorMsg = err || "Verification failed — try again.";
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Network error — try again.";
    } finally {
      busy = false;
    }
  }

  async function linkWalletTickets() {
    if (busy) return;
    errorMsg = "";
    busy = true;
    try {
      const key = await podPubKey();
      let bound = 0;
      let lastError = "";
      for (const s of walletSeries) {
        const resp = await bindWalletTickets({ eventId: s.eventId, seriesId: s.seriesId, podPubKey: key });
        if (resp.ok) bound += resp.data?.bound ?? 1;
        else lastError = resp.error ?? "";
      }
      if (bound > 0) {
        void gate.refresh();
        phase = "done";
      } else {
        errorMsg = lastError || "These tickets could not be linked.";
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Network error — try again.";
    } finally {
      busy = false;
    }
  }

  function close() {
    bootToken++;
    gate.resolve(phase === "done");
  }
</script>

{#if gate.pending && phase !== "boot"}
  <div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}></div>

  <div class="modal" role="dialog" aria-modal="true" aria-label="Unlock your account with a ticket">
    <div class="modal-head">
      <div class="head-text">
        <span class="kicker">Account unlock</span>
        <span class="title">
          {#if phase === "done"}
            {alreadyUnlocked ? "Already unlocked" : "Account unlocked"}
          {:else if phase === "code"}
            Check your email
          {:else}
            Use your ticket
          {/if}
        </span>
      </div>
      <button class="close" onclick={close} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    {#if phase === "form"}
      <div class="body">
        <p class="desc">
          Profiles are unlocked by a ticket. Paste the ticket link from your
          confirmation email and the email address you bought it with —
          we'll send a code to confirm it's yours.
        </p>

        {#if walletSeries.length > 0}
          <button class="wallet-cta" onclick={linkWalletTickets} disabled={busy}>
            {#if busy}<span class="spinner spinner--dark"></span>{:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
            {/if}
            Link the {walletSeries.reduce((n, s) => n + s.count, 0) === 1 ? "ticket" : "tickets"} claimed with this account
          </button>
          <div class="divider"><span>or use a ticket from your email</span></div>
        {/if}

        <form onsubmit={submitStart}>
          <div class="field">
            <label class="f-label" for="gate-ticket">Ticket link</label>
            <input
              id="gate-ticket"
              class="f-input"
              type="text"
              bind:value={ticketInput}
              placeholder="https://…/t/…"
              autocomplete="off"
              spellcheck="false"
            />
            <span class="f-hint">The "View your ticket" link in the email — or the text of its QR code.</span>
          </div>
          <div class="field">
            <label class="f-label" for="gate-email">Purchase email</label>
            <input
              id="gate-email"
              class="f-input"
              type="email"
              bind:value={emailInput}
              placeholder="you@example.com"
              autocomplete="email"
            />
          </div>

          {#if errorMsg}<p class="err-box">{errorMsg}</p>{/if}

          <button class="primary-btn" type="submit" disabled={busy || !ticketInput.trim() || !emailInput.trim()}>
            {#if busy}<span class="spinner spinner--dark"></span> Verifying…{:else}Send code{/if}
          </button>
        </form>
      </div>

    {:else if phase === "code"}
      <div class="body">
        <p class="desc">
          We sent a 6-digit code to <strong>{codeSentTo}</strong>. It expires
          in 10 minutes.
        </p>

        <form onsubmit={submitCode}>
          <div class="field">
            <label class="f-label" for="gate-code">Verification code</label>
            <input
              id="gate-code"
              class="f-input f-input--code"
              type="text"
              inputmode="numeric"
              maxlength="6"
              bind:value={codeInput}
              placeholder="000000"
              autocomplete="one-time-code"
            />
          </div>

          {#if errorMsg}<p class="err-box">{errorMsg}</p>{/if}

          <button class="primary-btn" type="submit" disabled={busy || codeInput.trim().length !== 6}>
            {#if busy}<span class="spinner spinner--dark"></span> Confirming…{:else}Unlock account{/if}
          </button>
        </form>

        <button class="link-btn" onclick={() => { phase = "form"; errorMsg = ""; }}>
          Didn't get it? Start again
        </button>
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
  form { display: flex; flex-direction: column; gap: 1rem; }

  .desc { margin: 0; font-size: 0.8125rem; line-height: 1.5; color: var(--text-secondary); }
  .desc strong { color: var(--text); }

  .field { display: flex; flex-direction: column; gap: 0.375rem; }
  .f-label {
    font-size: 0.6875rem; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .f-input {
    width: 100%; box-sizing: border-box;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text); padding: 0.5625rem 0.75rem;
    font-size: 0.875rem;
    transition: border-color var(--transition);
    outline: none;
  }
  .f-input:focus { border-color: var(--accent); }
  .f-input--code {
    font-family: var(--font-mono, "SF Mono", "Fira Code", monospace);
    font-size: 1.375rem; font-weight: 700; letter-spacing: 0.35em;
    text-align: center;
  }
  .f-hint { font-size: 0.6875rem; color: var(--text-muted); line-height: 1.4; }

  .wallet-cta {
    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
    width: 100%; padding: 0.625rem 1rem;
    font-size: 0.8125rem; font-weight: 700;
    background: var(--accent); color: #000;
    border: none; border-radius: var(--radius-sm);
    cursor: pointer; transition: opacity var(--transition);
    letter-spacing: -0.01em;
  }
  .wallet-cta:hover:not(:disabled) { opacity: 0.88; }
  .wallet-cta:disabled { opacity: 0.5; cursor: not-allowed; }

  .divider {
    display: flex; align-items: center; gap: 0.75rem;
    color: var(--text-muted); font-size: 0.6875rem;
  }
  .divider::before, .divider::after {
    content: ""; flex: 1; height: 1px; background: var(--border);
  }

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

  .link-btn {
    align-self: center;
    background: none; border: none; cursor: pointer;
    font-size: 0.75rem; color: var(--text-muted);
    text-decoration: underline; text-underline-offset: 2px;
    padding: 0.125rem;
    transition: color var(--transition);
  }
  .link-btn:hover { color: var(--accent); }

  .err-box {
    margin: 0;
    background: color-mix(in srgb, var(--error) 8%, transparent);
    color: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 25%, var(--border));
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem; line-height: 1.4;
  }

  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  .spinner--dark { border-color: rgba(0,0,0,0.25); border-top-color: #000; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* done state */
  .done { align-items: center; text-align: center; }
  .ok-mark {
    width: 3rem; height: 3rem; display: grid; place-items: center;
    background: var(--accent); color: #000;
    border-radius: var(--radius-md);
  }
  .done-desc { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.5; max-width: 300px; }
</style>
