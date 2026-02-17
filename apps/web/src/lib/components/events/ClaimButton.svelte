<script lang="ts">
  import type { OrderField, SealedBox } from "@woco/shared";
  import { sealJson } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { claimTicket, getClaimStatus } from "../../api/events.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    seriesId: string;
    totalSupply: number;
    /** Organizer's X25519 public key — present when event collects info */
    encryptionKey?: string;
    /** Order form fields — present when event collects info */
    orderFields?: OrderField[];
  }

  let { eventId, seriesId, totalSupply, encryptionKey, orderFields }: Props = $props();

  let status = $state<SeriesClaimStatus | null>(null);
  let claiming = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let claimed = $state(false);
  let claimedEdition = $state<number | null>(null);

  // Order form state
  const hasOrderForm = $derived(!!orderFields?.length && !!encryptionKey);
  let showOrderForm = $state(false);
  let formData = $state<Record<string, string>>({});

  const formValid = $derived(() => {
    if (!orderFields?.length) return true;
    return orderFields.every((f) =>
      !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  onMount(async () => {
    try {
      const userAddr = auth.isConnected ? auth.parent : undefined;
      status = await getClaimStatus(eventId, seriesId, userAddr || undefined);
      if (status?.userEdition != null) {
        claimed = true;
        claimedEdition = status.userEdition;
      }
    } catch {
      // Status check failed, button still shows
    }
  });

  function handleClaimClick() {
    if (hasOrderForm && !showOrderForm) {
      // Show the order form first
      showOrderForm = true;
      return;
    }
    handleClaim();
  }

  async function handleClaim() {
    if (claiming) return;
    claiming = true;
    error = null;

    try {
      // Ensure user is connected (wallet or local account)
      if (!auth.isConnected) {
        step = "Waiting for sign-in...";
        const ok = await loginRequest.request();
        if (!ok) { error = "Login cancelled"; return; }
      }

      // Encrypt order data if form was filled
      let encryptedOrder: SealedBox | undefined;
      if (hasOrderForm && Object.keys(formData).length > 0) {
        step = "Encrypting your info...";
        encryptedOrder = await sealJson(encryptionKey!, {
          fields: formData,
          seriesId,
          claimerAddress: auth.parent,
        });
      }

      step = "Claiming ticket...";
      const result = await claimTicket(eventId, seriesId, auth.parent!, encryptedOrder);

      if (!result.ok) {
        error = result.error || "Failed to claim ticket";
        return;
      }

      claimed = true;
      claimedEdition = result.edition ?? null;
      showOrderForm = false;
      step = "";

      // Refresh status
      const userAddr = auth.parent || undefined;
      status = await getClaimStatus(eventId, seriesId, userAddr);
    } catch (e) {
      error = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      claiming = false;
    }
  }
</script>

<div class="claim-area">
  {#if claimed}
    <div class="claimed-badge">
      <span class="check">&#10003;</span>
      Claimed {#if claimedEdition != null}#{claimedEdition}{/if}
    </div>
  {:else if showOrderForm && orderFields}
    <div class="order-form">
      {#each orderFields as field}
        <label class="form-field">
          <span class="form-label">
            {field.label}
            {#if field.required}<span class="required">*</span>{/if}
          </span>
          {#if field.type === "textarea"}
            <textarea
              bind:value={formData[field.id]}
              placeholder={field.placeholder || ""}
              maxlength={field.maxLength}
              rows="2"
            ></textarea>
          {:else if field.type === "select" && field.options}
            <select bind:value={formData[field.id]}>
              <option value="">Select...</option>
              {#each field.options as opt}
                <option value={opt}>{opt}</option>
              {/each}
            </select>
          {:else if field.type === "checkbox"}
            <label class="checkbox-row">
              <input
                type="checkbox"
                checked={formData[field.id] === "yes"}
                onchange={(e) => formData[field.id] = (e.target as HTMLInputElement).checked ? "yes" : ""}
              />
              <span>{field.placeholder || field.label}</span>
            </label>
          {:else}
            <input
              type={field.type}
              bind:value={formData[field.id]}
              placeholder={field.placeholder || ""}
              maxlength={field.maxLength}
            />
          {/if}
        </label>
      {/each}
      <div class="form-actions">
        <button class="claim-btn" onclick={handleClaim} disabled={claiming || !formValid()}>
          {#if claiming}
            {step}
          {:else}
            Claim ticket
          {/if}
        </button>
        <button class="cancel-btn" onclick={() => showOrderForm = false}>Cancel</button>
      </div>
      <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
    </div>
  {:else}
    <button
      class="claim-btn"
      onclick={handleClaimClick}
      disabled={claiming || (status?.available === 0)}
    >
      {#if claiming}
        {step}
      {:else if status?.available === 0}
        Sold out
      {:else}
        Claim ticket
      {/if}
    </button>
  {/if}

  {#if status && !claimed && !showOrderForm}
    <span class="availability">
      {status.available} / {status.totalSupply} available
    </span>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .claim-area {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.375rem;
  }

  .claim-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background var(--transition);
  }

  .claim-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .claim-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .claimed-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--success);
    border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .check {
    font-size: 0.875rem;
  }

  .availability {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .error {
    color: var(--error);
    font-size: 0.75rem;
    margin: 0;
    text-align: right;
  }

  /* Order form */
  .order-form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    width: 100%;
    min-width: 240px;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .required {
    color: var(--error);
  }

  .order-form input,
  .order-form textarea,
  .order-form select {
    font-size: 0.8125rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
  }

  .order-form input:focus,
  .order-form textarea:focus,
  .order-form select:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .checkbox-row input[type="checkbox"] {
    width: 0.875rem;
    height: 0.875rem;
    accent-color: var(--accent);
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .cancel-btn:hover {
    color: var(--text-secondary);
  }

  .encrypt-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0;
    text-align: right;
  }
</style>
