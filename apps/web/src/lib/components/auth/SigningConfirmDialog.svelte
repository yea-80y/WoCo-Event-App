<script lang="ts">
  import { signingRequest } from "../../auth/signing-request.svelte.js";

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && signingRequest.pending) {
      signingRequest.respond(false);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if signingRequest.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="backdrop" role="presentation" onclick={() => signingRequest.respond(false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm signing" onclick={(e) => e.stopPropagation()}>
      <header>
        <h2>Confirm Signature</h2>
      </header>

      <div class="details">
        <div class="detail-row">
          <span class="label">Action</span>
          <span class="value">{signingRequest.pending.action}</span>
        </div>
        <div class="detail-row">
          <span class="label">Domain</span>
          <span class="value">{signingRequest.pending.domainName}</span>
        </div>

        <div class="fields">
          {#each signingRequest.pending.fields as field}
            <div class="field">
              <span class="field-label">{field.label}</span>
              <span class="field-value">{field.value}</span>
            </div>
          {/each}
        </div>
      </div>

      <div class="actions">
        <button class="cancel-btn" onclick={() => signingRequest.respond(false)}>
          Cancel
        </button>
        <button class="sign-btn" onclick={() => signingRequest.respond(true)}>
          Sign
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
    min-width: 340px;
    max-width: 440px;
    width: 90vw;
  }

  header {
    margin-bottom: 1.25rem;
  }

  h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text);
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
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
    font-family: "SF Mono", "Fira Code", monospace;
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
    color: #fff;
    transition: background var(--transition);
  }

  .sign-btn:hover {
    background: var(--accent-hover);
  }
</style>
