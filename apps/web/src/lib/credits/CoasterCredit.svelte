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
  import { creditsUnlocked, readMyCredit, recordRide, publishSubject, type CreditHead } from "./credits.js";
  import { shouldRetryCold } from "./partition.js";
  import { utcSessionDate } from "./next-statement.js";
  import { requireAccountForAction } from "../auth/ensure-action.js";
  import { cacheGet, cacheSet, TTL } from "../cache/cache.js";
  import type { VerifiedWriteResult } from "../swarm/verified-write.js";

  interface Props {
    subject: Hex0x;
  }

  let { subject }: Props = $props();

  let head = $state<CreditHead | null>(null);
  let loaded = $state(false);
  /**
   * Whether the rider's collection has been unlocked on this device. False
   * covers both "no account" and "signed in but keys not yet established", and
   * the card shows the same face for both: the honest thing to say to either is
   * "ride it once to add the credit", because neither has a count we can read.
   * "Not collected yet" would be a claim, and for a returning rider on a fresh
   * device it would be a false one.
   */
  let unlocked = $state(false);
  /**
   * A write whose read-back has not finished. While one is outstanding the NEXT
   * tap goes cold — it re-reads instead of reusing `head` — because a head from
   * a write that turns out `superseded` never actually landed, and building the
   * next total on it would write a wrong number. Rare in practice: Rita's
   * two-minute cadence guard blocks a repeat tap long before this matters.
   */
  let settling = $state(false);
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

  /**
   * The last count this device SAW, for instant paint on load.
   *
   * DISPLAY ONLY, and the boundary is the whole safety argument. `readMyCredit`
   * is already the lenient path — it collapses every failure to null — whereas
   * `head` feeds the next write, where a stale value restarts a rider's
   * lifetime count at zero. So the cache is never allowed to become `head`: it
   * paints a number and nothing else, and the live read replaces it.
   *
   * The `credit:` prefix is registered in `USER_SCOPED_PREFIXES` so sign-out
   * clears it. That is not hygiene here: this is a children's service, and a
   * shared park or family device must not show the next person what the last
   * one rode.
   */
  const cacheK = $derived(`credit:laps:${subject}`);
  let cachedLaps = $state<number | null>(null);

  async function refresh() {
    head = await readMyCredit(subject);
    loaded = true;
    // Only a real read updates the remembered number. A failed read leaves the
    // previous one in place rather than writing a zero nobody rode.
    if (head) {
      cachedLaps = head.statement.total;
      cacheSet(cacheK, head.statement.total, TTL.COLLECTION);
    }
  }

  /**
   * Reading a private logbook needs the rider's own keys, and establishing
   * those keys prompts — so the mount read is GATED on them already existing.
   * Without the gate, merely opening this page pops a signing dialog at a rider
   * who has not tapped anything, which is both alarming in a queue and false to
   * a rail that promises nothing is written without a deliberate tap. The tap
   * itself does the unlocking, where the rider has asked for it.
   */
  onMount(async () => {
    unlocked = await creditsUnlocked();
    if (unlocked) {
      // Paint the remembered count FIRST. The live read walks the rider's feeds
      // — several round trips, each of which may probe past a feed's end, which
      // is the most expensive read on Swarm — and a rider opening their own
      // card should not watch a spinner to be told a number their device
      // already knew. The live read then replaces it.
      cachedLaps = cacheGet<number>(cacheK);
      await refresh();
    } else {
      loaded = true;
    }
  });

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
      // The tap IS the sign-in prompt. `recordRide` would otherwise throw "Sign
      // in to collect a credit" into the error slot — a dead end, since nothing
      // on this card offers a way in. Cancelling is not a failure and gets no
      // error: the rider changed their mind, and the card is unchanged.
      // No `context` deliberately: the attendee subtitle in the login modal
      // tells riders that accounts are for organisers, which is exactly the
      // wrong thing to say to the rider we just asked to sign in.
      if (!(await requireAccountForAction())) return;
      // No pre-read: `recordRide` does its own — it reads the live head to carry
      // the lifetime total forward — so one here would be a round trip that
      // changes no outcome.
      // The head this page already read on mount, handed back so the tap does
      // not re-read the rider's own index and head seconds later. `head` is
      // only ever set from a CLEAN read, and null falls back to the full
      // tri-state path — see `recordRide`.
      const res = await recordRide(subject, 1, settling ? null : head);
      if (res.ok) {
        lastTapAt = Date.now();
        head = { statement: res.statement, visibility: res.visibility, version: res.version };
        loaded = true;
        // Only NOW is the collection provably unlocked. Setting this before the
        // write would make a declined key ceremony show the unlocked face —
        // "Not collected yet" — which is a claim, and for a rider who has laps
        // on another device a false one.
        unlocked = true;

        // The count is on screen the moment the UPLOAD was accepted, which is
        // when the rider's signed entry durably exists. The read-back finishes
        // on its own; it protects against one thing — another device's bytes
        // landing at our version — and the rider gains nothing by watching it.
        settling = true;
        void res.settled.then((r) => settle(r, true));
      } else {
        error = res.error;
        // Re-derive rather than assume. This branch is right for a lost write
        // race — the keys are fine and the count on screen may be stale — but
        // the write can also have failed BECAUSE the rider declined the key
        // ceremony, and a bare re-read then walks straight back into
        // `ensurePodIdentity` and re-opens the prompt they just dismissed.
        // Asking first costs one device read and never prompts.
        unlocked = await creditsUnlocked();
        if (unlocked) await refresh();
      }
    } finally {
      inFlight = false;
    }
  }

  /**
   * What a finished write means for the card.
   *
   * `superseded` is the ONE outcome meaning the entry did not land — another
   * device's bytes are at our version. The rider tapped and their lap is not
   * recorded through no fault of theirs, so the honest response is to record it,
   * not to report a failure they cannot act on. `retry` is allowed exactly once
   * and reads everything fresh; a second loss is a live race with another device
   * and they are told.
   *
   * Never a silent decrement: if it does end in failure the count is repainted
   * from a real read, so the number on screen is always one somebody wrote.
   */
  async function settle(r: VerifiedWriteResult, retry: boolean) {
    settling = false;
    if (r.status === "unconfirmed") {
      // Uploaded but not read back — freshly relayed chunks are whitelisted
      // asynchronously, so this is routine and NOT a failure.
      notice = "Saved — still settling on the network.";
      return;
    }
    if (!shouldRetryCold(r.status, retry)) {
      if (r.status !== "superseded") return;
      error = "Another device recorded a ride at the same moment.";
      await refresh();
      return;
    }
    // Cold: everything re-read, nothing reused from the attempt that lost.
    settling = true;
    const again = await recordRide(subject, 1, null);
    if (!again.ok) {
      settling = false;
      error = again.error;
      await refresh();
      return;
    }
    head = { statement: again.statement, visibility: again.visibility, version: again.version };
    void again.settled.then((r2) => settle(r2, false));
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
    {#if loaded && unlocked && laps > 0}
      <span class="badge" class:pub={isPublic}>
        {isPublic ? "Public" : "Private"}
      </span>
    {/if}
  </header>

  {#if !loaded && cachedLaps !== null}
    <!-- The WHOLE held state, not just the figure. Painting the number alone
         left the card visibly assembling itself: the count appeared at once and
         "Credit collected" arrived seconds later when the live read landed,
         which reads as broken rather than fast. A remembered card is either
         shown or it is not.

         Deliberately not labelled provisional: it is the number this rider last
         saw, the live read almost always agrees, and a caveat on a correct
         figure teaches them to distrust it. -->
    <div class="tally">
      <div class="figure">
        <span class="num">{cachedLaps}</span>
        <span class="unit">{cachedLaps === 1 ? "lap" : "laps"}</span>
      </div>
    </div>
    <p class="credit">Credit collected — only you can see it</p>
  {:else if !loaded}
    <p class="state">Loading your collection…</p>
  {:else if !unlocked}
    <p class="state">Ride it once to add the credit.</p>
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
         is a property of it, which is why it reads as a separate line.
         The private clause rides along rather than taking a slot of its own: a
         child does not decode a "PRIVATE" badge as reassurance, and this is the
         whole private-by-default statement said in words, always true, at the
         one moment a rider is looking at what they just made. -->
    <p class="credit">{isPublic ? "Credit collected" : "Credit collected — only you can see it"}</p>
  {/if}

  <div class="actions">
    <button class="collect" onclick={collect} disabled={inFlight || !loaded}>
      {#if inFlight}Saving…{:else if laps === 0}I rode it{:else}Add a lap{/if}
    </button>

    {#if loaded && unlocked && laps > 0 && !isPublic && !confirmingPublish}
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
