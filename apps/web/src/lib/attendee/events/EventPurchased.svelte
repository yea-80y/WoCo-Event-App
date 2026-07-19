<script lang="ts">
  /**
   * Dedicated post-purchase success page for the main platform.
   *
   * Stripe redirects buyers here after `checkout.session.completed`. We read
   * the form stash that ClaimButton wrote BEFORE the redirect to render the
   * confirmation immediately — no spinner, no polling, no webhook dependency.
   *
   * Standalone ENS sites keep the in-page banner UX (EventPage / ClaimButton);
   * this route only fires for woco.eth.limo / main-platform attendees.
   */
  import { onMount } from "svelte";
  import { navigate } from "../../router/router.svelte.js";
  import { getEvent } from "../../api/events.js";
  import type { EventFeed } from "@woco/shared";
  import { cacheGet, cacheKey } from "../../cache/cache.js";

  interface Props {
    eventId: string;
  }
  let { eventId }: Props = $props();

  // Hydrate sync from sessionStorage so the page renders correct content on
  // first paint. The keys are set in ClaimButton.handleStripeCheckout()
  // immediately before window.location.replace(url).
  function readStash(): { email: string | null; qty: number; seriesId: string | null } {
    if (typeof window === "undefined") return { email: null, qty: 1, seriesId: null };
    try {
      const seriesId = sessionStorage.getItem(`woco:stripe-returning:${eventId}`);
      if (!seriesId) return { email: null, qty: 1, seriesId: null };
      const formRaw = sessionStorage.getItem(`woco:stripe-form:${eventId}:${seriesId}`);
      let email: string | null = null;
      let qty = 1;
      if (formRaw) {
        const parsed = JSON.parse(formRaw) as { claimerEmail?: string; quantity?: number };
        email = parsed.claimerEmail ?? null;
        if (parsed.quantity && Number.isInteger(parsed.quantity)) qty = parsed.quantity;
      }
      return { email, qty, seriesId };
    } catch {
      return { email: null, qty: 1, seriesId: null };
    }
  }

  const _stash = readStash();
  let email = $state(_stash.email);
  let qty = $state(_stash.qty);
  const seriesId = _stash.seriesId;

  // Best-effort event title from cache. Don't block first paint on a fetch —
  // the success card stands alone without it; the line just renders without a
  // title until the fresh GET resolves.
  // svelte-ignore state_referenced_locally
  const _cachedEvent = cacheGet<EventFeed>(cacheKey.event(eventId));
  let eventTitle = $state<string | null>(_cachedEvent?.title ?? null);

  onMount(() => {
    if (!eventTitle) {
      getEvent(eventId).then((fresh) => {
        if (fresh) eventTitle = fresh.title;
      }).catch(() => { /* non-fatal */ });
    }

    // Clean up the form stash now that we've used it. Keep `stripe-returning`
    // for a moment so a refresh of this page still shows the card — sessionStorage
    // dies on tab close, which is the natural lifetime we want.
    if (seriesId) {
      try { sessionStorage.removeItem(`woco:stripe-form:${eventId}:${seriesId}`); } catch { /* ignore */ }
    }
  });

  function clearReturningMarker() {
    // Without this, a back-forward cache hit re-lands the buyer on success.
    try { sessionStorage.removeItem(`woco:stripe-returning:${eventId}`); } catch { /* ignore */ }
  }

  function handleBackToEvent() {
    clearReturningMarker();
    navigate(`/event/${eventId}`);
  }
</script>

<div class="page">
  <div class="card">
    <div class="check" aria-hidden="true">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>

    <h1 class="title">Payment confirmed</h1>
    {#if eventTitle}
      <p class="event-line">{eventTitle}</p>
    {/if}

    <p class="lede">
      {qty > 1 ? `Your ${qty} tickets are` : "Your ticket is"} on the way to your inbox.
    </p>

    <div class="email-card">
      <span class="email-label">Sent to</span>
      {#if email}
        <span class="email-addr">{email}</span>
      {:else}
        <span class="email-addr email-addr--unknown">your email</span>
      {/if}
    </div>

    <ul class="steps">
      <li><span class="bullet"></span>Check your inbox in the next few minutes.</li>
      <li><span class="bullet"></span>If you don't see it, check your spam folder.</li>
      <li><span class="bullet"></span>Show the QR code in the email at the door.</li>
    </ul>

    <!-- Email-only release: tickets are delivered to the inbox; there is no
         on-platform MyTickets collection yet, so don't offer "View my tickets"
         — it would land the buyer on an empty page. Back-to-event only. -->
    <div class="actions">
      <button class="btn-primary" onclick={handleBackToEvent}>Back to event</button>
    </div>

    <p class="foot">
      A receipt has been sent by Stripe. Need help? Contact the organiser.
    </p>
  </div>
</div>

<style>
  .page {
    min-height: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 2.5rem 1rem 3rem;
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    padding: 2.25rem 1.75rem 1.75rem;
    text-align: center;
    box-shadow: 0 24px 48px -16px rgba(0, 0, 0, 0.35);
    animation: rise 360ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .check {
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1.25rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: pop 380ms cubic-bezier(0.2, 0.9, 0.3, 1) 80ms backwards;
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(0.8); }
    to   { opacity: 1; transform: scale(1); }
  }
  .title {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.015em;
    margin: 0 0 0.375rem;
  }
  .event-line {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }
  .lede {
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0 0 1.25rem;
  }
  .email-card {
    background: var(--bg-input, var(--bg-elevated));
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin: 0 0 1.25rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  .email-label {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .email-addr {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    word-break: break-all;
    line-height: 1.3;
  }
  .email-addr--unknown { font-style: italic; color: var(--text-muted); font-weight: 400; }
  .steps {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    text-align: left;
  }
  .steps li {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .bullet {
    flex-shrink: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-muted);
    transform: translateY(-3px);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .btn-primary {
    width: 100%;
    padding: 0.75rem 1rem;
    font-weight: 600;
    font-size: 0.9375rem;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    background: var(--accent);
    color: var(--accent-ink, #fff);
    border: 1px solid var(--accent);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .foot {
    margin: 0.25rem 0 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }
  @media (max-width: 480px) {
    .card { padding: 1.75rem 1.125rem 1.125rem; }
    .title { font-size: 1.3125rem; }
  }
</style>
