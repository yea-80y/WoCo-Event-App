<script lang="ts">
  /**
   * Cancel an event and refund everyone (#644). One-way. The organiser types
   * the event's name to confirm; the server checks the same thing, so this is
   * the way in, not the guard. Sales stop and refunds start server-side; the
   * dashboard's CancellationStatus shows the progress.
   */
  import { CANCELLATION_RETURNS_PLATFORM_FEE, PLATFORM_FEE_BP, type EventFeed } from "@woco/shared";
  import type { ContentFeedSigner } from "../../swarm/content-feed.js";
  import { cancelEvent } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    event: EventFeed;
    ordersCount: number;
    oncancelled: (feed: EventFeed) => void;
  }

  let { event, ordersCount, oncancelled }: Props = $props();

  let open = $state(false);
  let typed = $state("");
  let working = $state(false);
  let error = $state<string | null>(null);
  let warning = $state<string | null>(null);

  const matches = $derived(typed.trim() === event.title.trim());
  const platformFeePct = `${PLATFORM_FEE_BP / 100}%`;

  async function confirmCancel() {
    if (!matches || working) return;
    working = true;
    error = null;
    warning = null;
    try {
      // The cancellation itself needs no signing key. The page feed does: a
      // mismatch only means the banner reaches the organiser's own page later.
      let feedSigner: ContentFeedSigner | null = null;
      if (event.creatorFeedSigner) {
        try {
          const signer = await auth.getContentFeedSigner();
          if (signer && signer.address.toLowerCase() === event.creatorFeedSigner.toLowerCase()) feedSigner = signer;
        } catch {
          feedSigner = null;
        }
      }
      const result = await cancelEvent(event.eventId, typed, { feedSigner });
      if (!result.feedUpdated || (event.creatorFeedSigner && !feedSigner)) {
        warning =
          "The event is cancelled and sales have stopped. Its page could not be updated from this account yet - buy buttons already show it as cancelled.";
      }
      if (result.eventFeed) oncancelled(result.eventFeed);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not cancel the event";
    } finally {
      working = false;
    }
  }
</script>

<div class="cancel-zone">
  <h3>Cancel event and refund everyone</h3>

  {#if event.cancelledAt}
    <p class="hint">
      This event was cancelled on {new Date(event.cancelledAt).toLocaleDateString()}. Refund progress is at
      the top of this dashboard.
    </p>
    {#if warning}<p class="warn">{warning}</p>{/if}
  {:else if !open}
    <p class="hint">
      If the event isn't going ahead, cancel it here. Every buyer gets back everything they paid.
    </p>
    <button class="cancel-btn" onclick={() => (open = true)}>Cancel this event</button>
  {:else}
    <div class="explain">
      <p>Straight away:</p>
      <ul>
        <li>ticket sales stop and the event comes off WoCo's listings</li>
        <li>
          {ordersCount > 0 ? `all ${ordersCount} ticket(s) sold are` : "any tickets sold are"} refunded in full -
          everything the buyer paid, including any booking fee, back to the card they used
        </li>
        <li>those tickets stop working at the door</li>
      </ul>
      <p>
        <strong>What it costs you:</strong> the refunds come out of your Stripe balance. Stripe doesn't return its
        processing fee on a refund{CANCELLATION_RETURNS_PLATFORM_FEE
          ? "."
          : `, and WoCo's ${platformFeePct} platform fee isn't returned either (see the organiser terms).`}
        Your balance needs to cover every refund in full - any it can't cover wait until you add funds in Stripe.
      </p>
      <p><strong>This can't be undone.</strong> Afterwards you'll be able to send your attendees a cancellation
        notice - we'll start it for you, and you choose the words.</p>
    </div>

    <label class="confirm">
      <span>Type the event name to confirm: <em>{event.title}</em></span>
      <input bind:value={typed} autocomplete="off" spellcheck="false" />
    </label>

    {#if error}<p class="field-error">{error}</p>{/if}

    <div class="actions">
      <button class="cancel-btn cancel-btn--confirm" onclick={confirmCancel} disabled={!matches || working}>
        {working ? "Cancelling…" : "Cancel event and refund everyone"}
      </button>
      <button class="keep-btn" onclick={() => { open = false; typed = ""; error = null; }} disabled={working}>
        Keep the event
      </button>
    </div>
  {/if}
</div>

<style>
  .cancel-zone {
    margin-top: 1rem;
    border: 1px solid var(--error-subtle);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  h3 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--error);
  }
  .hint,
  .explain {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .explain p {
    margin: 0 0 0.5rem;
  }
  .explain ul {
    margin: 0 0 0.5rem;
    padding-left: 1.1rem;
  }
  .explain strong {
    color: var(--text);
  }
  .warn {
    font-size: 0.8125rem;
    color: var(--warning);
    margin: 0;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }
  .confirm em {
    color: var(--text);
    font-style: normal;
    font-weight: 600;
  }
  .confirm input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.55rem 0.75rem;
    font-size: 0.875rem;
  }
  .confirm input:focus {
    outline: none;
    border-color: var(--error);
  }
  .field-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.625rem;
    flex-wrap: wrap;
  }
  .cancel-btn {
    align-self: flex-start;
    padding: 0.5rem 1.125rem;
    background: transparent;
    border: 1px solid var(--error);
    color: var(--error);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition);
  }
  .cancel-btn:hover:not(:disabled) {
    background: var(--error-subtle);
  }
  .cancel-btn--confirm:not(:disabled) {
    background: var(--error);
    color: var(--bg);
  }
  .cancel-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .keep-btn {
    padding: 0.5rem 1.125rem;
    background: transparent;
    border: 1px solid var(--border-hover);
    color: var(--text);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    cursor: pointer;
  }
</style>
