<script lang="ts">
  /**
   * CertIssueModal — award a certificate badge to named holders (Gate B, slice 4).
   * Design record: docs/SWARM_SOCIAL_PLAN.md, BUILD RECORDs slices 3 and 4.
   *
   * A CENTERED MODAL, like PodCreateModal and unlike the slide-in edit drawer,
   * following this layer's own convention: committing acts get a dialog,
   * incidental edits get a drawer. A run writes permanent, publicly-readable,
   * unrevocable records — and it cannot be dismissed while one is in flight,
   * because the next page's address is chained from the last verified write.
   *
   * WHAT THIS SURFACE IS FOR, beyond collecting a list. Three of its jobs exist
   * only because of how this rail fails:
   *
   * 1. Nothing is dropped quietly. Bad lines, duplicates and attendees with no
   *    badge key are all SHOWN and counted. A list that silently loses an entry
   *    is indistinguishable from one that never had it, and the run is permanent.
   * 2. `superseded` gets no retry button, in any mode. On a single-device run it
   *    means the address arithmetic aimed at an occupied version, and re-running
   *    would compound that at permanent addresses. This surface cannot tell that
   *    from a genuine second device, so it says both and offers neither.
   * 3. The numbers the supervised sequence checks — landed, already held, pages
   *    written, and the probe counters — are printed verbatim, so an operator
   *    verifies from the screen rather than from devtools.
   */
  import type { PodDirectoryEntry, SignedManifestV1, Hex0x, HolderPubkey } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { getAttendeeKeys, updatePod, type AttendeeKeyRow } from "../../api/pod.js";
  import { getEventsByCreator, getEventOrders } from "../../api/events.js";
  import {
    readCertLog,
    issueCertificates,
    loadBadgeManifest,
    type IssueRunResult,
  } from "../../pod-cert/issue.js";
  import {
    parseHolderKeys,
    splitAttendees,
    holderRejectLabel,
    uncertifiableLabel,
    type HolderReject,
    type TicketClaim,
  } from "../../pod-cert/holders.js";
  import { hintCounts, probeCounts, probeTotals } from "../../swarm/probe-stats.js";

  interface Props {
    pod: PodDirectoryEntry | null;
    onclose: () => void;
    /** Fired after a run lands anything, so the manager can refresh its counter. */
    onissued: (updated: PodDirectoryEntry) => void;
  }
  let { pod, onclose, onissued }: Props = $props();

  type Phase = "loading" | "compose" | "running" | "done" | "stopped" | "blocked";
  let phase = $state<Phase>("loading");
  let blockedReason = $state("");

  let manifest = $state<SignedManifestV1 | null>(null);
  /** Distinct holders the log already carries. */
  let existing = $state<HolderPubkey[]>([]);
  let source = $state<"paste" | "event">("paste");
  let pasteText = $state("");

  // ── attendee import ───────────────────────────────────────────────────────
  let events = $state<Array<{ eventId: string; title: string }>>([]);
  let selectedEventId = $state("");
  let attendees = $state<AttendeeKeyRow[] | null>(null);
  /** Every ticket claim for the event — the TRUE denominator. Bindings alone
   *  would count only those who signed in or redeemed the link, which is a
   *  minority, and the surface would claim completeness it does not have. */
  let claims = $state<TicketClaim[] | null>(null);
  let attendeeError = $state("");
  let attendeesLoading = $state(false);

  // ── run state ─────────────────────────────────────────────────────────────
  let progress = $state({ done: 0, total: 0 });
  let result = $state<IssueRunResult | null>(null);
  let probeSummary = $state("");
  /** Head coordinates of the log, shown so a band rollover is verifiable on
   *  screen rather than only by inference from a changing count. */
  let head = $state<{ band: number; version: number } | null>(null);
  let pagesRead = $state(0);
  /**
   * Which `open()` is current. The dialog can be closed while still loading, so
   * a second badge can be opened before the first `open()` finishes its awaits —
   * two uncancelled runs, the older one landing last and painting badge A's
   * manifest and holder list under badge B's title. `precheckIssuance` refuses
   * the resulting run on its digest binding, so this was never a wrong write;
   * it was a wrong CAP and a cryptic refusal, which on this rail is quite bad
   * enough.
   */
  let generation = 0;

  const cap = $derived(manifest?.body.totalSupply ?? pod?.supply ?? 0);
  const remaining = $derived(Math.max(0, cap - existing.length));

  const pasted = $derived(parseHolderKeys(pasteText));
  const attendeeSplit = $derived(
    splitAttendees({ claims: claims ?? [], bindings: attendees ?? [] }),
  );

  /** The holders this run would certify, before the log is consulted. */
  const requested = $derived(source === "paste" ? pasted.keys : attendeeSplit.certifiable);
  const rejects = $derived<HolderReject[]>(source === "paste" ? pasted.rejects : []);

  /** Requested holders the log already carries — skipped, not re-signed. */
  const alreadyHeld = $derived.by(() => {
    const have = new Set(existing);
    return requested.filter((h) => have.has(h));
  });
  const toIssue = $derived.by(() => {
    const have = new Set(existing);
    return requested.filter((h) => !have.has(h));
  });
  const overCap = $derived(existing.length + toIssue.length > cap);

  const canRun = $derived(toIssue.length > 0 && !overCap && phase === "compose");

  $effect(() => {
    if (pod) void open(pod);
  });

  async function open(p: PodDirectoryEntry) {
    const mine = ++generation;
    const stale = () => mine !== generation;
    phase = "loading";
    blockedReason = "";
    manifest = null;
    existing = [];
    result = null;
    progress = { done: 0, total: 0 };
    probeSummary = "";
    head = null;
    pagesRead = 0;

    // A badge minted without these cannot be awarded from here at all, and
    // saying so is better than a surface that half-works.
    if (!p.certLogOwner || !p.swarmManifestRef) {
      blockedReason = !p.certLogOwner
        ? "This badge has no certificate log recorded, so awards could never be found."
        : "This badge has no stored manifest, so its issuer cannot be confirmed.";
      phase = "blocked";
      return;
    }

    const m = await loadBadgeManifest(p.swarmManifestRef, p.manifestRef);
    if (stale()) return;
    if (!m.ok) {
      blockedReason = m.error;
      phase = "blocked";
      return;
    }
    manifest = m.manifest;

    // THOROUGH read — it decides who is skipped as already certified, so a
    // false absent re-issues duplicates against a permanent log.
    const log = await readCertLog(p.certLogOwner, p.manifestRef, m.manifest);
    if (stale()) return;
    if (!log.ok) {
      blockedReason = log.error;
      phase = "blocked";
      return;
    }
    existing = log.holders;
    head = log.head;
    pagesRead = log.pagesRead;
    phase = "compose";
  }

  async function loadEvents() {
    if (events.length > 0 || !auth.parent) return;
    try {
      const list = await getEventsByCreator(auth.parent.toLowerCase());
      events = list.map((e) => ({ eventId: e.eventId, title: e.title }));
    } catch {
      attendeeError = "Could not load your events.";
    }
  }

  async function loadAttendees() {
    if (!selectedEventId) return;
    attendeesLoading = true;
    attendeeError = "";
    attendees = null;
    claims = null;
    try {
      // BOTH, and neither is optional. `/orders` is every ticket claim — the
      // denominator the organiser is really asking about. `/attendee-keys` is
      // the sparse set of those claims the platform has a badge key for. Using
      // only the second would make an event with 100 tickets and 10 bindings
      // read as "6 of 10 attendees", at the moment a permanent run is confirmed.
      const [orders, keys] = await Promise.all([
        getEventOrders(selectedEventId),
        getAttendeeKeys(selectedEventId),
      ]);
      claims = orders.orders.map((o) => ({ seriesId: o.seriesId, edition: o.edition }));
      attendees = keys;
    } catch (e) {
      attendeeError = e instanceof Error ? e.message : "Could not load attendees.";
      claims = null;
      attendees = null;
    } finally {
      attendeesLoading = false;
    }
  }

  async function run() {
    if (!pod || !manifest || !canRun) return;
    phase = "running";
    progress = { done: 0, total: toIssue.length };

    const before = { probes: probeCounts(), hints: hintCounts() };

    // EVERYTHING that can throw lives inside this try, and the key ceremonies
    // are the reason. `getContentFeedSigner` is documented FAIL-LOUD — it
    // throws rather than falling through, and the likeliest trigger is the most
    // ordinary user action there is: rejecting the wallet signing prompt on a
    // first award. Left outside, that throw escapes `run()` with `phase` stuck
    // at "running", and because `close()` refuses mid-run the organiser is
    // trapped in a dialog with a disabled X and a refused Escape, with only a
    // reload to get out. Nothing has been written at that point, which is
    // exactly why it must NOT be reported as `unconfirmed`: `refused` is the
    // honest stop, and re-running is safe.
    try {
      const keypair = await auth.getPodKeypair();
      const signer = await auth.getContentFeedSigner();
      if (!keypair || !signer) {
        result = {
          ok: false,
          landed: [],
          alreadyHeld: [],
          pagesWritten: 0,
          stop: "refused",
          error: "Could not unlock your signing keys.",
        };
        phase = "stopped";
        return;
      }

      result = await issueCertificates({
        badge: pod.manifestRef,
        manifest,
        // From the DIRECTORY, so a device writing under a different signer is
        // refused rather than starting a parallel log nobody reads.
        expectedLogOwner: pod.certLogOwner as Hex0x,
        keys: {
          podPrivKey: keypair.privateKey,
          feedPrivKey: signer.privKey,
          feedAddress: signer.address,
        },
        holders: toIssue,
        onProgress: (done, total) => { progress = { done, total }; },
      });
    } catch (e) {
      // `issueCertificates` maps a throwing WRITE to its own stop, so anything
      // arriving here threw before or around the run — a rejected signature,
      // most likely. Nothing was sent, so `refused` rather than `unconfirmed`:
      // it tells the operator to try again rather than to go and re-read a log
      // that cannot have changed.
      result = {
        ok: false,
        landed: [],
        alreadyHeld: [],
        pagesWritten: 0,
        stop: "refused",
        error: e instanceof Error ? e.message : "The run could not be started.",
      };
    }

    // The supervised sequence watches these, so they are shown rather than
    // logged: `hintInvalidated` climbing is the whitelist-lag alarm.
    const p = probeCounts();
    const h = hintCounts();
    const totals = probeTotals({
      gatewayHit: p.gatewayHit - before.probes.gatewayHit,
      gatewayMiss: p.gatewayMiss - before.probes.gatewayMiss,
      serverHit: p.serverHit - before.probes.serverHit,
      serverMiss: p.serverMiss - before.probes.serverMiss,
    });
    probeSummary = `${totals.probes} probes (${totals.misses} miss) · hints ${h.hintInvalidated - before.hints.hintInvalidated} invalidated`;

    // Anything that landed is REAL, even on a stopped run.
    if (result.landed.length > 0) {
      existing = [...existing, ...result.landed];
      void syncIssuedCount();
    }
    phase = result.ok ? "done" : "stopped";
  }

  /**
   * Best-effort counter update. Never allowed to fail a run: the certificates
   * have already landed, and the recomputable truth is the log itself.
   */
  async function syncIssuedCount() {
    if (!pod) return;
    try {
      const updated = await updatePod(pod.manifestRef, { issuedCount: existing.length });
      onissued(updated);
    } catch {
      /* display layer — the log is the truth */
    }
  }

  function close() {
    if (phase === "running") return; // a run in flight owns this dialog
    onclose();
  }
  function onScrimKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  const short = (k: string) => `${k.slice(0, 10)}…${k.slice(-6)}`;
</script>

{#if pod}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" role="button" aria-label="Close" tabindex="-1" onclick={close} onkeydown={onScrimKey}></div>

  <div class="modal" role="dialog" aria-modal="true" aria-label="Award badge">
    <header class="modal-head">
      <div class="head-meta">
        <span class="kicker">Award</span>
        <h2>{pod.name}</h2>
      </div>
      <button class="close-btn" onclick={close} disabled={phase === "running"} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13" /></svg>
      </button>
    </header>

    <div class="scroll">
      {#if phase === "loading"}
        <p class="msg">Reading this badge's award log…</p>

      {:else if phase === "blocked"}
        <div class="panel panel--stop">
          <span class="panel-head">Can't award this badge</span>
          <p>{blockedReason}</p>
        </div>

      {:else if phase === "running"}
        <div class="panel">
          <span class="panel-head">Awarding — don't close this window</span>
          <p class="mono">{progress.done} of {progress.total} awarded</p>
          <div class="bar"><div class="bar-fill" style="width:{progress.total ? (progress.done / progress.total) * 100 : 0}%"></div></div>
          <p class="fine">
            Each award is signed here and published under your account. A page
            that lands is permanent; if this stops partway, everything already
            awarded stays awarded and you can pick up where it left off.
          </p>
        </div>

      {:else if phase === "done" && result}
        <div class="panel panel--ok">
          <span class="panel-head">Done</span>
          <dl class="nums">
            <div><dt>Awarded now</dt><dd class="mono">{result.landed.length}</dd></div>
            <div><dt>Already held</dt><dd class="mono">{result.alreadyHeld.length}</dd></div>
            <div><dt>Pages written</dt><dd class="mono">{result.pagesWritten}</dd></div>
            <div><dt>Holders in total</dt><dd class="mono">{existing.length} / {cap}</dd></div>
          </dl>
          {#if probeSummary}<p class="fine mono">{probeSummary}</p>{/if}
        </div>

      {:else if phase === "stopped" && result}
        <div class="panel panel--stop">
          <span class="panel-head">
            {result.stop === "superseded" ? "Stopped — needs a look before anything else" : "Stopped"}
          </span>
          <p>{result.error}</p>

          {#if result.stop === "superseded"}
            <!-- DELIBERATELY NO RETRY. Two causes, and this surface cannot tell
                 them apart; one of them makes re-running worse, permanently. -->
            <p class="fine">
              This means one of two things. Either another device is awarding
              this badge at the same time — in which case nothing is wrong and
              you can reopen this window later to continue — or an award was
              aimed at a place in the log that was already taken, which needs
              investigating before anything else is written. There is no way to
              tell from here, so this window will not offer to try again.
            </p>
          {:else if result.stop === "unconfirmed"}
            <p class="fine">
              This award may or may not have reached storage — from here the two
              look identical, which is why nothing is written again on a guess.
              Reopen this window to re-read the log: if the award is there it
              landed and you can carry on, and if it isn't, nothing was lost.
            </p>
          {/if}

          <dl class="nums">
            <div><dt>Awarded before stopping</dt><dd class="mono">{result.landed.length}</dd></div>
            <div><dt>Pages written</dt><dd class="mono">{result.pagesWritten}</dd></div>
            {#if result.stoppedAt}
              <div><dt>Stopped at</dt><dd class="mono">band {result.stoppedAt.band}, version {result.stoppedAt.version}</dd></div>
            {/if}
          </dl>
          {#if probeSummary}<p class="fine mono">{probeSummary}</p>{/if}
          <p class="fine">Everything counted above is real and permanent.</p>
        </div>

      {:else}
        <!-- ── compose ─────────────────────────────────────────────────── -->
        <dl class="nums nums--top">
          <div><dt>Already awarded</dt><dd class="mono">{existing.length}</dd></div>
          <div><dt>Cap</dt><dd class="mono">{cap}</dd></div>
          <div><dt>Room left</dt><dd class="mono">{remaining}</dd></div>
          {#if head}
            <!-- Shown for the supervised sequence: a band rollover is otherwise
                 only inferable from a count that keeps going up. -->
            <div><dt>Log head</dt><dd class="mono">b{head.band} v{head.version}</dd></div>
            <div><dt>Pages read</dt><dd class="mono">{pagesRead}</dd></div>
          {/if}
        </dl>

        <div class="src-row" role="group" aria-label="Where holders come from">
          <button type="button" class="src-btn" class:active={source === "paste"} onclick={() => (source = "paste")}>Paste keys</button>
          <button type="button" class="src-btn" class:active={source === "event"} onclick={() => { source = "event"; void loadEvents(); }}>From an event</button>
        </div>

        {#if source === "paste"}
          <label class="field-label" for="cert-holders">Badge keys, one per line</label>
          <textarea
            id="cert-holders"
            class="field-textarea mono"
            bind:value={pasteText}
            rows={7}
            placeholder="a1b2c3…  (64 hex characters per line)"
          ></textarea>
        {:else}
          <label class="field-label" for="cert-event">Event</label>
          <select id="cert-event" class="field-select" bind:value={selectedEventId} onchange={loadAttendees}>
            <option value="">— Choose an event —</option>
            {#each events as e (e.eventId)}<option value={e.eventId}>{e.title}</option>{/each}
          </select>

          {#if attendeesLoading}
            <p class="msg">Loading attendees…</p>
          {:else if attendeeError}
            <p class="msg msg--err">{attendeeError}</p>
          {:else if attendees && claims}
            <p class="fine">
              <strong>{attendeeSplit.certifiable.length}</strong> of
              {attendeeSplit.totalClaims}
              ticket{attendeeSplit.totalClaims === 1 ? "" : "s"} sold can receive this badge.
              {#if attendeeSplit.duplicateEditions > 0}
                ({attendeeSplit.duplicateEditions} extra ticket{attendeeSplit.duplicateEditions === 1 ? "" : "s"}
                belonged to someone already counted.)
              {/if}
            </p>
            {#if attendeeSplit.withoutKey.length > 0}
              <!-- SHOWN, not dropped. There is no path today that turns one of
                   these into a certifiable attendee, so the copy must not
                   suggest one: the gate binding's one-shot nullifier is already
                   spent and nothing backfills a key onto it. -->
              <div class="keyless">
                <span class="keyless-head">
                  Can't be awarded — {attendeeSplit.withoutKey.length} of {attendeeSplit.totalClaims}
                </span>
                <p class="fine">
                  An award has to name a person's badge key, and these tickets
                  have none. Most often that's simply a ticket that was never
                  linked to a WoCo account — buying with a card alone doesn't
                  create one. There is no way to award these from here today.
                </p>
                <div class="keyless-list">
                  {#each attendeeSplit.withoutKey.slice(0, 12) as a (a.seriesId + "-" + a.edition)}
                    <span class="keyless-row mono" title={uncertifiableLabel(a.reason)}>
                      #{a.edition} · {a.reason === "not-linked" ? "no account" : "no badge id"}
                    </span>
                  {/each}
                  {#if attendeeSplit.withoutKey.length > 12}
                    <span class="keyless-row mono">+{attendeeSplit.withoutKey.length - 12} more</span>
                  {/if}
                </div>
              </div>
            {/if}
            <p class="fine caveat">
              Badge keys collected at checkout are supplied by the attendee's own
              device and aren't independently verified. Awards are permanent, so
              check the list is who you mean.
            </p>
          {/if}
        {/if}

        {#if rejects.length > 0}
          <div class="rejects">
            <span class="rejects-head">{rejects.length} line{rejects.length === 1 ? "" : "s"} not used</span>
            {#each rejects.slice(0, 8) as r (r.line)}
              <div class="reject-row">
                <span class="mono">line {r.line}</span>
                <span class="reject-text mono">{r.text}</span>
                <span class="reject-why">{holderRejectLabel(r.reason)}</span>
              </div>
            {/each}
            {#if rejects.length > 8}<span class="fine">+{rejects.length - 8} more</span>{/if}
          </div>
        {/if}

        {#if requested.length > 0}
          <dl class="nums">
            <div><dt>Will be awarded</dt><dd class="mono">{toIssue.length}</dd></div>
            <div><dt>Already hold it</dt><dd class="mono">{alreadyHeld.length}</dd></div>
          </dl>
          {#if alreadyHeld.length > 0}
            <p class="fine">Anyone who already holds this badge is skipped, not awarded twice.</p>
          {/if}
        {/if}

        {#if overCap}
          <p class="msg msg--err">
            That would take this badge to {existing.length + toIssue.length} holders,
            past its cap of {cap}. Remove {existing.length + toIssue.length - cap}.
          </p>
        {/if}
      {/if}
    </div>

    <footer class="modal-foot">
      {#if phase === "compose"}
        <button class="btn btn--ghost" onclick={close}>Cancel</button>
        <button class="btn btn--primary" onclick={run} disabled={!canRun}>
          Award to {toIssue.length}
        </button>
      {:else if phase === "running"}
        <span class="fine">Working…</span>
      {:else}
        <button class="btn btn--ghost" onclick={close}>Close</button>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: none;
    /* ABOVE PodEditDrawer (200/201), which is where this opens from. At the
       modal default of 90 it rendered behind the drawer that launched it —
       invisible, while still capturing the run. */
    z-index: 210;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 32px));
    max-height: min(86vh, 760px);
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    z-index: 211;
  }
  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border);
  }
  .head-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  h2 {
    font-family: var(--font-display);
    font-size: 1.1rem;
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .close-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .close-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .scroll { padding: 14px 18px; overflow-y: auto; flex: 1; }
  .modal-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--border);
  }

  .mono { font-family: var(--font-mono); }
  .msg { font-size: 0.88rem; color: var(--text-secondary); margin: 8px 0; }
  .msg--err { color: var(--error); }
  .fine { font-size: 0.78rem; line-height: 1.5; color: var(--text-muted); margin: 6px 0 0; }
  .caveat { border-left: 2px solid var(--border-hover); padding-left: 9px; margin-top: 10px; }

  .field-label {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 12px 0 5px;
  }
  .field-textarea, .field-select {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.84rem;
    padding: 8px 10px;
    resize: vertical;
  }
  .field-textarea:focus, .field-select:focus { outline: none; border-color: var(--accent); }

  .src-row { display: flex; gap: 6px; margin-top: 4px; }
  .src-btn {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .src-btn.active { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

  .nums {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin: 12px 0 0;
  }
  .nums--top { margin: 0 0 4px; }
  .nums div { display: flex; flex-direction: column; gap: 2px; }
  .nums dt {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .nums dd { margin: 0; font-size: 0.95rem; color: var(--text); }

  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    background: var(--bg-surface);
  }
  .panel--ok { border-left: 2px solid var(--accent); }
  .panel--stop { border-left: 2px solid var(--error); }
  .panel-head {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .panel p { font-size: 0.86rem; line-height: 1.5; color: var(--text-secondary); margin: 0; }

  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
    margin: 8px 0 2px;
  }
  .bar-fill { height: 100%; background: var(--accent); transition: width 0.25s ease; }

  .rejects, .keyless {
    margin-top: 12px;
    padding: 9px 11px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .rejects-head, .keyless-head {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 5px;
  }
  .reject-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.74rem;
    color: var(--text-secondary);
  }
  .reject-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reject-why { color: var(--error); font-size: 0.7rem; white-space: nowrap; }
  .keyless-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .keyless-row {
    font-size: 0.7rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.86rem;
    padding: 8px 14px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    cursor: pointer;
  }
  .btn--primary { background: var(--accent); color: var(--accent-ink); }
  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--ghost { background: transparent; color: var(--text); border-color: var(--border-hover); }
</style>
