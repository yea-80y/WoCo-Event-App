<script lang="ts">
  /**
   * How many of each ticket type are on sale, for an event whose tickets the
   * organiser controls (ledger2). Lower it to fit a smaller room, raise it back up
   * to the number published. The organiser signs; WoCo saves it
   * (`lib/ledger2/organiser-changes.ts`). Shown only when the parent has read such
   * ticket types from the chain, so it is invisible until ledger2 is deployed.
   */
  import type { EventFeed } from "@woco/shared";
  import {
    readLedger2Event,
    startTermsChange,
    messageFor,
    relayMessage,
    type ChangePhase,
    type Ledger2Change,
    type Ledger2EventView,
  } from "../../ledger2/organiser-changes.js";
  import { liveLedger2ClientIO as io } from "../../ledger2/organiser-changes-live.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import ChangeSavingStatus from "./ChangeSavingStatus.svelte";

  interface Props {
    event: EventFeed;
    view: Ledger2EventView;
    onchanged: (view: Ledger2EventView) => void;
  }

  let { event, view, onchanged }: Props = $props();

  // One-time seed from the first view; later refreshes must not clobber a draft.
  // svelte-ignore state_referenced_locally
  let drafts = $state<Record<string, number>>(Object.fromEntries(view.series.map((s) => [s.seriesId, s.totalSupply])));
  let phase = $state<ChangePhase | null>(null);
  let error = $state<string | null>(null);
  let preparing = $state(false);
  let running: Ledger2Change | null = null;

  const closed = $derived(view.series.every((s) => s.cancelled || view.chainNow >= s.eventEndTs));
  const busy = $derived(preparing || phase?.phase === "saving" || phase?.phase === "cancelling");

  function invalid(seriesId: string): string | null {
    const s = view.series.find((x) => x.seriesId === seriesId)!;
    const n = drafts[seriesId];
    if (typeof n !== "number" || !Number.isInteger(n)) return "Enter a whole number.";
    if (n < Math.max(1, s.nextSlot)) return `At least ${Math.max(1, s.nextSlot)} - that many are sold.`;
    if (n > s.registeredSupply) return `At most ${s.registeredSupply}.`;
    return null;
  }

  const changed = $derived(view.series.filter((s) => !s.cancelled && drafts[s.seriesId] !== s.totalSupply));
  const canSave = $derived(!busy && !closed && changed.length > 0 && changed.every((s) => !invalid(s.seriesId)));

  async function save() {
    if (!canSave) return;
    preparing = true;
    error = null;
    phase = null;
    try {
      await auth.ensureOrganiserUnlock();
      const parent = auth.parent?.toLowerCase();
      if (!parent) throw new Error("Sign in again to change ticket numbers.");
      // Fresh: the signatures commit to the nonces read now.
      const fresh = await readLedger2Event(event, parent, io);
      if (!fresh) throw new Error("Couldn't read your tickets just now. Try again in a moment.");
      const changes = changed.map((s) => ({ kind: "setSupply" as const, seriesId: s.seriesId, supply: drafts[s.seriesId]! }));
      const started = await startTermsChange(event, parent, fresh, changes, io, (p) => (phase = p));
      running = started.change;
      preparing = false;
      await started.done;
      const after = await readLedger2Event(event, parent, io).catch(() => null);
      // Whatever the outcome, the fields show what is on sale now.
      if (after) {
        onchanged(after);
        for (const s of after.series) drafts[s.seriesId] = s.totalSupply;
      }
    } catch (e) {
      error = relayMessage(e) ?? (e instanceof Error ? e.message : messageFor(e));
    } finally {
      preparing = false;
      running = null;
    }
  }

  function cancel() {
    void running?.cancel();
  }
</script>

<section class="numbers">
  <h3>Tickets on sale</h3>
  {#if closed}
    <p class="hint">Ticket sales for this event have ended, so these numbers can't change any more.</p>
  {:else}
    <p class="hint">
      Lower a number to fit a smaller room, or raise it back - never below what's sold, and up to the number you
      published.
    </p>
  {/if}

  {#each view.series as s (s.seriesId)}
    <label class="type">
      <span class="name">{s.name}</span>
      <span class="sold">{s.nextSlot} sold</span>
      <input
        type="number"
        min={Math.max(1, s.nextSlot)}
        max={s.registeredSupply}
        step="1"
        bind:value={drafts[s.seriesId]}
        disabled={busy || closed || s.cancelled}
        aria-describedby={`max-${s.seriesId}`}
      />
      <span class="max" id={`max-${s.seriesId}`}>of up to {s.registeredSupply}</span>
    </label>
    {#if drafts[s.seriesId] !== s.totalSupply && invalid(s.seriesId)}
      <p class="field-error">{invalid(s.seriesId)}</p>
    {/if}
  {/each}

  <ChangeSavingStatus {phase} oncancel={cancel} what="ticket numbers" />
  {#if error}
    <p class="field-error">{error}</p>
  {/if}

  {#if !closed}
    <button class="btn btn--ghost" onclick={save} disabled={!canSave}>
      {preparing ? "Confirming it's you…" : "Save ticket numbers"}
    </button>
  {/if}
</section>

<style>
  .numbers {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
  }

  h3 {
    margin: 0;
    font-size: 0.9375rem;
  }

  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .type {
    display: grid;
    grid-template-columns: 1fr auto 6rem auto;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
  }

  .name {
    color: var(--text);
    font-weight: 500;
  }

  .sold,
  .max {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  input {
    width: 100%;
  }

  @media (max-width: 480px) {
    .type {
      grid-template-columns: 1fr 5.5rem;
    }
    .sold {
      grid-column: 1;
      grid-row: 2;
    }
    .max {
      grid-column: 2;
      grid-row: 2;
    }
  }

  .field-error {
    color: var(--error);
    font-size: 0.8125rem;
    margin: 0;
  }

  .btn {
    align-self: flex-start;
  }
</style>
