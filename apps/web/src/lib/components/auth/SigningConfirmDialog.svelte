<script lang="ts">
  import { signingRequest } from "../../auth/signing-request.svelte.js";

  /**
   * The one prompt a passkey/web3auth user ever sees for account setup — their
   * session signature is silent, so this dialog IS the consent moment. It used
   * to render only the EIP-712 type name and the raw fields, which named the
   * bytes correctly and explained nothing.
   *
   * `action` is the EIP-712 type name (local-signer.ts / passkey-signer.ts pass
   * it straight through), so it is a stable key we can attach human copy to. The
   * raw material never goes away — it moves behind a disclosure, because a
   * signature request that hides what it signs is worse than an unreadable one.
   */

  type HumanCopy = { title: string; body: string; primary: string; secondary: string };

  const HUMAN: Record<string, HumanCopy> = {
    DeriveAccountKeys: {
      title: "Unlock your account keys",
      body:
        "This one-off signature derives the keys that decrypt your orders and sign what you publish. " +
        "It's the same every time, so it works on any device. It moves no funds and sends no transaction.",
      primary: "Unlock",
      secondary: "Not now",
    },
    AuthorizeSession: {
      title: "Sign in on this device",
      body:
        "Creates a key for this device that signs your requests for 30 days. " +
        "Sign out any time to revoke it.",
      primary: "Sign in",
      secondary: "Cancel",
    },
  };

  const pending = $derived(signingRequest.pending);
  const human = $derived(pending ? (HUMAN[pending.action] ?? null) : null);

  let signEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (pending) signEl?.focus();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && signingRequest.pending) {
      signingRequest.respond(false);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" role="presentation" onclick={() => signingRequest.respond(false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signing-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header>
        <h2 id="signing-title">{human ? human.title : "Confirm signature"}</h2>
      </header>

      {#if human}
        <p class="body">{human.body}</p>

        <details class="raw">
          <summary>Show what you're signing</summary>
          <div class="details">
            <div class="detail-row">
              <span class="label">Domain</span>
              <span class="value">{pending.domainName}</span>
            </div>
            <div class="fields">
              {#each pending.fields as field}
                <div class="field">
                  <span class="field-label">{field.label}</span>
                  <span class="field-value">{field.value}</span>
                </div>
              {/each}
            </div>
          </div>
          <p class="fixed-names">The technical names are fixed and can't be renamed.</p>
        </details>
      {:else}
        <div class="details">
          <div class="detail-row">
            <span class="label">Action</span>
            <span class="value">{pending.action}</span>
          </div>
          <div class="detail-row">
            <span class="label">Domain</span>
            <span class="value">{pending.domainName}</span>
          </div>

          <div class="fields">
            {#each pending.fields as field}
              <div class="field">
                <span class="field-label">{field.label}</span>
                <span class="field-value">{field.value}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="actions">
        <button class="cancel-btn" onclick={() => signingRequest.respond(false)}>
          {human ? human.secondary : "Cancel"}
        </button>
        <button class="sign-btn" bind:this={signEl} onclick={() => signingRequest.respond(true)}>
          {human ? human.primary : "Sign"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    width: min(440px, calc(100vw - 2rem));
    animation: modal-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes modal-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  header {
    margin-bottom: 0.75rem;
  }

  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
  }

  .body {
    margin: 0 0 1.25rem;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-secondary);
  }

  .raw {
    margin-bottom: 1.5rem;
  }

  summary {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem 0;
    list-style-position: inside;
  }

  summary:hover { color: var(--text); }

  summary:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .raw .details { margin-top: 0.625rem; }

  .fixed-names {
    margin: 0.5rem 0 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .raw .details { margin-bottom: 0; }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }

  .label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .value {
    font-size: 0.8125rem;
    color: var(--text);
    font-weight: 600;
    word-break: break-all;
  }

  .fields {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .field-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .field-value {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    word-break: break-all;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .cancel-btn:hover {
    border-color: var(--text-secondary);
    color: var(--text);
  }

  .sign-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    transition: background var(--transition);
  }

  .sign-btn:hover { background: var(--accent-hover); }
  .sign-btn:active { background: var(--accent-press); }

  .cancel-btn:focus-visible,
  .sign-btn:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .modal { animation: none; }
  }
</style>
