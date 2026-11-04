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

  interface TicketInfo {
    /** The buyer's address, once the organiser has opened the orders on this device. */
    email?: string;
    refunded: boolean;
    erased: boolean;
  }
  interface Props {
    event: EventFeed;
    apiUrl: string;
    /** What the dashboard knows about ticket `edition` of a ticket type. */
    ticketInfo?: (seriesId: string, edition: number) => TicketInfo | null;
  }
  let { event, apiUrl, ticketInfo }: Props = $props();

  /** "Change seat": the ticket being moved and where it sits; then the seat chosen. */
  let moving = $state<{ slot: number; seat: number } | null>(null);
  let moveTarget = $state<number | null>(null);
  let putBackOld = $state(true);
  let emailBuyer = $state(true);
  let movePhase = $state<{ phase: "idle" | "moving" } | { phase: "done"; text: string } | { phase: "failed"; text: string }>({ phase: "idle" });

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
    if (moving) {
      // Choosing where the ticket goes: a free, held or emptied seat, or another ticket's (a swap).
      const st = orgSeat(k, inputs);
      if (k === moving.seat || movePhase.phase === "moving") return;
      if (st.status === "basket" || st.status === "unknown" || (st.status === "sold" && st.slot === null)) return;
      moveTarget = k;
      picks = [moving.seat, k].sort((a, b) => a - b);
      return;
    }
    picks = orgToggle(picks, k, inputs);
    lastTap = picks.includes(k) ? k : null;
  }

  function startMove(t: { slot: number; seat: number }): void {
    moving = t;
    moveTarget = null;
    putBackOld = !inputs.holds.has(t.seat);
    emailBuyer = true;
    movePhase = { phase: "idle" };
    picks = [t.seat];
  }

  function endMove(): void {
    moving = null;
    moveTarget = null;
    picks = [];
    if (movePhase.phase === "failed") movePhase = { phase: "idle" };
  }

  /** The move the organiser chose: a seat, out of its seat (a refunded ticket), or a swap. */
  const plannedMove = $derived.by(() => {
    if (!moving) return null;
    if (moveTarget === -1) return { kind: "move" as const, slot: moving.slot, to: "none" as const };
    if (moveTarget === null) return null;
    const st = orgSeat(moveTarget, inputs);
    return st.status === "sold" && st.slot !== null
      ? { kind: "swap" as const, a: moving.slot, b: st.slot, other: st.slot }
      : { kind: "move" as const, slot: moving.slot, to: moveTarget };
  });

  async function runMove(): Promise<void> {
    const m = plannedMove;
    if (!m || !moving || !series || !map) return;
    movePhase = { phase: "moving" };
    const s = series;
    const req = m.kind === "swap" ? { kind: "swap" as const, a: m.a, b: m.b } : { kind: "move" as const, slot: m.slot, to: m.to };
    try {
      const [{ auth }, changes, { liveLedger2ClientIO: io }, moves, data] = await Promise.all([
        import("../../auth/auth-store.svelte.js"),
        import("../../ledger2/organiser-changes.js"),
        import("../../ledger2/organiser-changes-live.js"),
        import("../../ledger2/seat-moves.js"),
        import("./organiser-seat-data.js"),
      ]);
      const parent = auth.parent?.toLowerCase();
      if (!parent) throw new Error("Sign in again to change seats.");
      const view = await changes.readLedger2Event(event, parent, io);
      if (!view) throw new Error("Couldn't read your tickets just now. Try again in a moment.");
      const signed = await moves.signSeatMoves(view, s.seriesId, req, io);
      const out = await moves.sendSeatMoves(event.eventId, view.target.address, signed, io, changes.messageFor);
      if (out.phase === "failed") {
        movePhase = { phase: "failed", text: out.message };
        return;
      }
      if (out.phase === "unconfirmed") {
        movePhase = { phase: "failed", text: "The change was sent but hasn't shown up yet. Check this ticket again in a few minutes before trying again." };
        return;
      }
      void map.refresh(true);
      // The seat left empty goes back on sale at the nonce the move gave it - read where the
      // move already shows, so a replica behind it cannot hand back the old one.
      let putBack = "";
      if (putBackOld && signed.planned.emptied.length) {
        const call = await data.liveMulticall();
        const left = signed.planned.emptied.map(Number);
        const asMoves = left.map((seat) => ({ slot: -1, from: seat, to: -1, block: 0 }));
        for (let i = 0; call && i < 6; i++) {
          const e = await data.readEmptiedSeats(call, view.target.address, s.onChainEventId, asMoves, new Map(own?.confirmed ?? []));
          if (e && left.every((k) => e.has(k))) {
            saver?.add(putBackDelta(left, { emptied: e }));
            putBack = ` ${left.map(label).join("; ")} is back on sale.`;
            break;
          }
          await new Promise((r) => setTimeout(r, 3_000));
        }
        if (!putBack) putBack = " The old seat stays off sale for now - put it back from the list below.";
      }
      let mailed = "";
      if (emailBuyer && ticketInfo) {
        const slots = m.kind === "swap" ? [m.a, m.b] : [m.slot];
        const { authPost } = await import("../../api/client.js");
        const byEmail = new Map<string, number[]>();
        for (const slot of slots) {
          const to = ticketInfo(s.seriesId, slot + 1)?.email;
          if (to) byEmail.set(to, [...(byEmail.get(to) ?? []), slot]);
        }
        let ok = 0;
        for (const [to, ss] of byEmail) {
          const r = await authPost<{ slots: Array<{ slot: number; outcome: string }> }>(
            `/api/events/${encodeURIComponent(event.eventId)}/seat-moved`, { seriesId: s.seriesId, slots: ss, to },
          ).catch(() => null);
          if (r?.ok && r.data?.slots.every((o) => o.outcome === "sent")) ok++;
        }
        mailed = ok === byEmail.size && ok > 0 ? " The buyer has been emailed their new seat." : " The email to the buyer couldn't be sent.";
      }
      movePhase = { phase: "done", text: `Moved.${putBack}${mailed}` };
      moving = null;
      moveTarget = null;
      picks = [];
      const deployment = await (await import("../../keyring/organiser-event-scan.js")).ownLedger2Deployment();
      void readTickets(data, view.target.address, s.onChainEventId, deployment);
    } catch (e) {
      movePhase = { phase: "failed", text: e instanceof Error && e.message ? e.message : "Couldn't change the seat just now. Nothing was moved." };
    }
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
        <div class="selection" class:active={picks.length > 0 || !!moving}>
          {#if moving}
            {@const m = plannedMove}
            {@const info = ticketInfo?.(series!.seriesId, moving.slot + 1) ?? null}
            <h3>Change the seat of Ticket #{moving.slot + 1}</h3>
            <p class="codes">Now: {label(moving.seat)}</p>
            {#if !m}
              <p class="quiet">Tap the new seat on the map - a free or held seat, or another ticket's seat to swap the two.</p>
              {#if info?.refunded}
                <button type="button" class="btn btn--ghost wide" onclick={() => { moveTarget = -1; picks = [moving!.seat]; }}>
                  Free this seat - the ticket was refunded
                </button>
              {/if}
            {:else}
              {#if m.kind === "swap"}
                <p class="seat-name">Swap with Ticket #{m.other + 1} in {label(moveTarget!)}</p>
              {:else if m.to === "none"}
                <p class="seat-name">Take this refunded ticket out of its seat</p>
                {#if snap?.chain && snap.chain.remaining === 0n}
                  <p class="quiet">Every ticket is sold, so the seat can't sell again until tickets are available.</p>
                {/if}
              {:else}
                {@const tst = orgSeat(m.to, inputs)}
                <p class="seat-name">To: {label(m.to)}</p>
                {#if tst.status === "held"}
                  <p class="quiet">It's one of your {HOLD_KIND_NAMES[tst.kind].toLowerCase()}: it stays held after this ticket moves on.</p>
                {/if}
                {#if plan && plan.seats[m.to]?.b !== plan.seats[moving.seat]?.b}
                  <p class="quiet">It's in a different price band. No money changes hands.</p>
                {/if}
              {/if}
              {#if m.kind === "move" && !inputs.holds.has(moving.seat)}
                <label class="check"><input type="checkbox" bind:checked={putBackOld} /> Put {label(moving.seat)} back on sale</label>
              {:else if m.kind === "move"}
                <p class="quiet">{label(moving.seat)} stays held.</p>
              {/if}
              {#if m.to !== "none"}
                {#if info?.email}
                  <label class="check"><input type="checkbox" bind:checked={emailBuyer} /> Email the {m.kind === "swap" ? "buyers their" : "buyer their"} new seat</label>
                {:else}
                  <p class="quiet">Open this event's orders first to email the buyer their new seat.</p>
                {/if}
              {/if}
              <div class="row-actions">
                <button type="button" class="btn btn--primary" disabled={movePhase.phase === "moving" || closed} onclick={runMove}>
                  {movePhase.phase === "moving" ? "Moving…" : m.kind === "swap" ? "Swap tickets" : m.to === "none" ? "Free seat" : "Move ticket"}
                </button>
                <button type="button" class="btn btn--ghost" disabled={movePhase.phase === "moving"} onclick={endMove}>Cancel</button>
              </div>
            {/if}
            {#if movePhase.phase === "failed"}
              <p class="save failed" role="alert">{movePhase.text}</p>
            {/if}
          {:else if actions.ticket}
            {@const st = orgSeat(actions.ticket.seat, inputs)}
            <h3>Ticket #{actions.ticket.slot + 1}</h3>
            <p class="seat-name">{label(actions.ticket.seat)}</p>
            {#if st.status === "sold" && st.held}
              <p class="quiet">This is {HOLD_KIND_SEAT[st.held]}: it stays held after this ticket moves on.</p>
            {/if}
            <div class="row-actions">
              <button type="button" class="btn btn--primary" disabled={closed}
                onclick={() => startMove({ slot: actions.ticket!.slot, seat: actions.ticket!.seat })}>Change seat</button>
              <button type="button" class="btn btn--ghost" onclick={() => (picks = [])}>Done</button>
            </div>
            <p class="quiet">Seats can be changed until ticket sales end.</p>
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
            {#if movePhase.phase === "done"}<p class="save" role="status">{movePhase.text}</p>{/if}
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
  .check { display: flex; gap: 0.5rem; align-items: center; color: var(--text-secondary); font-size: 0.9rem; }
  .check input { accent-color: var(--accent); }
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
