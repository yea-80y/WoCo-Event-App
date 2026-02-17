<script lang="ts">
  import type { OrderField, ClaimMode } from "@woco/shared";
  import ImageUpload from "./ImageUpload.svelte";
  import TicketSeriesEditor from "./TicketSeriesEditor.svelte";
  import OrderFieldsEditor from "./OrderFieldsEditor.svelte";
  import PublishButton from "./PublishButton.svelte";

  interface Props {
    onpublished?: (eventId: string) => void;
  }

  let { onpublished }: Props = $props();

  let title = $state("");
  let description = $state("");
  let startDate = $state("");
  let endDate = $state("");
  let location = $state("");
  let imageDataUrl = $state<string | null>(null);
  let series = $state([
    {
      seriesId: crypto.randomUUID(),
      name: "",
      description: "",
      totalSupply: 10,
    },
  ]);
  let claimMode = $state<ClaimMode>("wallet");
  let collectEmail = $state(false);
  let collectInfo = $state(false);
  let orderFields = $state<OrderField[]>([]);

  // Auto-manage email field based on claim mode + toggle
  const EMAIL_FIELD_ID = "__email";

  // When claim mode changes, set sensible defaults for email collection
  $effect(() => {
    if (claimMode === "email") {
      collectEmail = true; // forced — email is the identity
    } else if (claimMode === "both") {
      // default ON for "both" so organizer can contact everyone
      // (only set on mode change, not every render)
    }
    // "wallet" leaves collectEmail as-is (user toggles manually)
  });

  // Sync the email field in/out of orderFields
  $effect(() => {
    const hasEmail = orderFields.some((f) => f.id === EMAIL_FIELD_ID);
    if (collectEmail && !hasEmail) {
      collectInfo = true;
      orderFields = [
        { id: EMAIL_FIELD_ID, type: "email", label: "Email", required: true, placeholder: "your@email.com" },
        ...orderFields,
      ];
    } else if (!collectEmail && hasEmail) {
      orderFields = orderFields.filter((f) => f.id !== EMAIL_FIELD_ID);
      if (orderFields.length === 0) collectInfo = false;
    }
  });
</script>

<div class="event-form">
  <h2>Create Event</h2>

  <ImageUpload bind:imageDataUrl onchange={(url) => imageDataUrl = url} />

  <div class="fields">
    <label>
      <span>Event title</span>
      <input type="text" bind:value={title} placeholder="My awesome event" />
    </label>

    <label>
      <span>Description</span>
      <textarea bind:value={description} placeholder="Tell people about your event" rows="3"></textarea>
    </label>

    <div class="row">
      <label>
        <span>Start date</span>
        <input type="datetime-local" bind:value={startDate} />
      </label>
      <label>
        <span>End date</span>
        <input type="datetime-local" bind:value={endDate} />
      </label>
    </div>

    <label>
      <span>Location</span>
      <input type="text" bind:value={location} placeholder="Venue or online link" />
    </label>
  </div>

  <TicketSeriesEditor bind:series />

  <fieldset class="claim-mode-section">
    <legend>Claim method</legend>
    <p class="claim-mode-hint">How can attendees claim tickets?</p>
    <div class="claim-mode-options">
      <label class="claim-mode-option">
        <input type="radio" name="claim-mode" value="wallet" bind:group={claimMode} />
        <div>
          <span class="claim-mode-label">Wallet only</span>
          <span class="claim-mode-desc">Attendees connect a crypto wallet</span>
        </div>
      </label>
      <label class="claim-mode-option">
        <input type="radio" name="claim-mode" value="email" bind:group={claimMode} />
        <div>
          <span class="claim-mode-label">Email only</span>
          <span class="claim-mode-desc">Attendees enter their email — no wallet needed</span>
        </div>
      </label>
      <label class="claim-mode-option">
        <input type="radio" name="claim-mode" value="both" bind:group={claimMode} />
        <div>
          <span class="claim-mode-label">Both</span>
          <span class="claim-mode-desc">Attendees choose wallet or email</span>
        </div>
      </label>
    </div>

    {#if claimMode === "email"}
      <p class="claim-mode-note">An email field will be added to the claim form automatically.</p>
    {:else}
      <label class="claim-mode-toggle">
        <input type="checkbox" bind:checked={collectEmail} />
        <span>
          {#if claimMode === "both"}
            Require email from all attendees
          {:else}
            Collect email from attendees
          {/if}
        </span>
      </label>
    {/if}
  </fieldset>

  <OrderFieldsEditor bind:orderFields bind:enabled={collectInfo} />

  <PublishButton
    {title}
    {description}
    {startDate}
    {endDate}
    {location}
    {imageDataUrl}
    {series}
    orderFields={collectInfo ? orderFields : undefined}
    {claimMode}
    {onpublished}
  />
</div>

<style>
  .event-form {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    max-width: 560px;
    margin: 0 auto;
  }

  h2 {
    color: var(--text);
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  /* Claim mode section */
  .claim-mode-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    margin: 0;
  }

  .claim-mode-section legend {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 0 0.375rem;
  }

  .claim-mode-hint {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }

  .claim-mode-options {
    display: flex;
    flex-direction: column;
  }

  .claim-mode-option {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.5rem 0;
    cursor: pointer;
    flex-direction: row;
  }

  .claim-mode-option + .claim-mode-option {
    border-top: 1px solid var(--border);
  }

  .claim-mode-option input[type="radio"] {
    appearance: none;
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 1px;
    cursor: pointer;
    position: relative;
    transition: border-color var(--transition);
    background: transparent;
    padding: 0;
  }

  .claim-mode-option input[type="radio"]:checked {
    border-color: var(--accent);
  }

  .claim-mode-option input[type="radio"]:checked::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 8px;
    height: 8px;
    background: var(--accent);
    border-radius: 50%;
  }

  .claim-mode-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text);
    display: block;
  }

  .claim-mode-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    display: block;
    margin-top: 0.0625rem;
  }

  .claim-mode-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    margin-top: 0.25rem;
    cursor: pointer;
    flex-direction: row;
  }

  .claim-mode-toggle input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  .claim-mode-toggle span {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .claim-mode-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0.5rem 0 0;
    font-style: italic;
  }
</style>
