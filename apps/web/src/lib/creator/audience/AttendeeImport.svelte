<script lang="ts">
  /**
   * The route from ticket buyer into the marketing audience.
   *
   * The whole thing runs in the organiser's browser because it has to: the
   * server holds attendee emails only as ciphertext it cannot open, and consent
   * only as hashes. So the browser decrypts the claim data it already has the
   * key for, asks which of those addresses carry a consent record, and merges
   * the answer into the sealed list. Nothing new crosses the trust boundary.
   *
   * Only buyers who ticked the opt-in are ever offered. Someone who bought a
   * ticket and left the box alone is an attendee, not a marketing contact, and
   * this screen must never be the thing that quietly promotes them.
   */
  import type { MarketingContact, EventDirectoryEntry, SealedBox } from "@woco/shared";
  import { openJson } from "@woco/shared";
  import { getEventsByCreator, getEventOrders } from "../../api/events.js";
  import { checkMarketingEmails } from "../../api/marketing.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import {
    buildAttendeeContacts,
    applyDrain,
    type DecryptedClaim,
    type DrainReport,
  } from "./attendee-drain.js";

  interface Props {
    contacts: MarketingContact[];
    busy: boolean;
    getKeys: () => Promise<{ privateKey: Uint8Array } | null>;
    onCommit: (next: MarketingContact[]) => Promise<void>;
  }

  let { contacts, busy, getKeys, onCommit }: Props = $props();

  let events = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);
  let scanning = $state<string | null>(null);
  let error = $state<string | null>(null);
  let report = $state<(DrainReport & { eventTitle: string; skipped: number }) | null>(null);

  $effect(() => {
    if (!auth.parent) return;
    void (async () => {
      try {
        events = await getEventsByCreator(auth.parent!);
      } catch (err) {
        error = err instanceof Error ? err.message : "Could not load your events.";
      } finally {
        loading = false;
      }
    })();
  });

  async function scan(ev: EventDirectoryEntry): Promise<void> {
    error = null;
    report = null;
    scanning = ev.eventId;
    try {
      const keys = await getKeys();
      if (!keys) throw new Error("Unlock your identity to read attendee data.");

      const { orders } = await getEventOrders(ev.eventId);
      const claims: DecryptedClaim[] = [];
      for (const order of orders) {
        if (!order.encryptedOrder) continue;
        try {
          claims.push(await openJson<DecryptedClaim>(keys.privateKey, order.encryptedOrder as SealedBox));
        } catch {
          // A blob sealed to a rotated key, or a truncated upload. Skipping is
          // right — one unreadable order must not fail the whole scan.
        }
      }

      const emails = [...new Set(
        claims.map((c) => c.claimerEmail?.trim().toLowerCase()).filter((e): e is string => !!e),
      )];
      if (emails.length === 0) {
        report = { contacts, added: 0, updated: 0, eventTitle: ev.title, skipped: 0 };
        return;
      }

      const { consented = [] } = await checkMarketingEmails(emails);
      const consentedSet = new Set(consented);

      const incoming = buildAttendeeContacts(claims, {
        eventTitle: ev.title,
        eventDate: ev.startDate,
        addedAt: new Date().toISOString(),
        consented: consentedSet,
      });

      report = {
        ...applyDrain(contacts, incoming),
        eventTitle: ev.title,
        skipped: emails.length - consentedSet.size,
      };
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not read attendees.";
    } finally {
      scanning = null;
    }
  }

  async function commit(): Promise<void> {
    if (!report) return;
    error = null;
    try {
      await onCommit(report.contacts);
      report = null;
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not save.";
    }
  }
</script>

<section class="drain" aria-label="Add attendees who opted in">
  <p class="lede">
    Buyers who ticked the marketing box at checkout can join your audience. Everyone else
    stays out — buying a ticket is not permission to market to someone.
  </p>

  {#if loading}
    <p class="muted">Loading your events…</p>
  {:else if events.length === 0}
    <p class="muted">You have no events yet. Once people buy tickets, they show up here.</p>
  {:else}
    <ul class="events">
      {#each events as ev (ev.eventId)}
        <li>
          <div class="ev-main">
            <span class="ev-title">{ev.title}</span>
            <span class="ev-date">{new Date(ev.startDate).toLocaleDateString()}</span>
          </div>
          <button
            class="btn-ghost sm"
            disabled={scanning !== null || busy}
            onclick={() => void scan(ev)}
          >
            {scanning === ev.eventId ? "Reading…" : "Check"}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if report}
    <div class="report">
      {#if report.added === 0 && report.updated === 0}
        <p><strong>Nothing to add from {report.eventTitle}.</strong></p>
        <p class="muted">
          {#if report.skipped > 0}
            {report.skipped}
            {report.skipped === 1 ? "buyer" : "buyers"} did not opt in, so they stay out of your audience.
          {:else}
            Everyone who opted in is already on your list.
          {/if}
        </p>
      {:else}
        <p>
          <strong>{report.added.toLocaleString()}</strong> to add{#if report.updated > 0},
            <strong>{report.updated.toLocaleString()}</strong> to update with what they
            entered themselves{/if} from {report.eventTitle}.
        </p>
        {#if report.skipped > 0}
          <p class="muted">
            {report.skipped} {report.skipped === 1 ? "buyer" : "buyers"} did not opt in and stay out.
          </p>
        {/if}
        <div class="row">
          <button class="btn-primary" disabled={busy} onclick={() => void commit()}>
            {busy ? "Saving…" : "Add to audience"}
          </button>
          <button class="btn-ghost sm" onclick={() => (report = null)}>Cancel</button>
        </div>
      {/if}
    </div>
  {/if}

  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  .drain {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .lede {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-secondary);
    max-width: 62ch;
  }

  .events { list-style: none; margin: 0; padding: 0; }

  .events li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .events li:last-child { border-bottom: none; }

  .ev-main { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }

  .ev-title {
    font-size: 0.875rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ev-date { font-size: 0.75rem; color: var(--text-muted); }

  .report {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .report p { margin: 0; font-size: 0.8125rem; line-height: 1.5; }

  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.25rem; }

  .muted { color: var(--text-muted); font-size: 0.8125rem; }
  .err { color: var(--error); font-size: 0.8125rem; margin: 0; }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md);
  }
  .btn-primary:disabled { opacity: 0.4; }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost:disabled { opacity: 0.4; }
  .btn-ghost.sm { font-size: 0.8125rem; padding: 0.375rem 0.75rem; }
</style>
