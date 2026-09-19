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
   *
   * THE TAP NEVER WAITS FOR THE NETWORK. It reads the clock, writes the lap into
   * the journal on this phone, and returns; `lap-sender.ts` does everything
   * else from that record. Two reasons, and both are about a park's signal: a
   * lap's time is only worth keeping if it is the time of the tap, and a button
   * stuck on "Saving…" is a lap the rider could not log at all.
   */
  import { onDestroy, onMount } from "svelte";
  import { lookupSubject, currentEra, formerNames, WOCO_SUBJECTS, type Hex0x } from "@woco/shared";
  import {
    creditsUnlocked,
    readMyCredit,
    publishSubject,
    unlockCredits,
    prepareRide,
    sendPreparedRide,
    reconcilePreparedRide,
    sealLapTimes,
    readLapTimes,
    type CreditHead,
  } from "./credits.js";
  import { utcSessionDate } from "./next-statement.js";
  import {
    addTap,
    cardNumbers,
    emptyJournal,
    journalCounts,
    lapRows,
    lastTapAt,
    type LapJournal,
    type LapRow,
  } from "./lap-journal.js";
  import { createLapSender, type LapSender } from "./lap-sender.js";
  import { openLapJournal, type LapJournalStore } from "./lap-journal-store.js";
  import { auth } from "../auth/auth-store.svelte.js";
  import { requireAccountForAction } from "../auth/ensure-action.js";
  import { cacheGet, cacheSet, TTL } from "../cache/cache.js";
  import { measured } from "../swarm/probe-stats.js";

  interface Props {
    subject: Hex0x;
  }

  let { subject }: Props = $props();

  /**
   * The newest head this card has SEEN — a clean read or a landed write. Display
   * only: the head the next write builds on belongs to the sender, which drops
   * it whenever it cannot be trusted. Keeping the two apart is what lets a
   * failed read leave the number on screen alone instead of blanking it.
   */
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
  /** A first tap is establishing the account or its keys. The ONLY thing that
   *  disables the button: once unlocked, a tap never waits on anything. */
  let unlocking = $state(false);
  let publishing = $state(false);
  let sending = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let confirmingPublish = $state(false);

  /** This phone's record of the rider's taps. Mirrors the store for rendering. */
  let journal = $state.raw<LapJournal>(emptyJournal());
  let store: LapJournalStore | null = null;
  let sender: LapSender | null = null;

  let showLog = $state(false);
  /** Laps read back from the rider's sealed entries — only ever needed on a
   *  device whose journal does not already hold them. */
  let remoteRows = $state.raw<LapRow[]>([]);
  let copied = $state(false);
  let copyFallback = $state<string | null>(null);

  const definition = $derived(lookupSubject(WOCO_SUBJECTS, subject));
  const era = $derived(definition ? currentEra(definition) : null);
  /** Names it used to carry. A re-theme keeps the count (same track, same
   *  credit) but a rider who rode it under the old name wants that on the
   *  record — so the previous name is shown, not overwritten. */
  const previously = $derived(definition ? formerNames(definition) : []);
  /** The remembered count's storage key, and the count itself. */
  const cacheK = $derived(`credit:laps:${subject}`);
  let cachedLaps = $state<number | null>(null);

  /** Confirmed from a live read or a landed write. Gates ACTIONS — the badge,
   *  "Make public", the publish confirmation — because each of those asserts
   *  something about state we have actually seen. */
  const laps = $derived(head?.statement.total ?? 0);
  /**
   * What the card SHOWS: the last count somebody actually WROTE, with laps that
   * are still waiting reported beside it and never folded in. The public count
   * only moves when laps are sent, and the rider's own screen must not claim
   * otherwise (`cardNumbers` is pinned by a test for exactly this).
   */
  const numbers = $derived(
    cardNumbers({ headTotal: head?.statement.total ?? null, rememberedTotal: cachedLaps, journal }),
  );
  const shownLaps = $derived(numbers.counted);
  const counts = $derived(journalCounts(journal));
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

  // ---------------------------------------------------------------------------
  // Times, shown in the COASTER's timezone — the same rule the statement's UTC
  // date is read by. Stored times are UTC milliseconds and are never converted
  // until this point, so a phone set to another zone cannot shift the record.
  // ---------------------------------------------------------------------------

  const zone = $derived(definition?.timezone ?? "UTC");
  const dayFormat = $derived(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }),
  );
  const timeFormat = $derived(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
  );
  const longDayFormat = $derived(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric" }),
  );
  const dayOf = (at: number): string => dayFormat.format(at);

  /** Today's laps: this phone's own record, plus any sealed entries it lacks. */
  const rows = $derived.by(() => {
    const day = dayOf(Date.now());
    const mine = lapRows(journal, dayOf, day);
    const known = new Set(mine.map((r) => r.at));
    const extra = remoteRows.filter((r) => dayOf(r.at) === day && !known.has(r.at));
    return [...mine, ...extra].sort((a, b) => a.at - b.at);
  });
  const timedToday = $derived(rows.filter((r) => r.state === "counted").length);
  const untimedToday = $derived(Math.max(0, today - timedToday));

  /**
   * The last count this device SAW, for instant paint on load.
   *
   * DISPLAY ONLY, and the boundary is the whole safety argument. The cache is
   * never allowed to become a head: it paints a number and nothing else, and the
   * live read replaces it.
   *
   * The `credit:` prefix is registered in `USER_SCOPED_PREFIXES` so sign-out
   * clears it. That is not hygiene here: this is a children's service, and a
   * shared park or family device must not show the next person what the last
   * one rode.
   */
  function remember(h: CreditHead) {
    cachedLaps = h.statement.total;
    cacheSet(cacheK, h.statement.total, TTL.COLLECTION);
  }

  async function refresh() {
    const read = await measured("read own count", () => readMyCredit(subject));
    loaded = true;
    // A FAILED read changes nothing. It used to overwrite `head` with null, and
    // with no signal that turned a rider's 57 laps into "Not collected yet" the
    // moment a tap could not be sent — a false claim, made in exactly the
    // conditions the card most needs to stay truthful in.
    if (!read) return;
    head = read;
    remember(read);
    sender?.offerHead(read);
  }

  // ---------------------------------------------------------------------------
  // The journal and its sender
  // ---------------------------------------------------------------------------

  /** Background retry delays. Short first: the usual cause is a dead spot the
   *  rider walks out of. */
  const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function sync() {
    if (!store || !sender) return;
    journal = store.read();
    sending = sender.running;
    error = sender.error;
    if (sender.notice) notice = sender.notice;
    if (sender.head && sender.head !== head) {
      head = sender.head;
      loaded = true;
      remember(sender.head);
    }
  }

  function ensureSender(): LapSender | null {
    if (sender) return sender;
    const parent = auth.parent;
    if (!parent) return null;
    const opened = openLapJournal(parent, subject);
    store = opened;
    sender = createLapSender({
      read: opened.read,
      write: opened.write,
      prepare: (times, warm) => prepareRide(subject, times, warm),
      send: (prepared) => measured("record a lap", () => sendPreparedRide(subject, prepared)),
      reconcile: (prepared) => reconcilePreparedRide(subject, prepared),
      seal: (counted) => sealLapTimes(subject, counted),
      onChange: sync,
      retryLater(attempt) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(drain, RETRY_MS[Math.min(attempt, RETRY_MS.length) - 1]);
      },
    });
    journal = opened.read();
    return sender;
  }

  function hasWork(): boolean {
    const c = journalCounts(store?.read() ?? emptyJournal());
    return c.waiting - c.held > 0 || c.unsealed > 0 || store?.read().prepared != null;
  }

  /**
   * Send whatever is waiting. NEVER the thing that establishes keys: a
   * background retry must not raise a signing prompt at a rider who is not
   * looking at the screen, so it runs only once the collection is unlocked —
   * which a journalled tap always implies.
   */
  function drain() {
    if (!unlocked || !sender || !hasWork()) return;
    void sender.kick().then(async () => {
      // A run that ended without a usable head lost a race or could not read.
      // Repaint from a real read rather than leave a number nobody wrote.
      if (sender && !sender.head && sender.error) await refresh();
    });
  }

  function onVisible() {
    if (document.visibilityState === "visible") drain();
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
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", onVisible);
    unlocked = await creditsUnlocked();
    if (unlocked) {
      // Paint the remembered count FIRST. The live read walks the rider's feeds
      // — several round trips — and a rider opening their own card should not
      // watch a spinner to be told a number their device already knew.
      cachedLaps = cacheGet<number>(cacheK);
      ensureSender();
      await refresh();
      // Laps left over from a session that ended without signal.
      drain();
    } else {
      loaded = true;
    }
  });

  onDestroy(() => {
    if (retryTimer) clearTimeout(retryTimer);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", onVisible);
    }
  });

  /**
   * THE FIRST LINE READS THE CLOCK, and nothing below may read it again for
   * this lap. Everything after it can be slow — a first tap runs the whole
   * sign-in — and a time taken after any of that is not the time of the ride.
   */
  function collect() {
    const at = Date.now();
    void tapped(at);
  }

  async function tapped(at: number) {
    if (unlocking) return;
    notice = null;

    if (!unlocked || !auth.parent) {
      unlocking = true;
      error = null;
      try {
        // The tap IS the sign-in prompt. Cancelling is not a failure and gets no
        // error: the rider changed their mind, and the card is unchanged.
        // No `context` deliberately: the attendee subtitle in the login modal
        // tells riders that accounts are for organisers, which is exactly the
        // wrong thing to say to the rider we just asked to sign in.
        if (!(await requireAccountForAction())) return;
        // Keys BEFORE the journal. A rider who declines the key ceremony has
        // declined the lap, and must not find it waiting to send later.
        const keys = await unlockCredits();
        if (!keys.ok) {
          error = keys.error;
          return;
        }
        unlocked = true;
      } finally {
        unlocking = false;
      }
    }

    const s = ensureSender();
    if (!s || !store) return;

    // Accidental-double-tap guard, sized per subject. Honest about what it is:
    // at tier 1 this polices self-declared data, so it stops a fumbled tap and
    // nothing else. It is not an anti-fraud control and must never be described
    // as one — a determined inflater simply waits out the window. Read from the
    // journal, so a reload does not reset it.
    const gapMs = (definition?.cadenceMinutes ?? 0) * 60_000;
    const last = lastTapAt(store.read());
    if (gapMs > 0 && last > 0 && at - last < gapMs && at >= last) {
      notice = "Got that one already. Tap again in a moment if it was a new lap.";
      return;
    }

    // From the click to this write there is no `await` once a rider is
    // unlocked: the lap is on the phone before anything can fail.
    store.write(addTap(store.read(), at));
    sync();
    drain();
  }

  async function confirmPublish() {
    if (publishing) return;
    publishing = true;
    error = null;
    notice = null;
    try {
      const res = await publishSubject(subject);
      if (res.ok) {
        confirmingPublish = false;
        // The head just moved to the public topic family. A warm PRIVATE head
        // would send the next lap to the retired one, where it lands, verifies,
        // and is never counted — so it is dropped before anything can use it.
        sender?.dropHead();
        await refresh();
      } else {
        error = res.error;
      }
    } finally {
      publishing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // The rider's log
  // ---------------------------------------------------------------------------

  async function toggleLog() {
    showLog = !showLog;
    if (!showLog || !head || !unlocked) return;
    // Only when this phone's record is short of the day's count: a second
    // phone, or this one after a sign-out. Otherwise it costs nothing.
    if (timedToday >= today) return;
    const entries = await readLapTimes(head, Date.now() - 36 * 60 * 60 * 1000);
    remoteRows = entries.flatMap((e) =>
      e.times.map((at, i) => ({ at, lap: e.total - e.times.length + 1 + i, state: "counted" as const })),
    );
  }

  function logText(): string {
    const lines = [
      `${era?.name ?? "Coaster"} - ${era?.park ?? ""}`.replace(/ - $/, ""),
      longDayFormat.format(Date.now()),
      "",
      ...rows.map((r) =>
        r.state === "counted"
          ? `${r.lap === null ? "Lap" : `Lap ${r.lap}`}\t${timeFormat.format(r.at)}`
          : `${r.state === "held" ? "Not counted" : "Waiting to send"}\t${timeFormat.format(r.at)}`,
      ),
      "",
      "Times are from this phone's clock.",
    ];
    return lines.join("\n");
  }

  async function copyLog() {
    const text = logText();
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      copyFallback = null;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // No clipboard permission: show the text so it can be selected by hand.
      copyFallback = text;
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
        <span class="num">{shownLaps}</span>
        <span class="unit">{shownLaps === 1 ? "lap" : "laps"}</span>
      </div>
    </div>
    {#if counts.waiting > 0}
      <p class="waiting" role="status">{counts.waiting} waiting to send</p>
    {/if}
    <p class="credit">Credit collected — only you can see it</p>
    <p class="syncing">Checking your logbook…</p>
  {:else if !loaded}
    <p class="state">Loading your collection…</p>
  {:else if !unlocked}
    <p class="state">Ride it once to add the credit.</p>
  {:else if laps === 0 && counts.waiting > 0}
    <!-- A first lap that is on the phone and not yet on the network. "Not
         collected yet" would be untrue, and so would a count of one. -->
    <p class="state" role="status">Your first lap is saved on this phone and waiting to send.</p>
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
    {#if counts.waiting > 0}
      <!-- Beside the count, never inside it: the number above is one somebody
           wrote, and these are not written yet. -->
      <p class="waiting" role="status">
        {counts.waiting} waiting to send{sending ? "…" : ""}
      </p>
    {/if}
    <!-- The credit itself: held once, forever, from the first ride. The count
         is a property of it, which is why it reads as a separate line.
         The private clause rides along rather than taking a slot of its own: a
         child does not decode a "PRIVATE" badge as reassurance, and this is the
         whole private-by-default statement said in words, always true, at the
         one moment a rider is looking at what they just made. -->
    <p class="credit">{isPublic ? "Credit collected" : "Credit collected — only you can see it"}</p>
  {/if}

  <div class="actions">
    <!-- NOT gated on `loaded`. That flag means "the live read finished", and
         the whole point of painting a remembered card is that a rider does not
         wait for it. Tapping before it lands is SAFE: `head` is still null, so
         `recordRide` takes the full tri-state path — the same reads the mount
         was doing, just triggered by someone who actually wanted something. -->
    <!-- Disabled ONLY while a first tap establishes the account. After that a
         tap never waits on the network, so there is no "Saving…" to sit behind:
         a lap the rider could not tap is a hole in the one record this is for. -->
    <button class="collect" onclick={collect} disabled={unlocking || publishing}>
      <!-- `shownLaps`, not `laps`: the label must agree with the card above it,
           including while a remembered card waits for the live read. -->
      {#if unlocking}One moment…{:else if shownLaps === 0 && counts.waiting === 0}I rode it{:else}Add a lap{/if}
    </button>

    <!-- Not while laps are still on their way: publishing re-signs the head it
         reads and retires the private one, so a lap in the air would be left
         behind on a feed nothing counts. -->
    {#if loaded && unlocked && laps > 0 && !isPublic && !confirmingPublish && counts.waiting === 0 && !sending}
      <button class="link" onclick={() => (confirmingPublish = true)} disabled={publishing}>
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
        <button class="collect" onclick={confirmPublish} disabled={publishing}>
          {publishing ? "Publishing…" : "Publish my count"}
        </button>
        <button class="link" onclick={() => (confirmingPublish = false)} disabled={publishing}>
          Keep it private
        </button>
      </div>
    </div>
  {/if}

  {#if counts.held > 0}
    <p class="msg note" role="status">
      {counts.held} {counts.held === 1 ? "lap" : "laps"} from an earlier day could not be added, because newer laps
      were already recorded on another device. Their times are kept on this phone.
    </p>
  {/if}

  {#if unlocked && (rows.length > 0 || today > 0)}
    <!-- The rider's own record of WHEN, which the public statement deliberately
         does not carry. Private: it is read from this phone and from entries
         sealed to the rider, and nothing on a public surface shows it. -->
    <div class="log">
      <button class="link" onclick={toggleLog} aria-expanded={showLog}>
        {showLog ? "Hide today's laps" : "Today's laps and times"}
      </button>
      {#if showLog}
        {#if rows.length === 0}
          <p class="msg note">No times saved for today's laps on this phone.</p>
        {:else}
          <ol class="laps">
            {#each rows as row (row.at + ":" + row.state + ":" + (row.lap ?? ""))}
              <li class:pending={row.state !== "counted"}>
                <span class="lapno">
                  {#if row.state === "counted"}{row.lap === null ? "Lap" : `Lap ${row.lap}`}
                  {:else if row.state === "held"}Not counted
                  {:else}Waiting to send{/if}
                </span>
                <span class="lapat">{timeFormat.format(row.at)}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if untimedToday > 0}
          <p class="msg note">
            {today} laps today - {timedToday} with times. {untimedToday === 1 ? "1 lap has" : `${untimedToday} laps have`}
            no time saved. Your count is still right.
          </p>
        {/if}
        {#if counts.unsealed > 0}
          <p class="msg note">Times for {counts.unsealed} {counts.unsealed === 1 ? "lap are" : "laps are"} still saving to your logbook.</p>
        {/if}
        <p class="msg note">Only you can see these. Times come from this phone's clock.</p>
        {#if rows.length > 0}
          <button class="link" onclick={copyLog}>{copied ? "Copied" : "Copy log"}</button>
        {/if}
        {#if copyFallback}
          <textarea class="copybox" readonly rows="6">{copyFallback}</textarea>
        {/if}
      {/if}
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

  .waiting {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: var(--warning);
  }

  .log { display: flex; flex-direction: column; align-items: flex-start; gap: 0.5rem; }

  .laps {
    width: 100%;
    max-height: 16rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .laps li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.3125rem 0.625rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }

  .laps li + li { border-top: 1px solid var(--border); }
  .laps li.pending { color: var(--text-dim); }
  .lapat { color: var(--text); }
  .laps li.pending .lapat { color: var(--text-muted); }

  .copybox {
    width: 100%;
    padding: 0.5rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
  }

  /* A quiet note, not a blocker: the card is usable while this is on screen. */
  .syncing {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
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
