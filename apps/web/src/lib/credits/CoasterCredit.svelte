<script lang="ts">
  /**
   * One coaster in a rider's collection: the credit they hold, the laps they've
   * ridden, and the tap that adds one.
   *
   * VOCABULARY IS LOAD-BEARING here, not styling. In this community a CREDIT is
   * a coaster ridden once, ever — repeat rides are LAPS or RIDES. Calling 109
   * laps "109 credits" marks us as outsiders on day one, which is the fastest
   * way to lose the exact audience this is for. Likewise no crypto words in
   * anything a fan reads: collect and keepsake, never wallet or mint.
   */
  import { onMount } from "svelte";
  import { lookupSubject, currentEra, formerNames, WOCO_SUBJECTS, type Hex0x } from "@woco/shared";
  import { readMyCredit, recordRide, publishSubject, type CreditHead } from "./credits.js";
  import { utcSessionDate } from "./next-statement.js";

  interface Props {
    subject: Hex0x;
  }

  let { subject }: Props = $props();

  let head = $state<CreditHead | null>(null);
  let loaded = $state(false);
  let inFlight = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let confirmingPublish = $state(false);

  /** Last tap this session, for the accidental-double-tap guard. Not $state —
   *  nothing renders from it. */
  let lastTapAt = 0;

  const definition = $derived(lookupSubject(WOCO_SUBJECTS, subject));
  const era = $derived(definition ? currentEra(definition) : null);
  /** Names it used to carry. A re-theme keeps the count (same track, same
   *  credit) but a rider who rode it under the old name wants that on the
   *  record — so the previous name is shown, not overwritten. */
  const previously = $derived(definition ? formerNames(definition) : []);
  const laps = $derived(head?.statement.total ?? 0);
  /**
   * The session block is TODAY'S only when its date is today. It rolls over at
   * WRITE time, not at midnight, so a rider who logged three laps on Saturday
   * and opened the app on Sunday was being shown "3 today" without having
   * ridden — the stored block was still Saturday's and nothing had rewritten it.
   */
  const today = $derived(
    head && head.statement.session.date === utcSessionDate() ? head.statement.session.count : 0,
  );
  const isPublic = $derived(head?.visibility === "public");

  async function refresh() {
    head = await readMyCredit(subject);
    loaded = true;
  }

  onMount(refresh);

  async function collect() {
    if (inFlight) return;

    // Accidental-double-tap guard, sized per subject. Honest about what it is:
    // at tier 1 this polices self-declared data, so it stops a fumbled tap and
    // nothing else. It is not an anti-fraud control and must never be described
    // as one — a determined inflater simply waits out the window.
    const gapMs = (definition?.cadenceMinutes ?? 0) * 60_000;
    if (gapMs > 0 && Date.now() - lastTapAt < gapMs) {
      notice = "Already counted that one — tap again in a moment if it was a new lap.";
      return;
    }

    inFlight = true;
    error = null;
    notice = null;
    try {
      const res = await recordRide(subject);
      if (res.ok) {
        lastTapAt = Date.now();
        head = { statement: res.statement, visibility: res.visibility };
        loaded = true;
        // An unconfirmed write is not a failed one — the chunk is uploaded and
        // the gateway simply hasn't finished whitelisting it. Saying "saved,
        // still settling" is the honest version of a spinner that never ends.
        if (!res.confirmed) notice = "Saved — still settling on the network.";
      } else {
        error = res.error;
        // The count we hold may be stale if another device won the write, so
        // re-read rather than leaving a number on screen that lost a race.
        await refresh();
      }
    } finally {
      inFlight = false;
    }
  }

  async function confirmPublish() {
    if (inFlight) return;
    inFlight = true;
    error = null;
    notice = null;
    try {
      const res = await publishSubject(subject);
      if (res.ok) {
        confirmingPublish = false;
        await refresh();
      } else {
        error = res.error;
      }
    } finally {
      inFlight = false;
    }
  }
</script>

<article class="card" class:held={laps > 0}>
  <header>
    <div class="ident">
      <h3>{era?.name ?? "Unknown coaster"}</h3>
      <p class="park">{era?.park ?? subject.slice(0, 10) + "…"}</p>
      {#if previously.length > 0}
        <p class="formerly">Ridden as {previously.join(", ")}</p>
      {/if}
    </div>
    {#if loaded && laps > 0}
      <span class="badge" class:pub={isPublic}>
        {isPublic ? "Public" : "Private"}
      </span>
    {/if}
  </header>

  {#if !loaded}
    <p class="state">Loading your collection…</p>
  {:else if laps === 0}
    <p class="state">Not collected yet. Ride it once to add the credit.</p>
  {:else}
    <div class="tally">
      <div class="figure">
        <span class="num">{laps}</span>
        <span class="unit">{laps === 1 ? "lap" : "laps"}</span>
      </div>
      {#if today > 0}
        <p class="today">{today} today</p>
      {/if}
    </div>
    <!-- The credit itself: held once, forever, from the first ride. The count
         is a property of it, which is why it reads as a separate line. -->
    <p class="credit">Credit collected</p>
  {/if}

  <div class="actions">
    <button class="collect" onclick={collect} disabled={inFlight || !loaded}>
      {#if inFlight}Saving…{:else if laps === 0}I rode it{:else}Add a lap{/if}
    </button>

    {#if loaded && laps > 0 && !isPublic && !confirmingPublish}
      <button class="link" onclick={() => (confirmingPublish = true)} disabled={inFlight}>
        Make public
      </button>
    {/if}
  </div>

  {#if confirmingPublish}
    <!-- The plan requires this be said at the moment of choosing, not in a
         policy page: publication is structurally one-way, and it exposes the
         lifetime total — not merely rides from here on. -->
    <div class="confirm">
      <p>
        Publishing shows your <strong>whole count for {era?.name ?? "this coaster"}</strong>,
        including the {laps} {laps === 1 ? "lap" : "laps"} you rode privately — not just rides from now on.
      </p>
      <p class="oneway">This cannot be undone. A public count can never be made private again.</p>
      <div class="confirm-actions">
        <button class="collect" onclick={confirmPublish} disabled={inFlight}>
          {inFlight ? "Publishing…" : "Publish my count"}
        </button>
        <button class="link" onclick={() => (confirmingPublish = false)} disabled={inFlight}>
          Keep it private
        </button>
      </div>
    </div>
  {/if}

  {#if error}<p class="msg err" role="status">{error}</p>{/if}
  {#if notice}<p class="msg note" role="status">{notice}</p>{/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 1.125rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast, 0.15s ease);
  }

  .card.held { border-color: var(--accent-subtle); }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  h3 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.25rem;
    line-height: 1.15;
    color: var(--text);
  }

  .park {
    margin: 0.1875rem 0 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .formerly {
    margin: 0.25rem 0 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .badge {
    flex-shrink: 0;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.5625rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .badge.pub {
    color: var(--accent-text);
    border-color: var(--accent-subtle);
    background: var(--accent-subtle);
  }

  .state {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .tally { display: flex; align-items: baseline; gap: 0.625rem; }

  .figure { display: flex; align-items: baseline; gap: 0.3125rem; }

  .num {
    font-family: var(--font-display);
    font-size: 2.5rem;
    line-height: 1;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .unit {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .today {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }

  .credit {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  .actions { display: flex; align-items: center; gap: 0.75rem; }

  .collect {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition-fast, 0.15s ease);
  }

  .collect:hover:not(:disabled) { background: var(--accent-hover); }
  .collect:active:not(:disabled) { background: var(--accent-press); }
  .collect:disabled { opacity: 0.55; cursor: default; }

  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 0.8125rem;
    text-decoration: underline;
    text-underline-offset: 0.1875rem;
    cursor: pointer;
  }

  .link:hover:not(:disabled) { color: var(--text); }
  .link:disabled { opacity: 0.55; cursor: default; }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .confirm p { margin: 0; font-size: 0.8125rem; line-height: 1.45; color: var(--text-secondary); }
  .confirm strong { color: var(--text); }
  .oneway { color: var(--warning) !important; font-weight: 600; }
  .confirm-actions { display: flex; align-items: center; gap: 0.75rem; }

  .msg {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    line-height: 1.4;
    letter-spacing: 0.02em;
  }

  .err { color: var(--error); }
  .note { color: var(--text-muted); }
</style>
