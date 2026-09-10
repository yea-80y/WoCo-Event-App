<script lang="ts">
  import { accountSetupRequest } from "../../auth/account-setup-request.svelte.js";
  import type { AccountSetupStep } from "../../auth/account-setup-plan.js";

  /**
   * Pre-flight for EXTERNAL WALLETS only. Passkey and web3auth users get our own
   * confirm dialog and need no warm-up; a MetaMask user gets popups we cannot
   * decorate, so the explanation has to happen before the first one.
   *
   * The rail is the whole idea: the steps stay on screen and TICK as each
   * signature lands, so setup reads as a short list being completed rather than
   * as a run of unexplained popups.
   */

  const STEP_COPY: Record<AccountSetupStep, { title: string; sub: string }> = {
    session: {
      title: "Sign in on this device",
      sub: "A 30-day key for this device signs your requests.",
    },
    identity: {
      title: "Unlock your account keys",
      // Every kind that sees this sheet is an external wallet, and for those the
      // seed signature is asked for TWICE on purpose (`verifyDeterminism` in the
      // auth store — a wallet that signs differently twice would give this person
      // an unrecoverable account). Two popups for one row would read as a glitch
      // unless the row says so.
      sub:
        "One signature derives the keys that decrypt your orders and sign what you publish. " +
        "Your wallet asks for it twice, so we can check it signs the same way every time.",
    },
  };

  const pending = $derived(accountSetupRequest.pending);
  const steps = $derived(pending?.steps ?? []);
  const n = $derived(steps.length);

  const title = $derived(
    n === 1 ? STEP_COPY[steps[0]!].title : "Set up your account on this device",
  );

  // No popup count here on purpose: the seed row alone is two wallet prompts
  // (see STEP_COPY.identity), so "2 signatures" would be a promise the wallet
  // breaks. The rail is the count; each row says what it asks for.
  const intro = $derived(
    n === 1
      ? "Your wallet will ask you to approve this. It moves no funds and sends no transaction."
      : "Your wallet will ask you to approve these, in order. Nothing here moves funds or sends a transaction.",
  );

  /**
   * "Nothing was set up" is only true when nothing ticked. Reject the second
   * popup and the first signature really did happen — the rail shows it, and the
   * sentence must not contradict the rail.
   */
  const cancelledLine = $derived(
    (pending?.done.length ?? 0) === 0 ? "Cancelled — nothing was set up." : "Cancelled.",
  );

  let primaryEl = $state<HTMLButtonElement | null>(null);

  const reducedMotion = () => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  // Initial focus lands on the primary button, and returns to it when the sheet
  // flips back to a question after a cancelled run.
  $effect(() => {
    if (pending?.status === "explaining" || pending?.status === "cancelled") {
      primaryEl?.focus();
    }
  });

  // The last tick is the confirmation, so hold it briefly before closing rather
  // than snapping away the moment the work finishes.
  $effect(() => {
    if (pending?.status !== "done") return;
    const t = setTimeout(() => accountSetupRequest.close(), reducedMotion() ? 0 : 700);
    return () => clearTimeout(t);
  });

  function dismiss() {
    // Never dismissable mid-run: the wallet is in front of the user and closing
    // here would leave "did that work?" unanswered.
    if (pending && pending.status !== "running" && pending.status !== "done") {
      accountSetupRequest.respond(false);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" role="presentation" onclick={dismiss}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-setup-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2 id="account-setup-title">{title}</h2>
      <p class="intro">{intro}</p>

      <ol class="rail">
        {#each steps as step (step)}
          {@const done = pending.done.includes(step)}
          <li class="step" class:done>
            <span class="dot" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-6.5"
                  stroke="currentColor"
                  stroke-width="2.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="step-text">
              <strong>{STEP_COPY[step].title}</strong>
              <small>{STEP_COPY[step].sub}</small>
            </span>
            <span class="sr-only">{done ? "signed" : "waiting"}</span>
          </li>
        {/each}
      </ol>

      <p class="status" role="status">
        {#if pending.status === "cancelled"}
          <span class="cancelled">{cancelledLine}</span>
        {:else if pending.status === "running"}
          Check your wallet.
        {:else if pending.status === "done"}
          All set.
        {/if}
      </p>

      {#if pending.status === "explaining"}
        <div class="actions">
          <button class="ghost-btn" onclick={() => accountSetupRequest.respond(false)}>
            Not now
          </button>
          <button
            class="primary-btn"
            bind:this={primaryEl}
            onclick={() => accountSetupRequest.respond(true)}
          >
            Continue
          </button>
        </div>
      {:else if pending.status === "cancelled"}
        <div class="actions">
          <button class="ghost-btn" onclick={() => accountSetupRequest.respond(false)}>
            Close
          </button>
          <button
            class="primary-btn"
            bind:this={primaryEl}
            onclick={() => accountSetupRequest.respond(true)}
          >
            Try again
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .sheet {
    width: min(380px, calc(100vw - 2rem));
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    box-shadow: 0 20px 48px -20px rgba(0, 0, 0, 0.7);
    animation: sheet-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes sheet-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Bottom-anchored on a phone, like the app's other sheet (CreatorShell's
     create menu) — a decision sheet belongs under the thumb, not floating. */
  @media (max-width: 560px) {
    .backdrop { align-items: flex-end; }
    .sheet {
      width: calc(100vw - 1.5rem);
      margin-bottom: calc(0.75rem + env(safe-area-inset-bottom));
    }
  }

  h2 {
    margin: 0 0 0.375rem;
    font-family: var(--font-display);
    font-size: 1.0625rem;
    font-weight: 700;
    color: var(--text);
  }

  .intro {
    margin: 0 0 1.125rem;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  /* ── the rail ──────────────────────────────────────────────────────────── */

  .rail {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .step {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  /* The connector: drawn downward from every step but the last, so the pending
     signatures read as one sequence rather than two unrelated asks. */
  .step:not(:last-child)::before {
    content: "";
    position: absolute;
    left: calc(0.625rem - 0.5px);
    top: 1.25rem;
    bottom: -0.875rem;
    width: 1px;
    background: var(--border);
  }

  .dot {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: transparent;
    transition:
      background var(--transition),
      border-color var(--transition),
      color var(--transition);
  }

  .step.done .dot {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }

  .step-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .step-text strong {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .step.done .step-text strong { color: var(--text); }

  .step-text small {
    font-size: 0.6875rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .status {
    margin: 0.875rem 0 0;
    min-height: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .cancelled { color: var(--error); }

  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .ghost-btn,
  .primary-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .ghost-btn {
    font-weight: 500;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .ghost-btn:hover {
    border-color: var(--text-secondary);
    color: var(--text);
  }

  .primary-btn {
    font-weight: 600;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
    transition: background var(--transition);
  }

  .primary-btn:hover { background: var(--accent-hover); }
  .primary-btn:active { background: var(--accent-press); }

  .ghost-btn:focus-visible,
  .primary-btn:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet { animation: none; }
    .dot,
    .step-text strong { transition: none; }
  }
</style>
