<script lang="ts">
  /**
   * The public lap count, and the working behind it.
   *
   * Built to be disbelieved productively. The number at the top is the one THIS
   * browser added up from the published working, and when the working does not
   * support the number published alongside it the page goes red and says so.
   * That failure state is the asset: a check that can visibly fail is the only
   * kind whose passing means anything.
   *
   * VOCABULARY IS LOAD-BEARING, not styling. A CREDIT is a coaster ridden once,
   * ever; repeat rides are LAPS. "109 credits" marks us as outsiders on day one
   * to the exact audience this is for. No crypto words anywhere on this page —
   * no wallet, no mint, no token, no chain, and not "decentralised" either,
   * which invites the frame we are avoiding. A rider's feed is their LOGBOOK
   * and a statement is an ENTRY.
   *
   * WHAT MAY NOT BE CLAIMED, each for a reason the plan records: that anyone
   * rode (this is self-declared at tier 1, and the audience will test it on
   * camera); that anything is tamper-proof, immutable or permanent (a rider can
   * supersede their own history and nothing timestamps a write); that the
   * community runs this (the issuer registry is deferred — today the naming is
   * ours); that verification is corrective (this is additive, never an audit).
   *
   * Nothing here imports the auth store, the wallet stack or the router: the
   * page must boot for a reader who has no account and will never make one.
   */
  import { onMount } from "svelte";
  import { RITA_SUBJECT } from "@woco/shared";
  import { fetchVerifyReport, resolveCoaster, type VerifyReport } from "./lib/credits/verify-report.js";
  import { leafToCheck, spotCheckLeaf, type SpotCheck } from "./lib/credits/spot-check.js";

  /** How often the page re-asks, and how often the "checked N ago" line moves. */
  const RECHECK_MS = 60_000;
  const TICK_MS = 15_000;

  /**
   * The subject comes from the link and must resolve to a coaster the shipped
   * catalogue names. Anyone can mint a subject id and publish genuinely signed
   * entries against it, so a page that rendered any well-formed hash would lend
   * this typeface and this authority to an invented coaster with every number
   * on it perfectly true. There is deliberately no indexer override either.
   */
  const raw = new URLSearchParams(window.location.search).get("subject") ?? RITA_SUBJECT;
  const coaster = resolveCoaster(raw);

  /**
   * The entry check, plus the two states it can be in that are not results:
   * nothing has come back yet, and there was nothing worth checking. "Nothing
   * worth checking" is reachable — a record carrying no laps is schema-valid —
   * and without it the page would sit forever claiming a check was in flight.
   */
  type EntryState = SpotCheck | { state: "pending" } | { state: "none" };

  let report = $state<VerifyReport | null>(null);
  let error = $state<string | null>(null);
  let checking = $state(false);
  /** Last SUCCESSFUL check — what "checked N ago" reports. */
  let checkedAt = $state(0);
  /** Last ATTEMPT — what paces re-asking. Kept apart from the above so that a
   *  counter which is down is retried on the same 60s cadence rather than on
   *  every 15s tick, which is what happens when failure never moves the clock. */
  let attemptedAt = $state(0);
  let now = $state(Date.now());
  let entry = $state<EntryState>({ state: "pending" });

  const laps = $derived(report?.laps ?? 0);
  /** Above zero, every number on the page is a floor rather than a total. */
  const partial = $derived((report?.read.unreadable ?? 0) > 0);
  const contradicted = $derived(report !== null && !report.reconciliation.holds);
  const silent = $derived(report !== null && report.read.declared === 0);

  async function check() {
    if (!coaster || checking) return;
    checking = true;
    attemptedAt = Date.now();
    try {
      const next = await fetchVerifyReport(coaster);
      report = next;
      error = null;
      checkedAt = Date.now();
      // The floor qualifier travels with the number, including into the tab
      // title — a shared screenshot reading "127 laps" from a page that said
      // "at least 127" would have dropped the word that made it true.
      const floor = next.read.unreadable > 0 ? "at least " : "";
      document.title = `${floor}${next.laps.toLocaleString()} laps on ${next.coaster.name}`;

      // Then go and read one of the entries it named. Deliberately after the
      // count is on screen and never blocking it: this is a second, stronger
      // claim, and a storage gateway having a bad minute must not stop the
      // first one being made.
      // The previous result stays on screen until this one lands: blanking it
      // first would flash "fetching…" past the reader every minute for a claim
      // that has not changed.
      const target = leafToCheck(next.leaves, next.featured);
      entry = target ? await spotCheckLeaf(next.subject, target) : { state: "none" };
    } catch (e) {
      // A failed re-check never blanks a number that was true a minute ago —
      // the staleness line says how old it is, which is the honest version.
      error = e instanceof Error ? e.message : "could not reach the counter";
    } finally {
      checking = false;
      now = Date.now();
    }
  }

  onMount(() => {
    void check();

    // One timer does both jobs: it moves the "checked N ago" line, and when the
    // page has been VISIBLE long enough it re-asks. Hidden tabs never re-ask —
    // a link left open in a background tab for a week should cost one check.
    const due = () => document.visibilityState === "visible" && Date.now() - attemptedAt >= RECHECK_MS;
    const tick = setInterval(() => {
      now = Date.now();
      if (due()) void check();
    }, TICK_MS);
    const onVisible = () => {
      now = Date.now();
      if (due()) void check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  function ago(ms: number): string {
    if (ms < 45_000) return "just now";
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    // A published copy can be days old when a count has not moved; "72 hours
    // ago" is arithmetic rather than an answer.
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  const short = (hex: string) => `${hex.slice(0, hex.startsWith("0x") ? 10 : 8)}…${hex.slice(-4)}`;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
</script>

<main>
  {#if !coaster}
    <section class="card pad">
      <p class="kicker kicker--plain">Not a coaster we know</p>
      <h2>Nothing here names a coaster this page can look up.</h2>
      <p class="muted">
        Counts are shown only for coasters on the list this counter ships, so that a link cannot dress an invented
        one up as a real one.
      </p>
      <p><a href="?subject={RITA_SUBJECT}">See the Rita count instead</a></p>
    </section>
  {:else if report === null && error !== null}
    <section class="card pad">
      <p class="kicker kicker--plain">No answer</p>
      <h2>Could not reach the evidence just now.</h2>
      <p class="muted">{error}</p>
      <p class="muted small">
        Nothing is being shown as counted until the working can be fetched and added up here.
      </p>
      <button class="btn btn--ghost" onclick={check} disabled={checking}>Try again</button>
    </section>
  {:else if report === null}
    <section class="card pad"><p class="muted">Reading the logbooks…</p></section>
  {:else}
    <!-- ── The number ─────────────────────────────────────────────────── -->
    <header class="hero">
      <p class="kicker kicker--hi">
        {report.scope === "rider" ? "One rider's laps" : "Everyone's laps"}
      </p>

      <div class="count" aria-live="polite">
        {#if partial}<span class="floor">at least</span>{/if}
        <span class="figure mono">{laps.toLocaleString()}</span>
        <span class="unit">{plural(laps, "lap", "laps")}</span>
      </div>

      <h1>{report.coaster.name}</h1>
      <p class="park">{report.coaster.park}</p>
      {#if report.coaster.formerNames.length > 0}
        <p class="muted small">Ridden by some when it was {report.coaster.formerNames.join(", ")}.</p>
      {/if}

      {#if report.riders > 0}
        <!-- "ridden it at least once" asserted as fact what the honesty panel
             three sections down explicitly disclaims. What is known is what was
             signed. -->
        <p class="riders">
          {report.riders.toLocaleString()}
          {plural(report.riders, "rider has", "riders have")} signed at least one lap on
          {report.coaster.name}{#if report.scope === "rider"}, {report.communityLaps.toLocaleString()} laps between
          them{/if} — which is what having the credit means here.
        </p>
      {/if}
    </header>

    <!-- ── Did the working add up, here, in this browser? ──────────────── -->
    <!-- Scope-aware, because it has to be BEFORE a rider is ever featured: with
         a featured rider the headline is their entry's total, not the recount,
         and "which is the figure above" would quietly become false while
         looking exactly the same. The registry that switches this lives in
         another file, so the copy cannot depend on someone remembering. -->
    {#if report.leaves.length > 0}
      <section class="verdict" class:verdict--bad={contradicted}>
        {#if contradicted}
          <p class="verdict-line">
            <strong>The evidence does not support the total it came with.</strong>
            The entries below add up to {report.reconciliation.recounted.toLocaleString()}, published alongside a
            total of {report.reconciliation.declared.toLocaleString()}. This page will not show that as counted.
            {report.scope === "rider" ? "Nothing here should be trusted until that is explained." : "The figure above is the one the evidence actually supports."}
          </p>
        {:else if report.scope === "rider"}
          <p class="verdict-line">
            <strong>Added up on your device.</strong>
            The {report.leaves.length === 1 ? "entry" : `${report.leaves.length} entries`} listed below come to
            {report.reconciliation.recounted.toLocaleString()} laps between them, and the figure above is this
            rider's own {report.laps.toLocaleString()} of those. Nothing was taken on trust to get there.
          </p>
        {:else}
          <p class="verdict-line">
            <strong>Added up on your device.</strong>
            The {report.leaves.length === 1 ? "entry" : `${report.leaves.length} entries`} listed below come to
            {report.reconciliation.recounted.toLocaleString()}, which is the figure above. Nothing was taken on trust
            to get there.
          </p>
        {/if}
      </section>
    {/if}

    <!-- ── And is the entry it counted actually there? ─────────────────── -->
    {#if report.leaves.length > 0}
      <section class="verdict verdict--second" class:verdict--bad={entry.state === "contradicted"}>
        {#if entry.state === "pending"}
          <p class="verdict-line muted">Fetching one of the entries to read it directly…</p>
        {:else if entry.state === "none"}
          <p class="verdict-line muted">
            No entry here carries laps, so there is nothing yet to fetch and check.
          </p>
        {:else if entry.state === "confirmed"}
          <p class="verdict-line">
            <strong>And that entry is really there.</strong>
            The {entry.total.toLocaleString()}-lap entry was fetched from storage at the address the working points to
            — worked out here, not supplied by the counter — and the rider's own signature over exactly that number
            checked out in your browser.
          </p>
        {:else if entry.state === "contradicted"}
          <p class="verdict-line">
            <strong>That entry does not match the working</strong> — {entry.because}. This is the check doing its job;
            treat the count above with suspicion until it is explained.
          </p>
        {:else if entry.state === "missing"}
          <p class="verdict-line">
            <strong>Nothing came back from that address.</strong>
            An entry that has not finished settling on the network looks exactly like this, so on its own it proves
            nothing either way. The adding up above still stands.
          </p>
        {:else}
          <!-- "could not be fetched" would be wrong for the branches where
               bytes DID come back but could not be read — the sentence would
               contradict its own reason. -->
          <p class="verdict-line">
            <strong>That entry could not be checked</strong> — {entry.because}. Not a mark against anyone; the check
            simply did not run.
          </p>
        {/if}
      </section>
    {/if}

    {#if partial}
      <!-- "the truth is higher" is not quite a theorem: one rider can keep
           several logbooks, so an unreachable one could hold a later downward
           correction. Exotic, but the categorical version would be the kind of
           overstatement this page exists to avoid. -->
      <p class="note note--warn">
        {report.read.unreadable === 1 ? "One logbook" : `${report.read.unreadable} logbooks`} could not be reached
        when this was counted, so laps recorded only {plural(report.read.unreadable, "there", "in those")} are missing
        from it. Treat the number as a floor rather than a finished total.
      </p>
    {/if}

    {#if report.equivocations.length > 0}
      <!-- Not "a logbook disagrees with itself": only the HEAD of each logbook
           is read, so one logbook can never yield two entries at one position.
           An equivocation is by construction two logbooks belonging to the same
           rider saying different things. -->
      <p class="note note--warn">
        <strong>{plural(report.equivocations.length, "A rider's logbooks disagree", "Some riders' logbooks disagree")}
        with each other.</strong>
        The same rider keeps a logbook on more than one device, and two of them carry different entries at the same
        position. The count picks one by a fixed rule every counter applies the same way — and tells you it happened
        rather than smoothing it over.
      </p>
    {/if}

    <!-- ── What was read ──────────────────────────────────────────────── -->
    <!-- Labels name the right unit: the first and last count LOGBOOKS (feed
         owners), the middle counts RIDERS (holders, after the tally picks a
         winner per rider). One rider keeping two logbooks would otherwise
         render as "2 riders looked up, 1 had a logbook" — both false. -->
    <section class="stats">
      <div><span class="stat mono">{report.read.declared.toLocaleString()}</span><span class="stat-label">{plural(report.read.declared, "logbook", "logbooks")} looked up</span></div>
      <div><span class="stat mono">{report.read.contributing.toLocaleString()}</span><span class="stat-label">{plural(report.read.contributing, "rider", "riders")} with an entry</span></div>
      <div><span class="stat mono">{report.read.unreadable.toLocaleString()}</span><span class="stat-label">{plural(report.read.unreadable, "logbook", "logbooks")} out of reach</span></div>
    </section>

    {#if silent}
      <!-- "Nobody has signed a lap yet" would assert something the counter
           cannot know: this is also exactly what a counter looks like after it
           has lost track of whose logbooks to read. A rider who published a lap
           and then read that sentence would have caught the page in a lie. -->
      <p class="note">
        This counter does not know of a signed lap on {report.coaster.name} yet. The total is added up from riders'
        own logbooks, so until it knows of one there is nothing to add up — which is not the same as a total of
        nought.
      </p>
    {/if}

    <!-- ── The honest limits ──────────────────────────────────────────── -->
    <section class="honesty">
      <h2>What this page checks — and what it doesn't</h2>

      <div class="claims">
        <p>
          <strong>What your browser just did.</strong>
          Every lap here comes from a signed entry — a logbook only its author can write in. This page downloaded the
          full evidence list and did the adding up itself, on your device. The headline is your machine's arithmetic,
          not a number we typed in.
        </p>
        <p>
          <!-- Conditional, because this paragraph would otherwise claim a check
               that did not run — on a page whose entire argument is that it does
               not overstate what it did. -->
          <strong>
            {entry.state === "confirmed" ? "And it read one entry for itself." : "It also goes and reads one entry."}
          </strong>
          Working out where an entry lives needs nothing from us — the list says whose logbook and which position, and
          the address follows from public rules.
          {#if entry.state === "confirmed"}
            So the page fetched one straight from storage and checked the rider's signature on it. Every other row can
            be checked the same way.
          {:else if entry.state === "contradicted"}
            <!-- "it could not" would be false here: the page DID fetch and read
                 the entry. It disagreed, which is the one state whose accuracy
                 matters most. -->
            It did so here, and what it found did not match — see above. Every row can be checked the same way by
            anyone.
          {:else}
            The page fetches one straight from storage and checks the rider's signature on it{#if entry.state === "missing" || entry.state === "unchecked"}&nbsp;— this time it could not, as it says above{/if}. Every row can
            be checked the same way by anyone.
          {/if}
        </p>
        <p>
          <strong>What it does not prove.</strong>
          It cannot prove anyone physically rode. A lap here means the rider signed their name to it — the same honour
          system coaster counting has always run on, now with receipts. Nobody's count is being checked against
          anyone else's, and never will be: this is an extra thing a rider can choose, not a test anyone has to pass.
        </p>
        <p>
          <strong>Counts can change.</strong>
          Riders own their logbooks and can correct them at any time, up or down. This page shows the latest entry the
          counter could read, not a sealed history — so read it as a signed, public, re-addable tally rather than a
          permanent one.
        </p>
        <p>
          <strong>When we cannot see everything, we say so.</strong>
          If a logbook could not be reached while counting, the number above is marked as a floor rather than a
          finished total.
        </p>
        <p>
          <strong>Who runs the counting.</strong>
          Today the coaster names come from a list this counter ships, and the counter is ours. The entries themselves
          belong to the riders who signed them, and anyone can redo this count from them without asking us.
        </p>
      </div>
    </section>

    <!-- ── The working ────────────────────────────────────────────────── -->
    {#if report.leaves.length > 0}
      <section class="working">
        <h2>The working</h2>
        <p class="muted small">
          One line per rider: the signing identity on their logbook, where it was read from, and the lifetime laps
          that entry carries. These are the numbers that were added up.
        </p>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th scope="col">Rider</th>
                <th scope="col">Logbook</th>
                <th scope="col" class="num">Laps</th>
              </tr>
            </thead>
            <tbody>
              {#each report.leaves as leaf (leaf.holder)}
                <tr class:featured={leaf.holder === report.featured?.holder}>
                  <td><code title={leaf.holder}>{short(leaf.holder)}</code></td>
                  <td><code title={leaf.feedOwner}>{short(leaf.feedOwner)}</code></td>
                  <td class="num mono">{leaf.total.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <!-- ── Do it yourself ─────────────────────────────────────────────── -->
    <section class="diy">
      <h2>Check it yourself</h2>
      <ol>
        <li>
          <strong>Read the evidence.</strong>
          {#if report.sources.via === "published" && report.sources.feed}
            <!-- The link would point at a counter this page just failed to
                 reach. The address is the honest alternative: it is where the
                 working actually came from, and it is computable from the
                 coaster alone by the rules below. -->
            This working came from storage, not from the counter: it is the last report
            <code>{report.sources.indexer}</code> published, read from the address anyone can work out from the
            coaster alone — <code>{report.sources.feed.topic}</code>, signed by
            <code>{report.sources.feed.indexer}</code>. Every rider looked up, every entry used, every value.
          {:else}
            Open <a href={report.sources.manifestUrl} rel="nofollow noreferrer">the full list this page counted</a> —
            every rider looked up, every entry used, every value.
          {/if}
        </li>
        <li>
          <strong>Do the arithmetic somewhere else.</strong> Add up <code>total</code> across <code>leaves</code>.
          That is the figure at the top.
        </li>
        <li>
          <strong>Go to the entries themselves.</strong> Each one names the signing identity, the logbook it was read
          from and the position in it — everything needed to work out where that entry is stored and check its
          signature, without involving this page. That is what the check above does for one of them.
        </li>
        <li>
          <strong>Or count it all again.</strong> The <code>participants</code> list is the input set — the same
          public starting point any counter would use. Run your own over it, and if you get a different number,
          publish it.
        </li>
      </ol>

      <p class="muted small">
        Straight about the limits. Only ever one entry is fetched and checked here, never all of them — checking every row would
        read as this page auditing riders' counts, which is not what it is for. The counter also writes each evidence
        list to storage, at an address anyone can work out from the coaster alone, so it can be read without asking
        the counter anything — but a written copy is only as current as the last time the number changed. And none of
        this is independent of us: the storage and the counter are both ours to run. What happens on your device is the
        arithmetic and the signature check; what makes it checkable by anyone at all is that the inputs are public.
      </p>
    </section>

    <footer>
      <!-- The counter's own answer can be up to its cache window old, so
           "checked just now" alone would overstate freshness by up to half a
           minute — visible against laps happening on camera. -->
      <p class="muted small">
        <!-- "Counted by X" alone would credit X with answering, which on the
             published path it did not do — the page read a copy X left behind.
             "Could not be asked" rather than "could not be reached": the
             fallback also runs when the counter answered with something
             unusable, and naming the wrong failure sends people to the wrong
             place. The age means something different on that path too — not a
             cache window but how long since the count last changed — so it is
             rendered in the same human units as everything else, because it can
             be days rather than the seconds a served answer is. -->
        Counted by <code>{report.sources.indexer}</code>{#if report.sources.via === "published"}, which could not be
        asked just now — this is the last working it published, read from storage and added up here, published
        {ago(report.ageMs)}{:else}, checked {ago(now - checkedAt)}{#if report.ageMs >= 1000}, from an answer
        {Math.round(report.ageMs / 1000)}s old{/if}{/if}.
        {#if error}<span class="stale"> Last try failed: {error}</span>{/if}
      </p>
      <button class="btn btn--ghost" onclick={check} disabled={checking}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </footer>
  {/if}
</main>

<style>
  main {
    max-width: 46rem;
    margin: 0 auto;
    padding: clamp(1.5rem, 5vw, 4rem) 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .pad { padding: 1.5rem; }
  .pad > * + * { margin-top: 0.75rem; }
  .muted { color: var(--text-secondary); }
  .small { font-size: 0.875rem; line-height: 1.55; }

  h2 { font-size: 1.25rem; }

  /* ── Hero ─────────────────────────────────────────────────────────── */

  .hero { padding-top: 1rem; }

  .count {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.75rem 0 0.25rem;
  }
  .floor {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--warning);
    align-self: center;
  }
  .figure {
    font-size: clamp(4.5rem, 22vw, 9rem);
    font-weight: 700;
    line-height: 0.85;
    letter-spacing: -0.05em;
    color: var(--accent);
  }
  .unit {
    font-family: var(--font-display);
    font-size: clamp(1.25rem, 4vw, 2rem);
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: -0.02em;
  }

  h1 { font-size: clamp(1.75rem, 6vw, 2.75rem); margin-top: 0.5rem; }
  .park {
    margin: 0.25rem 0 0;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .riders {
    margin: 1rem 0 0;
    color: var(--text-secondary);
    max-width: 34rem;
  }

  /* ── Verdict ──────────────────────────────────────────────────────── */

  .verdict {
    border-left: 2px solid var(--accent);
    background: var(--accent-subtle);
    padding: 1rem 1.25rem;
    border-radius: var(--radius-sm);
  }
  .verdict--bad {
    border-left-color: var(--error);
    background: var(--error-subtle);
  }
  /* The second claim is a step further, not a second headline. */
  .verdict--second {
    background: transparent;
    border-left-color: var(--border-hover);
  }
  .verdict--second.verdict--bad {
    background: var(--error-subtle);
    border-left-color: var(--error);
  }
  .verdict-line { margin: 0; line-height: 1.6; color: var(--text-secondary); }
  .verdict strong { color: var(--text); }

  .note {
    margin: 0;
    padding: 0.875rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.55;
  }
  .note--warn { border-color: var(--warning); }
  .note strong { color: var(--text); }

  /* ── Stats ────────────────────────────────────────────────────────── */

  .stats {
    display: grid;
    /* Wraps rather than squeezing: three uppercase mono labels in a 390px
       viewport would each be a two-line column about 90px wide. */
    grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .stats > div {
    background: var(--bg-surface);
    padding: 1rem 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .stat { font-size: 1.5rem; font-weight: 600; color: var(--text); }
  .stat-label {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }

  /* ── Honesty ──────────────────────────────────────────────────────── */

  .claims {
    margin-top: 1rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 1.25rem 2rem;
  }
  .claims p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.6;
    border-top: 1px solid var(--border);
    padding-top: 0.875rem;
  }
  .claims strong { display: block; color: var(--text); margin-bottom: 0.25rem; }

  /* ── Working ──────────────────────────────────────────────────────── */

  .scroller { overflow-x: auto; margin-top: 1rem; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  th {
    text-align: left;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    padding: 0 0.75rem 0.5rem 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 0.625rem 0.75rem 0.625rem 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .num { text-align: right; padding-right: 0; }
  td.num { color: var(--text); font-weight: 600; }
  tr.featured td { color: var(--text); }
  tr.featured td.num { color: var(--accent); }

  code {
    font-family: var(--font-mono);
    font-size: 0.8125em;
    color: var(--text-muted);
    word-break: break-all;
  }

  /* ── Do it yourself ───────────────────────────────────────────────── */

  .diy ol {
    margin: 1rem 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.55;
  }
  .diy li::marker { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.75rem; }
  .diy strong { color: var(--text); }
  /* The raw evidence is the point of the section, so its link has to read as
     one at a glance rather than as a hairline under grey body text. */
  .diy a { color: var(--accent-text); border-bottom-color: var(--accent); }
  .diy a:hover { color: var(--accent); }

  /* ── Footer ───────────────────────────────────────────────────────── */

  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 1.5rem;
  }
  footer p { margin: 0; }
  .stale { color: var(--warning); }

  button:disabled { opacity: 0.5; cursor: default; }
</style>
