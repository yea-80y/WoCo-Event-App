<script lang="ts">
  import type { OrderField, ClaimMode, PaymentConfig } from "@woco/shared";
  import EventEditor from "./EventEditor.svelte";
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
  let series = $state<{ seriesId: string; name: string; description: string; totalSupply: number; approvalRequired?: boolean; wave?: string; saleStart?: string; saleEnd?: string; payment?: PaymentConfig }[]>([]);
  let cryptoRecipientMissing = $state(false);
  let claimMode = $state<ClaimMode>("wallet");
  let collectEmail = $state(false);
  let collectInfo = $state(false);
  let orderFields = $state<OrderField[]>([]);
</script>

<div class="event-form">
  <h2>Create Event</h2>

  <EventEditor
    bind:title
    bind:description
    bind:startDate
    bind:endDate
    bind:location
    bind:imageDataUrl
    bind:series
    bind:orderFields
    bind:claimMode
    bind:collectEmail
    bind:collectInfo
    bind:cryptoRecipientMissing
  />

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
    disabled={cryptoRecipientMissing}
    disabledReason={cryptoRecipientMissing ? "Connect a wallet for crypto payouts above, or disable crypto on all tiers." : undefined}
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
</style>
