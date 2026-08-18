<script lang="ts">
  /**
   * The public lap count — and, one click away, the working behind it.
   *
   * Built to be disbelieved productively. The number is the one THIS browser
   * added up from the published working, and when the working does not support
   * the number published alongside it the page goes red and says so. That
   * failure state is the asset: a check that can visibly fail is the only kind
   * whose passing means anything.
   *
   * TWO SURFACES, ONE FETCH, and the split is the whole point of this file's
   * shape. The page previously said everything at once, and a review had found
   * nine places it overclaimed — each fixed by ADDING a qualifying sentence.
   * Every sentence was defensible; together they read as a legal disclaimer to
   * a coaster fan, which is the exact outsider signal the plan warns against.
   * So none of the honesty was deleted, it was moved one click away: the
   * COUNTER is a kicker, a number, a coaster, one line and one link; THE
   * WORKING carries the entries, the limits and the check-it-yourself steps.
   *
   * They are one component on one report deliberately. Two entries with two
   * fetches would reintroduce, at the page level, the very failure the single
   * request exists to avoid (see verify-report.ts, "ONE REQUEST"): a reader
   * screenshots the number, clicks through, and the working recounts a
   * DIFFERENT report across a cache boundary — explaining a number nobody is
   * looking at any more, or manufacturing a disagreement out of a lap that
   * landed in between. Here the working always explains the very report the
   * counter just showed, because it is the same object.
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
  import {
    fetchVerifyReport,
    resolveCoaster,
    challengeLabel,
    type VerifyReport,
  } from "./lib/credits/verify-report.js";
  import { leafToCheck, spotCheckLeaf, type SpotCheck } from "./lib/credits/spot-check.js";

  /** How often the page re-asks, and how often the "counted N ago" line moves. */
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
  /** The challenge people came to watch, or null. A label, never a claim: it
   *  says nothing about WHOSE laps the number is, which is what `scope` says. */
  const challenge = coaster ? challengeLabel(coaster.subject) : null;

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
  /** Last SUCCESSFUL check — what "counted N ago" reports. */
  let checkedAt = $state(0);
  /** Last ATTEMPT — what paces re-asking. Kept apart from the above so that a
   *  counter which is down is retried on the same 60s cadence rather than on
   *  every 15s tick, which is what happens when failure never moves the clock. */
  let attemptedAt = $state(0);
  let now = $state(Date.now());
  let entry = $state<EntryState>({ state: "pending" });

  /**
   * Which surface is showing. The hash, not a variable, so that the working has
   * a URL a reader can link to when challenged — the single reason an in-place
   * expander was rejected. `?subject=` survives a fragment-only href, so both
   * views stay pinned to the same coaster.
   */
  let view = $state<"counter" | "working">(
    window.location.hash === "#working" ? "working" : "counter",
  );

  const laps = $derived(report?.laps ?? 0);
  /** Above zero, every number on the page is a floor rather than a total. */
  const partial = $derived((report?.read.unreadable ?? 0) > 0);
  const contradicted = $derived(report !== null && !report.reconciliation.holds);
  const silent = $derived(report !== null && report.read.declared === 0);

  /**
   * How old the ANSWER is, not how long since we asked. The counter's own reply
   * can be up to its cache window old, so "checked just now" would overstate
   * freshness by up to half a minute — visible against laps happening on
   * camera. Folding the cache age in here lets the sparse surface say "counted
   * N ago" without printing a second clause to correct the first.
   */
  const answerAgeMs = $derived(report === null ? 0 : now - checkedAt + report.ageMs);

  /**
   * The one failure the COUNTER surfaces, in precedence order. A page whose
   * whole argument is that a check can visibly fail must not keep its strongest
   * failure state on the surface nobody clicks through to. Everything else the
   * spot-check can report — confirmed, missing, unchecked — renders nothing
   * here: silence never accuses, and on this surface silence never renders.
   */
  const counterFailure = $derived(
    report === null || report.leaves.length === 0
      ? null
      : contradicted
        ? "recount"
        : entry.state === "contradicted"
          ? "entry"
          : null,
  );

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

    // One timer does both jobs: it moves the "counted N ago" line, and when the
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

    // Scrolled explicitly because neither fragment names an element: a reader
    // sent from the foot of the working back to the counter would otherwise
    // land on a screen of whitespace below a one-screen page.
    const onHash = () => {
      view = window.location.hash === "#working" ? "working" : "counter";
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);

    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("hashchange", onHash);
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

<main class:main--counter={view === "counter"}>
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
      <!-- "the count", not "the evidence": on the counter's own failure the
           reader is here for a number, and evidence is the working's register. -->
      <h2>Could not reach the count.</h2>
      <p class="muted">{error}</p>
      <p class="muted small">
        Nothing is shown as counted until the working can be fetched and added up here.
      </p>
      <button class="btn btn--ghost" onclick={check} disabled={checking}>Try again</button>
    </section>
  {:else if report === null}
    <section class="card pad"><p class="muted">Reading the logbooks…</p></section>

  <!-- ══ THE COUNTER ═══════════════════════════════════════════════════ -->
  <!-- Kicker, number, coaster, one line, one link. Anything added here has to
       earn its place against a screenshot, because a screenshot is what this
       surface is for. -->
  {:else if view === "counter"}
    <header class="hero">
      {#if challenge}
        <!-- The challenge, never a person. "Dan's lap count" would make the
             headline possessive over a figure that SUMS every rider on the
             coaster; the challenge owns the framing instead. -->
        <p class="kicker kicker--hi">{challenge}</p>
      {/if}

      <div class="count" aria-live="polite">
        {#if partial}<span class="floor">at least</span>{/if}
        <span class="figure mono">{laps.toLocaleString()}</span>
        <span class="unit">{plural(laps, "lap", "laps")}</span>
      </div>

      <h1>{report.coaster.name}</h1>
      <p class="park">{report.coaster.park}</p>
    </header>

    {#if counterFailure !== null}
      <!-- REPLACES the claim rather than sitting above it. The page must never
           assert "nothing is taken on our word" alongside a check that just
           failed — that pairing is the screenshot this design exists to make
           impossible. The full explanation is one click away, and the link
           below is now the call to action for the failure. -->
      <p class="claim claim--bad">
        {#if counterFailure === "recount"}
          {#if report.scope === "rider"}
            The published working behind this number does not add up. Treat it with suspicion until that is
            explained.
          {:else}
            The published working does not add up to the total it came with. The number above is only what the
            entries themselves support.
          {/if}
        {:else}
          One of the entries behind this number does not match its published copy.
        {/if}
      </p>
    {:else}
      <p class="claim">
        Every lap here is signed by the rider who rode it. Nothing is taken on our word.
      </p>
    {/if}

    <p class="more"><a href="#working">See the working →</a></p>

    <footer class="foot foot--counter">
      {#if report.sources.via === "published"}
        <!-- The disclosure has to live on THIS surface, sparse or not: the
             fallback copy is signed evidence and perfectly checkable, but it is
             not the counter speaking now, and letting it look like the counter
             answering would overstate how fresh the number is. "Could not be
             asked" rather than "could not be reached" — the fallback also runs
             when the counter answered with something unusable, and naming the
             wrong failure sends people to the wrong place. -->
        <p class="muted small">
          The counter could not be asked just now. This is the last count it published, {ago(report.ageMs)}.
        </p>
        <button class="btn btn--ghost" onclick={check} disabled={checking}>
          {checking ? "Checking…" : "Try again"}
        </button>
      {:else if error}
        <p class="muted small">Counted {ago(answerAgeMs)} — the last try to re-check failed.</p>
        <button class="btn btn--ghost" onclick={check} disabled={checking}>
          {checking ? "Checking…" : "Try again"}
        </button>
      {:else}
        <!-- "Counted", not "checked": the verb names when the figure was
             computed, which is what folds the counter's cache age into the
             sentence instead of into a correction after it. -->
        <p class="muted small">Counted {ago(answerAgeMs)}.</p>
      {/if}
    </footer>

  <!-- ══ THE WORKING ═══════════════════════════════════════════════════ -->
  <!-- Everything the counter used to carry, with room to say it properly. -->
  {:else}
    <header class="wh">
      <p class="kicker kicker--plain">{challenge ? `${challenge} · The working` : "The working"}</p>

      <!-- A compact count, not a decoration: a reader who lands here from a
           shared link must see the figure WITH its qualifiers before reading
           anything about it. The floor chip and the red state come along. -->
      <div class="count count--sm" class:count--bad={counterFailure !== null}>
        {#if partial}<span class="floor">at least</span>{/if}
        <span class="figure mono">{laps.toLocaleString()}</span>
        <span class="unit">{plural(laps, "lap", "laps")}</span>
      </div>
      <p class="wh-sub">{report.coaster.name}, {report.coaster.park}</p>
      {#if report.coaster.formerNames.length > 0}
        <p class="muted small">Ridden by some when it was {report.coaster.formerNames.join(", ")}.</p>
      {/if}

      <p class="more"><a href="#count">← Back to the count</a></p>
    </header>

    <!-- ── Whose laps is this? ────────────────────────────────────────── -->
    <!-- The counter is scope-silent by construction, so the disclosure lands
         here. The two scopes are different numbers over the same evidence. -->
    <p class="scope">
      {#if report.scope === "rider"}
        <!-- "the signing identity published for this challenge", never "signed
             by <name>": the key-to-person link is an ANNOUNCEMENT, not
             mathematics. The signature proves an identity signed; that the
             identity is a given rider is something their team said. -->
        This is the lifetime total in one rider's own logbook — the signing identity published for this challenge.
        {#if report.riders > 0}
          {report.riders.toLocaleString()}
          {plural(report.riders, "rider has", "riders have")} signed at least one lap on {report.coaster.name},
          {report.communityLaps.toLocaleString()} laps between them.
        {/if}
      {:else}
        This is every rider's laps on {report.coaster.name} added together.
        {#if report.riders > 0}
          <!-- "ridden it at least once" asserted as fact what the honesty panel
               below explicitly disclaims. What is known is what was signed. -->
          {report.riders.toLocaleString()}
          {plural(report.riders, "rider has", "riders have")} signed at least one lap here — which is what having
          the credit means.
        {/if}
      {/if}
    </p>

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
          <!-- Was "What your browser just did", which read as plumbing rather
               than as an answer to the question a sceptic is actually asking. -->
          <strong>Where the number comes from.</strong>
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

    <!-- ── The entries ────────────────────────────────────────────────── -->
    <!-- Named "The entries", not "The working": this whole surface is the
         working now, and a section inside it by the same name is noise. -->
    {#if report.leaves.length > 0}
      <section class="entries">
        <h2>The entries</h2>
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

    <footer class="foot">
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
  /* The counter is five elements; a 2rem rhythm designed for a dozen sections
     scatters them down the page instead of composing them. */
  .main--counter { gap: 1.25rem; }

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

  /* ── The claim, and the way out of the page ───────────────────────── */

  /* Full-strength body text, not small print and not bold. Muting it or
     flagging it is what turns a claim into a disclaimer; one visual voice is
     what keeps two sentences a statement. */
  .claim {
    margin: 0.5rem 0 0;
    max-width: 32rem;
    font-size: 1.0625rem;
    line-height: 1.6;
    color: var(--text);
  }
  .claim--bad {
    border-left: 2px solid var(--error);
    background: var(--error-subtle);
    padding: 0.875rem 1.125rem;
    border-radius: var(--radius-sm);
    color: var(--text);
  }

  /* Attached to the claim it substantiates — here is the claim, here is how you
     check it — and a link rather than a button, because a link promises reading
     and a button promises an action. */
  .more { margin: 0; }
  .more a {
    font-size: 0.9375rem;
    color: var(--accent-text);
    border-bottom: 1px solid var(--accent);
    text-decoration: none;
    padding-bottom: 0.0625rem;
  }
  .more a:hover { color: var(--accent); }

  /* ── The working's own header ─────────────────────────────────────── */

  .wh { padding-top: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .wh .count { margin: 0.25rem 0 0; gap: 0.5rem; }
  .count--sm .figure { font-size: clamp(2rem, 8vw, 2.75rem); line-height: 1; }
  .count--sm .unit { font-size: 1rem; }
  .count--sm .floor { font-size: 0.6875rem; }
  /* A direct arrival must see that the figure is disputed before reading a word
     about it; the verdict below does the explaining. */
  .count--bad .figure { color: var(--error); }
  .wh-sub {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }
  .wh .muted.small { margin: 0; }

  .scope {
    margin: 0;
    max-width: 34rem;
    color: var(--text-secondary);
    line-height: 1.6;
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

  /* ── The entries ──────────────────────────────────────────────────── */

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

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 1.5rem;
  }
  /* No rule above it and barely there: on the counter this is a caption on the
     number, not the end of a document. */
  .foot--counter {
    border-top: none;
    padding-top: 0.5rem;
    gap: 0.75rem;
    justify-content: flex-start;
  }
  .foot p { margin: 0; }
  .stale { color: var(--warning); }

  button:disabled { opacity: 0.5; cursor: default; }
</style>
