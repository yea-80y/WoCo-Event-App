<script lang="ts">
  /**
   * The dashboard's Seats tab (docs/SEATING.md S6): the room as it is now - sold, held,
   * being bought, emptied by a change, free - and what the organiser can do to it.
   * Holds and "put back on sale" save to the organiser's own seat state
   * (`seat-state.ts`, coalesced by `seat-state-saver.ts`); "Change seat" hands the
   * ticket to `onchangeseat`. Everything is read from Swarm and the chain in the
   * browser; our server only adds the live holds list the map already reads.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import type { EventFeed, SeriesSummary } from "@woco/shared";
  import type { SeatHoldKind, SeatState } from "@woco/shared/seating/state";
  import type { LiveSeatMap, SeatMapSnapshot } from "@woco/seatmap/load";
  import type { Picker } from "@woco/seatmap/picker";
  import {
    HOLD_KIND_NAMES, HOLD_KIND_SEAT, holdDelta, orgActions, orgAddAll, orgMark, orgSeat, orgSelectable, orgSummary, orgToggle,
    putBackDelta, releaseDelta, withDelta, type OrgFilter, type OrgInputs,
  } from "./organiser-seats.js";
  import { SeatStateSaver } from "./seat-state-saver.js";
  import type { SeatMove } from "./organiser-seat-data.js";
  import { SEAT_HOLD_KINDS } from "@woco/shared/seating/state";

  interface Props {
    event: EventFeed;
    apiUrl: string;
    /** "Change seat" on a sold seat: the ticket (slot) and the seat it sits in. */
    onchangeseat?: (a: { seriesId: string; slot: number; seat: number }) => void;
  }
  let { event, apiUrl, onchangeseat }: Props = $props();

  type Ready = SeriesSummary & Required<Pick<SeriesSummary, "seating" | "onChainEventId" | "swarmManifestRef">>;
  const seated = $derived(event.series.filter((s): s is Ready => !!s.seating && !!s.onChainEventId && !!s.swarmManifestRef));
  let seriesId = $state<string | null>(null);
  const series = $derived(seated.find((s) => s.seriesId === seriesId) ?? seated[0] ?? null);

  let loading = $state(true);
  let problem = $state<string | null>(null);
  let map = $state.raw<LiveSeatMap | null>(null);
  let snap = $state.raw<SeatMapSnapshot | null>(null);
  let own = $state.raw<SeatState | null>(null);
  let planHolds = $state.raw<Map<number, SeatHoldKind>>(new Map());
  let slotOf = $state.raw<Map<number, number>>(new Map());
  let emptied = $state.raw<Map<number, number>>(new Map());
  let movesComplete = $state(true);
  let picks = $state<number[]>([]);
  let lastTap = $state<number | null>(null);
  let filter = $state<OrgFilter>(null);
  let kind = $state<SeatHoldKind>("house");
  let saverTick = $state(0);
  let saver: SeatStateSaver | null = null;
  let mapEl = $state<HTMLDivElement | null>(null);
  let picker: Picker | null = null;
  let unsubscribe: (() => void) | null = null;
  let destroyed = false;

  const plan = $derived(map?.plan.plan ?? null);
  const closed = $derived.by(() => {
    const c = snap?.chain;
    return !!event.cancelledAt || !!c?.cancelled || (!!c && c.eventEndTs <= c.blockTs);
  });

  /** The organiser's holds and emptied seats, with what is not saved yet applied. */
  const shown = $derived.by(() => {
    void saverTick;
    const base = own ? holdsOf(own) : planHolds;
    return withDelta(base, emptied, saver?.unsaved() ?? {});
  });

  const inputs = $derived.by((): OrgInputs => {
    const words = snap?.chain?.words ?? null;
    return {
      taken: (k) => {
        const w = words?.[k >> 8];
        return w === null || w === undefined ? null : ((w >> BigInt(k & 255)) & 1n) === 1n;
      },
      holds: shown.holds,
      onHold: new Set(snap?.onHold ?? []),
      emptied: shown.emptied,
      slotOf,
    };
  });
  const summary = $derived(map ? orgSummary(map.plan.seats, inputs) : null);
  const actions = $derived(orgActions(picks, inputs));

  function holdsOf(s: SeatState): Map<number, SeatHoldKind> {
    const m = new Map<number, SeatHoldKind>();
    for (const h of s.holds) {
      for (let i = 0; i < h.held.length / 2; i++) {
        const byte = parseInt(h.held.slice(i * 2, i * 2 + 2), 16);
        for (let b = 0; b < 8; b++) if (byte & (1 << b)) m.set(i * 8 + b, h.kind);
      }
    }
    return m;
  }

  function label(k: number): string {
    if (!plan) return `Seat ${k + 1}`;
    const l = seatLabelOf(k);
    return l ?? `Seat ${k + 1}`;
  }
  let seatLabelOf: (k: number) => string | null = () => null;

  async function load(): Promise<void> {
    if (!series) return;
    loading = true;
    problem = null;
    picks = [];
    filter = null;
    picker?.destroy();
    picker = null;
    unsubscribe?.();
    map?.stop();
    const s = series;
    try {
      const [
        { seatMapRpcUrl },
        { loadSeatMap },
        { ticketLedger2Address },
        { KERNEL_CHAIN_ID },
        { WOCO_GATEWAY_URL },
        { auth },
        seatState,
        data,
        { seatStateView, PLAN_HOLD_KIND },
        { initialHeldSeats, seatLabel, formatSeatLabel },
        { ownLedger2Deployment },
      ] = await Promise.all([
        import("../../seating/seat-map-source.js"),
        import("@woco/seatmap/load"),
        import("@woco/shared/ticket/ledger2"),
        import("@woco/shared/kernel/chain"),
        import("../../swarm/gateways.js"),
        import("../../auth/auth-store.svelte.js"),
        import("./seat-state.js"),
        import("./organiser-seat-data.js"),
        import("@woco/shared/seating/state"),
        import("@woco/shared/seating/plan"),
        import("../../keyring/organiser-event-scan.js"),
      ]);
      const ledger = ticketLedger2Address(KERNEL_CHAIN_ID);
      const rpcUrl = seatMapRpcUrl();
      if (!ledger || !rpcUrl) throw new Error("Seats can't be shown on this network.");
      const signer = await auth.getContentFeedSignerAddress();
      if (!signer) throw new Error("Sign in again to see your seats.");
      const io = await seatState.liveSeatStateIO();

      let stored: SeatState | null = null;
      const r = await loadSeatMap(
        { eventId: event.eventId, seriesId: s.seriesId, onChainEventId: s.onChainEventId, swarmManifestRef: s.swarmManifestRef, seating: s.seating },
        {
          fetch: (input, init) => fetch(input, init), gatewayUrl: WOCO_GATEWAY_URL, rpcUrl, apiUrl, ledger,
          organiserState: async (bp) => {
            const raw = await seatState.readStoredSeatState(io, signer, event, s.seriesId);
            const v = raw ? await seatState.ownSeatState(raw.value, event.eventId, s.seriesId) : null;
            if (raw && (!v || v.planDigest !== bp.digest || v.seats !== bp.seats)) {
              throw new seatState.SeatStateUnreadableError("Your seat holds for this ticket type are saved for a different seating plan.");
            }
            stored = v;
            return seatStateView(bp.plan, bp.digest, v);
          },
        },
      );
      if (destroyed) return;
      if (!r.ok) throw new Error(r.problem === "publishing" ? "Your seating plan is still being stored. Try again in a few minutes." : "Your seating plan couldn't be loaded just now.");
      const bp = r.map.plan;
      own = stored;
      planHolds = new Map([...initialHeldSeats(bp.plan)].map((k) => [k, PLAN_HOLD_KIND]));
      seatLabelOf = (k) => {
        const l = seatLabel(bp.plan, k);
        return l ? formatSeatLabel(l) : null;
      };
      saver = new SeatStateSaver(
        {
          save: async (d) => seatState.writeSeatState(await seatState.liveSeatStateWriter(), event, s.seriesId, { digest: bp.digest, seats: bp.seats, planHolds }, d),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        },
        () => (saverTick += 1),
        (state) => (own = state),
      );
      map = r.map;
      snap = r.map.snapshot();
      unsubscribe = r.map.subscribe((x) => (snap = x));
      r.map.start();
      void r.map.refresh(true);
      loading = false;
      await tick();
      mountPicker();
      void readTickets(data, ledger, s.onChainEventId, await ownLedger2Deployment());
    } catch (e) {
      if (destroyed) return;
      loading = false;
      problem = e instanceof Error && e.message ? e.message : "Your seats couldn't be loaded just now.";
    }
  }

  async function readTickets(
    data: typeof import("./organiser-seat-data.js"),
    ledger: string,
    onChainEventId: string,
    deployment: { deployBlock: number } | null,
  ): Promise<void> {
    const call = await data.liveMulticall();
    if (!call) return;
    const { seatBatch } = await import("@woco/shared/seating/chain");
    const b = seatBatch(ledger, onChainEventId, { event: true, words: [], nonceSeats: [] });
    const ev = b.decode(await call(b.calls, b.expect).catch(() => [])).event;
    if (ev) {
      const t = await data.readTicketSeats(call, ledger, onChainEventId, Number(ev.nextSlot));
      if (!destroyed) slotOf = data.slotsBySeat(t.seats);
    }
    if (!deployment) return;
    const scan = await data.scanSeatMoves(await data.liveMoveLogIO(ledger, onChainEventId), deployment.deployBlock).catch(() => ({ moves: [] as SeatMove[], complete: false }));
    const confirmed = new Map(own?.confirmed ?? []);
    const e = await data.readEmptiedSeats(call, ledger, onChainEventId, scan.moves, confirmed);
    if (destroyed) return;
    movesComplete = scan.complete && e !== null;
    if (e) emptied = e;
  }

  async function mountPicker(): Promise<void> {
    if (!mapEl || !map || picker) return;
    const [{ createPicker, pickerCss }, { paletteFromCss }] = await Promise.all([
      import("@woco/seatmap/picker"),
      import("@woco/seatmap/palette"),
    ]);
    if (!mapEl || !map || picker) return;
    const p = paletteFromCss(document.documentElement);
    const style = document.createElement("style");
    style.textContent = pickerCss(p);
    mapEl.appendChild(style);
    picker = createPicker(mapEl, {
      plan: map.plan,
      palette: p,
      id: `org-seats-${map.plan.digest.slice(2, 10)}`,
      label: `Seats for ${event.title}. Enter to go to the seats; the arrow keys move between them.`,
      onSeat: tap,
      onView: (sections) => map?.watch({ sections, picks }),
    });
    push();
  }

  function push(): void {
    if (!picker || !map) return;
    const x = inputs;
    const f = filter;
    const locked = closed;
    picker.set({
      picks,
      locked,
      free: (k) => orgSeat(k, x).status === "free" && orgMark(orgSeat(k, x), f) !== "dim",
      canPick: (k) => orgSelectable(orgSeat(k, x)),
      label: (k) => label(k),
      reason: (k) => {
        const st = orgSeat(k, x);
        if (st.status === "held") return HOLD_KIND_NAMES[st.kind].toLowerCase();
        if (st.status === "sold") return st.held ? `sold, ${HOLD_KIND_NAMES[st.held].toLowerCase()}` : "sold";
        if (st.status === "basket") return "being bought";
        if (st.status === "offsale") return "off sale after a change";
        return null;
      },
      sectionLine: () => "",
      sectionEmpty: () => false,
      mark: (k) => orgMark(orgSeat(k, x), f),
    });
  }

  $effect(() => {
    void inputs; void picks; void filter; void closed;
    push();
  });

  function tap(k: number): void {
    picks = orgToggle(picks, k, inputs);
    lastTap = picks.includes(k) ? k : null;
  }

  function selectRow(): void {
    if (lastTap === null || !map) return;
    const ref = map.plan.refs[lastTap];
    const row = ref ? map.plan.runsOf[ref.item]?.[ref.row] ?? [] : [];
    picks = orgAddAll(picks, row.filter((k) => k >= 0), inputs);
  }

  function selectSection(): void {
    if (lastTap === null || !map) return;
    const ref = map.plan.refs[lastTap];
    const sec = ref ? map.plan.sections[map.plan.sectionOf[ref.item]] : null;
    if (!sec) return;
    picks = orgAddAll(picks, Array.from({ length: sec.count }, (_, i) => sec.first + i), inputs);
  }

  function hold(): void {
    saver?.add(holdDelta(actions.hold, kind));
    picks = [];
  }
  function release(): void {
    saver?.add(releaseDelta(actions.release));
    picks = [];
  }
  function putBack(seats: readonly number[]): void {
    saver?.add(putBackDelta(seats, { emptied: shown.emptied }));
    picks = picks.filter((k) => !seats.includes(k));
  }

  const status = $derived.by(() => {
    void saverTick;
    return saver?.status ?? { phase: "idle" as const };
  });

  const toggleFilter = (f: OrgFilter) => {
    filter = JSON.stringify(filter) === JSON.stringify(f) ? null : f;
  };

  const emptiedList = $derived([...shown.emptied.keys()].sort((a, b) => a - b));
  const seatWord = (n: number) => (n === 1 ? "seat" : "seats");

  // Load when the ticket type changes - and only then: `load` reads and writes state
  // (the map, picks) that must not re-run it.
  $effect(() => {
    void series?.seriesId;
    untrack(() => void load());
  });

  onDestroy(() => {
    destroyed = true;
    void saver?.flush();
    unsubscribe?.();
    map?.stop();
    picker?.destroy();
  });
</script>

<section class="seats">
  {#if seated.length > 1}
    <div class="switch" role="group" aria-label="Seated ticket type">
      {#each seated as s (s.seriesId)}
        <button type="button" class:on={s.seriesId === series?.seriesId} onclick={() => (seriesId = s.seriesId)}>{s.name}</button>
      {/each}
    </div>
  {/if}

  {#if problem}
    <div class="notice">
      <p>{problem}</p>
      <button type="button" class="btn btn--ghost" onclick={() => load()}>Try again</button>
    </div>
  {:else if loading}
    <p class="quiet">Loading your seating plan…</p>
  {:else if summary}
    {#if closed}
      <p class="notice">
        {event.cancelledAt || snap?.chain?.cancelled ? "This event has been cancelled." : "Ticket sales have ended, so seats can't be changed."}
        Seats can be held, released and moved while tickets are on sale - extending sales from Edit opens them again.
      </p>
    {/if}
    <p class="summary">
      <button type="button" class="count" class:on={filter === "sold"} onclick={() => toggleFilter("sold")}><span class="key sold"></span>{summary.sold} sold</button>
      {#each SEAT_HOLD_KINDS.filter((k) => summary.held.get(k)) as k (k)}
        <button type="button" class="count" class:on={typeof filter === "object" && filter?.held === k} onclick={() => toggleFilter({ held: k })}><span class="key held"></span>{summary.held.get(k)} {HOLD_KIND_NAMES[k].toLowerCase()}</button>
      {/each}
      {#if summary.basket}
        <button type="button" class="count" class:on={filter === "basket"} onclick={() => toggleFilter("basket")}><span class="key basket"></span>{summary.basket} being bought</button>
      {/if}
      {#if summary.offsale}
        <button type="button" class="count" class:on={filter === "offsale"} onclick={() => toggleFilter("offsale")}><span class="key offsale"></span>{summary.offsale} off sale after a change</button>
      {/if}
      <button type="button" class="count" class:on={filter === "free"} onclick={() => toggleFilter("free")}><span class="key free"></span>{summary.free} free</button>
    </p>

    <div class="room">
      <div class="map" bind:this={mapEl}></div>

      <aside class="panel">
        <div class="selection" class:active={picks.length > 0}>
          {#if actions.ticket}
            {@const st = orgSeat(actions.ticket.seat, inputs)}
            <h3>Ticket #{actions.ticket.slot + 1}</h3>
            <p class="seat-name">{label(actions.ticket.seat)}</p>
            {#if st.status === "sold" && st.held}
              <p class="quiet">This is {HOLD_KIND_SEAT[st.held]}: it stays held after this ticket moves on.</p>
            {/if}
            <div class="row-actions">
              <button type="button" class="btn btn--primary" disabled={closed || !onchangeseat}
                onclick={() => onchangeseat?.({ seriesId: series!.seriesId, slot: actions.ticket!.slot, seat: actions.ticket!.seat })}>Change seat</button>
              <button type="button" class="btn btn--ghost" onclick={() => (picks = [])}>Done</button>
            </div>
          {:else if picks.length > 0}
            <h3>{picks.length} {seatWord(picks.length)}</h3>
            <p class="codes">{picks.slice(0, 6).map(label).join("; ")}{picks.length > 6 ? `; and ${picks.length - 6} more` : ""}</p>
            <div class="row-actions">
              <button type="button" class="btn btn--ghost small" onclick={selectRow} disabled={lastTap === null}>Select row</button>
              <button type="button" class="btn btn--ghost small" onclick={selectSection} disabled={lastTap === null}>Select section</button>
              <button type="button" class="btn btn--ghost small" onclick={() => (picks = [])}>Clear</button>
            </div>
            {#if actions.hold.length}
              <div class="hold">
                <label for="hold-kind">Hold as</label>
                <select id="hold-kind" bind:value={kind} disabled={closed}>
                  {#each SEAT_HOLD_KINDS as k (k)}<option value={k}>{HOLD_KIND_NAMES[k]}</option>{/each}
                </select>
                <button type="button" class="btn btn--primary" onclick={hold} disabled={closed}>Hold {actions.hold.length}</button>
              </div>
            {/if}
            {#if actions.release.length}
              <button type="button" class="btn btn--ghost wide" onclick={release} disabled={closed}>Release {actions.release.length} to sale</button>
            {/if}
            {#if actions.putBack.length}
              <button type="button" class="btn btn--ghost wide" onclick={() => putBack(actions.putBack)} disabled={closed}>Put {actions.putBack.length} back on sale</button>
            {/if}
          {:else}
            <p class="quiet">Tap seats to hold or release them. Tap a sold seat to move its ticket.</p>
          {/if}

          {#if status.phase === "waiting" || status.phase === "saving"}
            <p class="save" role="status">Saving…</p>
          {:else if status.phase === "saved"}
            <p class="save" role="status">{status.settled ? "Saved" : "Saved - buyers see it within a minute"}</p>
          {:else if status.phase === "failed"}
            <div class="save failed" role="alert">
              <p><strong>Not saved.</strong> {status.message} Your changes stay on the map until they save.</p>
              <button type="button" class="btn btn--ghost small" onclick={() => saver?.flush()}>Try again</button>
            </div>
          {/if}
        </div>

        {#if emptiedList.length || !movesComplete}
          <div class="emptied">
            <h3>Seats emptied by a change</h3>
            {#if !movesComplete}
              <p class="quiet">Some changes couldn't be read just now, so this list may be missing seats. <button type="button" class="link" onclick={() => load()}>Check again</button></p>
            {/if}
            {#if emptiedList.length}
              <p class="quiet">They stay off sale until you put them back.</p>
              <ul>
                {#each emptiedList as k (k)}
                  <li><span>{label(k)}</span><button type="button" class="btn btn--ghost small" disabled={closed} onclick={() => putBack([k])}>Put back on sale</button></li>
                {/each}
              </ul>
              {#if emptiedList.length > 1}
                <button type="button" class="btn btn--ghost wide" disabled={closed} onclick={() => putBack(emptiedList)}>Put all {emptiedList.length} back on sale</button>
              {/if}
            {/if}
          </div>
        {/if}
      </aside>
    </div>
  {/if}
</section>

<style>
  .seats { display: flex; flex-direction: column; gap: 1rem; }
  .switch { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .switch button, .count {
    font: inherit; color: var(--text-secondary); background: none; border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 0.35rem 0.7rem; cursor: pointer;
  }
  .switch button.on, .count.on { color: var(--text); border-color: var(--text-secondary); background: var(--bg-elevated); }
  .switch button:focus-visible, .count:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
  .summary { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; }
  .count { display: inline-flex; align-items: center; gap: 0.45rem; font-variant-numeric: tabular-nums; }
  .key { width: 0.8rem; height: 0.8rem; border-radius: 2px; flex: none; }
  .key.sold { background: var(--border-hover); }
  .key.held { background: repeating-linear-gradient(-45deg, var(--text-dim) 0 2px, var(--bg-elevated) 2px 4px); outline: 1px solid var(--text-secondary); outline-offset: -1px; }
  .key.basket { border: 1px dashed var(--text); }
  .key.offsale { border: 1px solid var(--text-secondary); background: linear-gradient(135deg, transparent 45%, var(--text-secondary) 45% 55%, transparent 55%); }
  .key.free { background: var(--text); }
  .room { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 1rem; align-items: start; }
  .map { position: relative; height: min(70vh, 640px); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--bg-surface); }
  .panel { display: flex; flex-direction: column; gap: 1rem; }
  .selection, .emptied { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1rem; background: var(--bg-surface); display: flex; flex-direction: column; gap: 0.6rem; }
  h3 { margin: 0; font-size: 1rem; font-weight: 600; }
  .seat-name { margin: 0; font-size: 1.15rem; }
  .small { padding: 0.35rem 0.75rem; font-size: 0.85rem; }
  li .small { flex: none; }
  .codes { margin: 0; color: var(--text-secondary); font-size: 0.9rem; }
  .quiet { margin: 0; color: var(--text-muted); font-size: 0.9rem; }
  .notice { margin: 0; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text-secondary); background: var(--bg-surface); }
  .row-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .hold { display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; align-items: center; }
  .hold label { color: var(--text-secondary); font-size: 0.9rem; }
  .hold select { font: inherit; background: var(--bg-input); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.45rem; min-width: 0; }
  .wide { width: 100%; }
  .save { margin: 0; color: var(--text-muted); font-size: 0.85rem; }
  .save.failed { color: var(--error); display: flex; flex-direction: column; gap: 0.4rem; }
  .save.failed p { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .link { font: inherit; color: var(--text); background: none; border: none; padding: 0; text-decoration: underline; cursor: pointer; }

  @media (max-width: 760px) {
    .summary { gap: 0.3rem; }
    .count { padding: 0.25rem 0.5rem; font-size: 0.85rem; gap: 0.35rem; }
    .room { grid-template-columns: 1fr; }
    .map { height: 60vh; }
    /* At the venue: the selection stays in reach while the map scrolls. */
    .selection.active { position: sticky; bottom: 0; z-index: 2; box-shadow: 0 -8px 24px var(--bg); }
  }
</style>
