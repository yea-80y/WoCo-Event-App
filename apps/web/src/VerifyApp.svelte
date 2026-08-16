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

  let report = $state<VerifyReport | null>(null);
  let error = $state<string | null>(null);
  let checking = $state(false);
  let checkedAt = $state(0);
  let now = $state(Date.now());
  /** The result of going and reading one entry. Null while it is in flight. */
  let entry = $state<SpotCheck | null>(null);
  let entryLaps = $state(0);

  const laps = $derived(report?.laps ?? 0);
  /** Above zero, every number on the page is a floor rather than a total. */
  const partial = $derived((report?.read.unreadable ?? 0) > 0);
  const contradicted = $derived(report !== null && !report.reconciliation.holds);
  const silent = $derived(report !== null && report.read.declared === 0);

  async function check() {
    if (!coaster || checking) return;
    checking = true;
    try {
      const next = await fetchVerifyReport(coaster);
      report = next;
      error = null;
      checkedAt = Date.now();
      document.title = `${next.laps.toLocaleString()} laps on ${next.coaster.name}`;

      // Then go and read one of the entries it named. Deliberately after the
      // count is on screen and never blocking it: this is a second, stronger
      // claim, and a storage gateway having a bad minute must not stop the
      // first one being made.
      // The previous result stays on screen until this one lands: blanking it
      // first would flash "fetching…" past the reader every minute for a claim
      // that has not changed.
      const target = leafToCheck(next.leaves, next.featured);
      if (!target) {
        entry = null;
        entryLaps = 0;
      } else {
        entryLaps = target.total;
        entry = await spotCheckLeaf(next.subject, target);
      }
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
    const due = () => document.visibilityState === "visible" && Date.now() - checkedAt >= RECHECK_MS;
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
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
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
        <p class="riders">
          {report.riders.toLocaleString()}
          {plural(report.riders, "rider has", "riders have")} the {report.coaster.name} credit — ridden it at least
          once{#if report.scope === "rider"}, {report.communityLaps.toLocaleString()} laps between them{/if}.
        </p>
      {/if}
    </header>

    <!-- ── Did the working add up, here, in this browser? ──────────────── -->
    <section class="verdict" class:verdict--bad={contradicted}>
      {#if contradicted}
        <p class="verdict-line">
          <strong>The evidence does not support the total it came with.</strong>
          The entries below add up to {report.reconciliation.recounted.toLocaleString()}, published alongside a total
          of {report.reconciliation.declared.toLocaleString()}. This page will not show that as counted. The figure
          above is the one the evidence actually supports.
        </p>
      {:else}
        <p class="verdict-line">
          <strong>Added up on your device.</strong>
          The {report.leaves.length === 1 ? "entry" : `${report.leaves.length} entries`} listed below come to
          {report.reconciliation.recounted.toLocaleString()}, which is the figure above. Nothing was taken on trust to
          get there.
        </p>
      {/if}
    </section>

    <!-- ── And is the entry it counted actually there? ─────────────────── -->
    {#if report.leaves.length > 0}
      <section class="verdict verdict--second" class:verdict--bad={entry?.state === "contradicted"}>
        {#if entry === null}
          <p class="verdict-line muted">Fetching one of the entries to read it directly…</p>
        {:else if entry.state === "confirmed"}
          <p class="verdict-line">
            <strong>And that entry is really there.</strong>
            The {entryLaps.toLocaleString()}-lap entry was fetched from storage at the address the working points to
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
          <p class="verdict-line">
            <strong>That entry could not be fetched to check it</strong> — {entry.because}. Not a mark against anyone;
            the check simply did not run.
          </p>
        {/if}
      </section>
    {/if}

    {#if partial}
      <p class="note note--warn">
        {report.read.unreadable === 1 ? "One logbook" : `${report.read.unreadable} logbooks`} could not be reached
        when this was counted, so laps in {plural(report.read.unreadable, "it", "them")} are missing. Treat the number
        as a floor, not a finished total.
      </p>
    {/if}

    {#if report.equivocations.length > 0}
      <p class="note note--warn">
        <strong>{report.equivocations.length === 1 ? "A logbook disagrees" : "Some logbooks disagree"} with
        {plural(report.equivocations.length, "itself", "themselves")}.</strong>
        Two different entries turned up at the same position in
        {plural(report.equivocations.length, "one rider's logbook", "these riders' logbooks")}. The count picks one by
        a fixed rule every counter applies the same way — and tells you it happened rather than smoothing it over.
      </p>
    {/if}

    <!-- ── What was read ──────────────────────────────────────────────── -->
    <section class="stats">
      <div><span class="stat mono">{report.read.declared.toLocaleString()}</span><span class="stat-label">riders looked up</span></div>
      <div><span class="stat mono">{report.read.contributing.toLocaleString()}</span><span class="stat-label">had a logbook</span></div>
      <div><span class="stat mono">{report.read.unreadable.toLocaleString()}</span><span class="stat-label">out of reach</span></div>
    </section>

    {#if silent}
      <p class="note">
        Nobody has signed a lap on {report.coaster.name} yet. The total is added up from riders' own logbooks, so
        until somebody writes one there is nothing to add up — which is not the same as a total of nought.
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
            {entry?.state === "confirmed" ? "And it read one entry for itself." : "It also goes and reads one entry."}
          </strong>
          Working out where an entry lives needs nothing from us — the list says whose logbook and which position, and
          the address follows from public rules.
          {#if entry?.state === "confirmed"}
            So the page fetched one straight from storage and checked the rider's signature on it. Every other row can
            be checked the same way.
          {:else}
            The page fetches one straight from storage and checks the rider's signature on
            it{#if entry !== null} — this time it could not, as it says above{/if}. Every row can be checked the same
            way by anyone.
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
          Riders own their logbooks and can correct them at any time, up or down. This page always shows the latest
          entry, not a sealed history — so read it as a signed, public, re-addable tally rather than a permanent one.
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
          Open <a href={report.sources.manifestUrl} rel="nofollow noreferrer">the full list this page counted</a> —
          every rider looked up, every entry used, every value.
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
        Straight about the limits. One entry is fetched and checked here, never all of them — checking every row would
        read as this page auditing riders' counts, which is not what it is for. The evidence list is served on
        request rather than published to durable storage, so "published" means "served" for now. And none of this is
        independent of us: the storage and the counter are both ours to run. What happens on your device is the
        arithmetic and the signature check; what makes it checkable by anyone at all is that the inputs are public.
      </p>
    </section>

    <footer>
      <p class="muted small">
        Counted by <code>{report.sources.indexer}</code>, checked {ago(now - checkedAt)}.
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
