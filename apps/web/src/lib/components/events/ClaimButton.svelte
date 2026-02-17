<script lang="ts">
  import type { OrderField, SealedBox, ClaimMode } from "@woco/shared";
  import { sealJson } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { claimTicket, claimTicketByEmail, getClaimStatus } from "../../api/events.js";
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
    /** How attendees can claim (default: "wallet") */
    claimMode?: ClaimMode;
  }

  let { eventId, seriesId, totalSupply, encryptionKey, orderFields, claimMode = "wallet" }: Props = $props();

  let status = $state<SeriesClaimStatus | null>(null);
  let claiming = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  let claimed = $state(false);
  let claimedEdition = $state<number | null>(null);
  /** Post-claim message shown instead of the badge subtitle */
  let claimedVia = $state<"wallet" | "email" | null>(null);

  // Order form state
  const hasOrderForm = $derived(!!orderFields?.length && !!encryptionKey);
  let showOrderForm = $state(false);
  let formData = $state<Record<string, string>>({});
  /** When claimMode is "both", which method has the user picked? */
  let chosenMethod = $state<"wallet" | "email" | null>(null);
  /** Inline email input for email claims when no email field in order form */
  let inlineEmail = $state("");
  /** Whether the order form already includes an email-type field */
  const hasEmailField = $derived(
    !!orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );

  const formValid = $derived(() => {
    if (!orderFields?.length) return true;
    return orderFields.every((f) =>
      !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  /** Get the email from form fields or inline input */
  function getEmailFromForm(): string | null {
    // Check __email field first
    const email = formData["__email"]?.trim();
    if (email && email.includes("@")) return email;
    // Check any email-type field in order form
    if (orderFields) {
      for (const f of orderFields) {
        if (f.type === "email") {
          const val = formData[f.id]?.trim();
          if (val && val.includes("@")) return val;
        }
      }
    }
    // Fall back to inline email input
    const inline = inlineEmail.trim();
    if (inline && inline.includes("@")) return inline;
    return null;
  }

  /** Determine the effective claim method for this click */
  function effectiveMethod(): "wallet" | "email" {
    if (claimMode === "wallet") return "wallet";
    if (claimMode === "email") return "email";
    // "both" — use what the user chose, or wallet if connected
    if (chosenMethod) return chosenMethod;
    return auth.isConnected ? "wallet" : "email";
  }

  onMount(async () => {
    try {
      const userAddr = auth.isConnected ? auth.parent : undefined;
      status = await getClaimStatus(eventId, seriesId, userAddr || undefined);
      if (status?.userEdition != null) {
        claimed = true;
        claimedEdition = status.userEdition;
        claimedVia = "wallet";
      }
    } catch {
      // Status check failed, button still shows
    }
  });

  function handleClaimClick(method?: "wallet" | "email") {
    if (method) chosenMethod = method;

    // For "both" mode without a pre-chosen method, always show form first
    // so user can fill fields then pick wallet or email at the bottom
    if (claimMode === "both" && !method && !showOrderForm) {
      showOrderForm = true;
      return;
    }

    if (hasOrderForm && !showOrderForm) {
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
      const method = effectiveMethod();

      if (method === "email") {
        // Email claim: pull email from form, no wallet needed
        const email = getEmailFromForm();
        if (!email) {
          error = "Please enter a valid email address";
          return;
        }

        // Always encrypt claim data for the organizer dashboard
        let encryptedOrder: SealedBox | undefined;
        if (encryptionKey) {
          step = "Encrypting your info...";
          encryptedOrder = await sealJson(encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId,
            claimerEmail: email,
          });
        }

        step = "Claiming ticket...";
        const result = await claimTicketByEmail(eventId, seriesId, email, encryptedOrder);

        if (!result.ok) {
          error = result.error || "Failed to claim ticket";
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "email";
        showOrderForm = false;
        step = "";
      } else {
        // Wallet claim: need connected wallet
        if (!auth.isConnected) {
          step = "Waiting for sign-in...";
          const ok = await loginRequest.request();
          if (!ok) { error = "Login cancelled"; return; }
        }

        // Always encrypt claim data for the organizer dashboard
        let encryptedOrder: SealedBox | undefined;
        if (encryptionKey) {
          step = "Encrypting your info...";
          encryptedOrder = await sealJson(encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
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
        claimedVia = "wallet";
        showOrderForm = false;
        step = "";

        // Refresh status
        const userAddr = auth.parent || undefined;
        status = await getClaimStatus(eventId, seriesId, userAddr);
      }
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
    {#if claimedVia === "email"}
      <p class="claimed-note">Your ticket will be sent to your email by the organizer.</p>
    {:else if claimedVia === "wallet"}
      <p class="claimed-note">Ticket saved to your passport.</p>
    {/if}
  {:else if showOrderForm}
    <div class="order-form">
      {#if orderFields}
        {#each orderFields as field}
          <label class="form-field">
            <span class="form-label">
              {field.label || field.placeholder || field.type}
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
      {/if}

      {#if claimMode === "both" && !hasEmailField}
        <!-- Inline email for email claims when organizer didn't add one -->
        <label class="form-field">
          <span class="form-label">Email <span class="form-label-optional">(for email claim)</span></span>
          <input
            type="email"
            bind:value={inlineEmail}
            placeholder="your@email.com"
          />
        </label>
      {/if}

      <div class="form-actions">
        {#if claimMode === "both"}
          <!-- Both mode: two buttons so user picks their method -->
          {#if claiming}
            <button class="claim-btn" disabled>{step}</button>
          {:else}
            <button
              class="claim-btn"
              onclick={() => { chosenMethod = "wallet"; handleClaim(); }}
              disabled={!formValid()}
            >
              Claim with wallet
            </button>
            <button
              class="claim-btn claim-btn--outline"
              onclick={() => { chosenMethod = "email"; handleClaim(); }}
              disabled={!formValid() || (!hasEmailField && !inlineEmail.trim())}
            >
              Claim with email
            </button>
          {/if}
        {:else}
          <button class="claim-btn" onclick={handleClaim} disabled={claiming || !formValid()}>
            {#if claiming}
              {step}
            {:else if claimMode === "email"}
              Claim with email
            {:else}
              Claim ticket
            {/if}
          </button>
        {/if}
        <button class="cancel-btn" onclick={() => { showOrderForm = false; chosenMethod = null; }}>Cancel</button>
      </div>
      {#if hasOrderForm}
        <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
      {/if}
    </div>
  {:else}
    <button
      class="claim-btn"
      onclick={() => handleClaimClick()}
      disabled={claiming || (status?.available === 0)}
    >
      {#if claiming}
        {step}
      {:else if status?.available === 0}
        Sold out
      {:else if claimMode === "email"}
        Claim with email
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

  .claim-btn--outline {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent-text);
  }

  .claim-btn--outline:hover:not(:disabled) {
    background: var(--accent-subtle);
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

  .claimed-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0;
    text-align: right;
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

  .form-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-style: italic;
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
