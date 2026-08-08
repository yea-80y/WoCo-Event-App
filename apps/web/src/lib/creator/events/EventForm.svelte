<script lang="ts">
  import type { OrderField, ClaimMode, PaymentConfig, EventGeo, EventTag } from "@woco/shared";
  import EventEditor from "./EventEditor.svelte";
  import PublishButton from "./PublishButton.svelte";
  import StripeVerifyGate from "./StripeVerifyGate.svelte";
  import SubENSPicker from "../builder/SubENSPicker.svelte";
  import ImportUrlPanel, { type ImportPreview, type ImportTier } from "./ImportUrlPanel.svelte";
  import { localInputFromNow } from "./date.js";
  import { onMount } from "svelte";
  import { navigate } from "../../router/router.svelte.js";

  /** Set on publish success — swaps the form for the what-next card. Publishing
   *  used to navigate straight to the event page, which buried the one moment
   *  an organiser is primed to announce the event to their audience. */
  let publishedEventId = $state<string | null>(null);

  let title = $state("");
  let tagline = $state("");
  let description = $state("");
  // Default to sensible future values so the form never starts empty or in the
  // past (a past end date silently blocks ticket sales — the event reads as
  // "already passed"). Start +1h, end +3h; the user adjusts as needed.
  let startDate = $state(localInputFromNow(60));
  let endDate = $state(localInputFromNow(180));
  let location = $state("");
  let geo = $state<EventGeo | undefined>(undefined);
  let tags = $state<EventTag[]>([]);
  let imageDataUrl = $state<string | null>(null);
  let series = $state<{ seriesId: string; name: string; description: string; totalSupply: number; wave?: string; saleStart?: string; saleEnd?: string; payment?: PaymentConfig }[]>([]);
  let cryptoRecipientMissing = $state(false);
  // null = still checking · false = not verified · true = Stripe charges_enabled.
  // Only gates publish when the event actually takes card payments (below).
  let stripeVerified = $state<boolean | null>(null);
  // Card payments settle through Stripe → Stripe verification is required only
  // for events that have card on. Crypto-only events are NOT gated on Stripe
  // (their anti-abuse gate is separate — see docs/EVENT_CREATION_ANTI_ABUSE.md).
  const anyCardEnabled = $derived(series.some((s) => s.payment?.stripeEnabled === true));
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
  {#if publishedEventId}
    <div class="published-card">
      <span class="mark" aria-hidden="true"></span>
      <h2>Your event is live</h2>
      <p class="published-sub">
        Tickets are on sale now. Tell the people who already know you — announcing
        to your audience is what sells the first wave.
      </p>
      <div class="published-actions">
        <button
          class="btn-announce"
          onclick={() => navigate(`/creator/audience?announce=${encodeURIComponent(publishedEventId!)}`)}
        >Announce to your audience</button>
        <button class="btn-view" onclick={() => navigate(`/event/${publishedEventId}`)}>
          View event page
        </button>
      </div>
    </div>
  {:else}
  <h2>Create Event</h2>

  {#if anyCardEnabled}
    <StripeVerifyGate bind:verified={stripeVerified} />
  {/if}

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
    bind:geo
    bind:tags
  />

  <SubENSPicker />

  <PublishButton
    {title}
    {tagline}
    {description}
    {startDate}
    {endDate}
    {location}
    {geo}
    {tags}
    {imageDataUrl}
    {series}
    orderFields={collectInfo ? orderFields : undefined}
    {claimMode}
    disabled={cryptoRecipientMissing || (anyCardEnabled && stripeVerified !== true)}
    disabledReason={anyCardEnabled && stripeVerified !== true
      ? "Verify your Stripe account above to accept card payments — or turn card payments off."
      : cryptoRecipientMissing
        ? "Connect a wallet for crypto payouts above, or disable crypto on all tiers."
        : undefined}
    onpublished={(id) => (publishedEventId = id)}
  />
  {/if}
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

  .published-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.5rem 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
  }

  .published-card .mark {
    width: 12px;
    height: 12px;
    background: var(--accent);
    transform: rotate(45deg);
  }

  .published-sub {
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.55;
    max-width: 42ch;
    margin: 0;
  }

  .published-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 0.25rem;
  }

  .btn-announce {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: background var(--transition);
  }
  .btn-announce:hover { background: var(--accent-hover); }

  .btn-view {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.875rem;
    padding: 0.625rem 1.125rem;
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-view:hover { border-color: var(--border-hover); color: var(--text); }
</style>
