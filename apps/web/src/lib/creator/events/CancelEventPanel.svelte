<script lang="ts">
  /**
   * Cancel an event and refund everyone (#644). One-way. The organiser types
   * the event's name to confirm; the server checks the same thing, so this is
   * the way in, not the guard. Sales stop and refunds start server-side; the
   * dashboard's CancellationStatus shows the progress.
   */
  import {
    CANCELLATION_RETURNS_PLATFORM_FEE,
    ORGANISER_CANCEL_WINDOW_DAYS,
    PLATFORM_FEE_BP,
    organiserCancelClosesAt,
    type EventFeed,
  } from "@woco/shared";
  import type { ContentFeedSigner } from "../../swarm/content-feed.js";
  import { cancelEvent } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import type { Ledger2RelayItem } from "@woco/shared/ticket/ledger2-terms";
  import { relayMessage, type Ledger2EventView } from "../../ledger2/organiser-changes.js";

  interface Props {
    event: EventFeed;
    ordersCount: number;
    /** `feedUpdated` false: sales have stopped, but the organiser's own page feed still lacks the banner. */
    oncancelled: (feed: EventFeed, feedUpdated: boolean) => void;
  }

  let { event, ordersCount, oncancelled }: Props = $props();

  let open = $state(false);
  // The page feed needs the account keys; asked for on the tap that opens the form,
  // so nothing prompts between the final press and the refunds (#746 fix 1).
  let asking = $state(false);
  let pageLocked = $state(false);
  let typed = $state("");
  let working = $state(false);
  let error = $state<string | null>(null);

  // Same comparison the server makes: Unicode form and runs of spaces don't matter.
  const norm = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
  const matches = $derived(norm(typed) === norm(event.title));
  // Owner policy: refunds are for events that do not take place. Cancelling one
  // that already happened refunds people who came, so it is said plainly.
  const alreadyEnded = $derived(Date.parse(event.endDate || event.startDate) < Date.now());
  // The server refuses past this too; here it only swaps the button for the reason.
  const windowClosed = $derived.by(() => {
    const closesAt = organiserCancelClosesAt(event);
    return closesAt !== null && Date.now() > closesAt;
  });
  const platformFeePct = `${PLATFORM_FEE_BP / 100}%`;

  async function openForm() {
    if (asking) return;
    if (event.creatorFeedSigner) {
      asking = true;
      try {
        pageLocked = !(await auth.ensureAccountSetup({ identity: true }));
      } catch {
        pageLocked = true;
      } finally {
        asking = false;
      }
    }
    open = true;
  }

  // A ledger2 event also cancels where its tickets are recorded, by the organiser's
  // signature. Read here so the panel can say when that part is still to do, or when
  // the event was cancelled from elsewhere and only the refunds are left to confirm.
  let ledger2 = $state<Ledger2EventView | null>(null);
  let finishing = $state(false);
  let finishMsg = $state<string | null>(null);
  $effect(() => {
    const parent = auth.parent?.toLowerCase();
    void event.cancelledAt;
    if (!parent) return;
    let live = true;
    void readView(parent).then((v) => {
      if (live) ledger2 = v;
    });
    return () => {
      live = false;
    };
  });
  const cancelledElsewhere = $derived(!event.cancelledAt && !!ledger2?.series.some((s) => s.cancelled));
  const chainLeft = $derived(event.cancelledAt ? (ledger2?.series.filter((s) => !s.cancelled) ?? []) : []);

  async function readView(parent: string): Promise<Ledger2EventView | null> {
    const [{ readLedger2Event }, { liveLedger2ClientIO }] = await Promise.all([
      import("../../ledger2/organiser-changes.js"),
      import("../../ledger2/organiser-changes-live.js"),
    ]);
    return readLedger2Event(event, parent, liveLedger2ClientIO).catch(() => null);
  }

  /**
   * The signed cancels for every ticket type not yet cancelled, or none. Best effort:
   * a chain that cannot be read, or a key that cannot sign, never stops the
   * cancellation itself - money stops server-side, and "Finish cancelling" does the rest.
   */
  async function signCancels(): Promise<Ledger2RelayItem[] | undefined> {
    const parent = auth.parent?.toLowerCase();
    if (!parent) return undefined;
    try {
      const [{ readLedger2Event, signTermsChanges }, { liveLedger2ClientIO: io }] = await Promise.all([
        import("../../ledger2/organiser-changes.js"),
        import("../../ledger2/organiser-changes-live.js"),
      ]);
      const view = await readLedger2Event(event, parent, io);
      const open = view?.series.filter((s) => !s.cancelled) ?? [];
      if (!view || open.length === 0) return undefined;
      return await signTermsChanges(view, open.map((s) => ({ kind: "cancel" as const, seriesId: s.seriesId })), io);
    } catch (e) {
      console.warn("[cancel] could not sign the ticket-record cancels; cancelling without them:", e);
      return undefined;
    }
  }

  /** Codes that refuse what was SIGNED: the cancellation goes ahead without it. */
  const SIGNED_REFUSALS = new Set(["signature_stale", "already_cancelled", "not_available", "series_not_found", "window_invalid", "signature_not_yet_valid", "signature_expiring", "deadline_too_far"]);

  async function cancelWithChain(confirmTitle: string, feedSigner: ContentFeedSigner | null) {
    const chainCancels = await signCancels();
    try {
      return await cancelEvent(event.eventId, confirmTitle, { feedSigner, chainCancels });
    } catch (e) {
      if (!chainCancels || !SIGNED_REFUSALS.has((e as { code?: string }).code ?? "")) throw e;
      return cancelEvent(event.eventId, confirmTitle, { feedSigner });
    }
  }

  async function finishCancelling() {
    if (finishing) return;
    finishing = true;
    finishMsg = null;
    try {
      await auth.ensureOrganiserUnlock();
      const chainCancels = await signCancels();
      if (!chainCancels) {
        finishMsg = "Couldn't finish just now. Try again in a moment.";
        return;
      }
      const result = await cancelEvent(event.eventId, event.title, { chainCancels });
      const done = result.chain?.status === "landed" && (result.chain.landed ?? []).every(Boolean);
      finishMsg = done ? "Done - the cancellation is complete." : "Not finished yet. Try again in a moment.";
      const parent = auth.parent?.toLowerCase();
      if (parent) ledger2 = await readView(parent);
    } catch (e) {
      finishMsg = relayMessage(e) ?? (e instanceof Error ? e.message : "Couldn't finish just now. Try again in a moment.");
    } finally {
      finishing = false;
    }
  }

  async function confirmCancel() {
    if (!matches || working) return;
    working = true;
    error = null;
    try {
      // Silent inside the window the form opened in; a form left open past it asks
      // again before anything is refunded.
      await auth.ensureOrganiserUnlock();
      // The cancellation itself needs no signing key. The page feed does, and only
      // keys unlocked when the form opened are used: no prompt mid-cancellation.
      let feedSigner: ContentFeedSigner | null = null;
      if (event.creatorFeedSigner) {
        try {
          const signer = await auth.getContentFeedSignerIfPresent();
          if (signer && signer.address.toLowerCase() === event.creatorFeedSigner.toLowerCase()) feedSigner = signer;
        } catch {
          feedSigner = null;
        }
      }
      const result = await cancelWithChain(typed, feedSigner);
      oncancelled(result.eventFeed ?? { ...event, cancelledAt: new Date().toISOString() }, result.feedUpdated);
    } catch (e) {
      error = relayMessage(e) ?? (e instanceof Error ? e.message : "Could not cancel the event");
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
    {#if chainLeft.length > 0}
      <p class="warn">
        One step is left: finish cancelling so every ticket checker sees it too. Sales have already stopped and
        refunds are under way.
      </p>
      <button class="cancel-btn" onclick={finishCancelling} disabled={finishing}>
        {finishing ? "Finishing…" : "Finish cancelling"}
      </button>
    {/if}
    {#if finishMsg}
      <p class="hint">{finishMsg}</p>
    {/if}
  {:else if windowClosed}
    <p class="hint">
      This event ended more than {ORGANISER_CANCEL_WINDOW_DAYS} days ago, so it can no longer be cancelled. You can
      still refund individual buyers from your Stripe Dashboard.
    </p>
  {:else if !open}
    {#if cancelledElsewhere}
      <p class="warn">
        This event has been cancelled from another app, so its tickets can't be sold. Confirm the cancellation here
        so every buyer is refunded.
      </p>
    {:else}
      <p class="hint">
        If the event isn't going ahead, cancel it here. Every buyer gets back everything they paid.
      </p>
    {/if}
    <button class="cancel-btn" onclick={openForm} disabled={asking}>
      {asking ? "Confirming it's you…" : cancelledElsewhere ? "Confirm cancellation" : "Cancel this event"}
    </button>
  {:else}
    {#if alreadyEnded}
      <p class="warn">
        This event has already ended. Cancelling it now refunds everyone who bought a ticket, including people who
        came.
      </p>
    {/if}
    <div class="explain">
      <p>Straight away:</p>
      <ul>
        <li>ticket sales stop and the event comes off WoCo's listings</li>
        <li>
          {ordersCount > 0 ? `all ${ordersCount} ticket(s) sold are` : "any tickets sold are"} refunded in full -
          everything the buyer paid, including any booking fee, back to the card they used
        </li>
        <li>each ticket stops working at the door as soon as its refund goes through</li>
      </ul>
      <p>
        <strong>What it costs you:</strong> the refunds come out of your Stripe balance. Stripe doesn't return its
        processing fee on a refund{CANCELLATION_RETURNS_PLATFORM_FEE
          ? "."
          : `, and WoCo's ${platformFeePct} platform fee isn't returned either (see the organiser terms).`}
        Your balance needs to cover every refund in full. Stripe holds any refund it can't cover yet and sends it
        once your balance can.
      </p>
      <p><strong>This can't be undone.</strong> Afterwards you'll be able to send your attendees a cancellation
        notice - we'll start it for you, and you choose the words.</p>
    </div>

    {#if pageLocked}
      <p class="hint">Your event page won't show the cancellation until you confirm it's you.</p>
    {/if}

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
