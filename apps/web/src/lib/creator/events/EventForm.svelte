<script lang="ts">
  import type { OrderField, ClaimMode, PaymentConfig } from "@woco/shared";
  import EventEditor from "./EventEditor.svelte";
  import PublishButton from "./PublishButton.svelte";
  import SubENSPicker from "../builder/SubENSPicker.svelte";
  import ImportUrlPanel, { type ImportPreview, type ImportTier } from "./ImportUrlPanel.svelte";
  import { localInputFromNow } from "./date.js";
  import { onMount } from "svelte";

  interface Props {
    onpublished?: (eventId: string) => void;
  }

  let { onpublished }: Props = $props();

  let title = $state("");
  let tagline = $state("");
  let description = $state("");
  // Default to sensible future values so the form never starts empty or in the
  // past (a past end date silently blocks ticket sales — the event reads as
  // "already passed"). Start +1h, end +3h; the user adjusts as needed.
  let startDate = $state(localInputFromNow(60));
  let endDate = $state(localInputFromNow(180));
  let location = $state("");
  let imageDataUrl = $state<string | null>(null);
  let series = $state<{ seriesId: string; name: string; description: string; totalSupply: number; approvalRequired?: boolean; wave?: string; saleStart?: string; saleEnd?: string; payment?: PaymentConfig }[]>([]);
  let cryptoRecipientMissing = $state(false);
  let claimMode = $state<ClaimMode>("email");
  let collectEmail = $state(true);
  let collectInfo = $state(false);
  let orderFields = $state<OrderField[]>([]);
  let importedTiers = $state<ImportTier[] | null>(null);

  function applyImport(p: ImportPreview) {
    if (p.name)        title       = p.name;
    if (p.tagline)     tagline     = p.tagline;
    if (p.description) description = p.description;
    if (p.startDate)   startDate   = p.startDate;
    if (p.location)    location    = p.location;
    if (p.tiers && p.tiers.length > 0) importedTiers = p.tiers;
  }

  // Auto-apply prefill if user came here via EventsTab "Create event from this →"
  onMount(() => {
    try {
      const raw = sessionStorage.getItem("woco:import-prefill");
      if (raw) {
        sessionStorage.removeItem("woco:import-prefill");
        applyImport(JSON.parse(raw) as ImportPreview);
      }
    } catch { /* ignore */ }
  });
</script>

<div class="event-form">
  <h2>Create Event</h2>

  <ImportUrlPanel onapply={applyImport} />

  <EventEditor
    bind:title
    bind:tagline
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
    bind:importedTiers
  />

  <SubENSPicker />

  <PublishButton
    {title}
    {tagline}
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
