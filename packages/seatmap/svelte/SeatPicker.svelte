<script lang="ts">
  /**
   * The buyer's seat map, full screen (docs/SEATING.md "Buyer experience"; S3 consult
   * Q7): the map on the left and the order on the right on a desktop; on a phone the
   * map with a bar at the bottom that pulls up into the order. One component for every
   * host: the app, organisers' websites, and the embed's frame. The host says where the
   * map loads from (`load`) and styles it through the same CSS variables the app uses
   * (--bg, --text, --accent ...).
   *
   * It draws, picks and explains. Holding seats and paying are the host's (`onhold`,
   * then the `checkout` snippet in the panel); a host that cannot sell passes no
   * `onhold` and the button says so.
   */
  import { onDestroy, onMount, tick, type Snippet } from "svelte";
  import type { SeriesSummary } from "@woco/shared/event/types";
  import { RESERVATION_MAX_QTY } from "@woco/shared/event/reservation";
  import { pickable, seatReason, seatStates, SEAT_FREE, SEAT_UNKNOWN, type SeatStates } from "@woco/shared/seating/availability";
  import { headlinePrice } from "@woco/shared/event/fees";
  import {
    bestFor, formatMinor, loneSeat, prunePicks, sectionSummaries, seatText, spokenLabel, togglePick,
  } from "../src/buyer.js";
  import { createPicker, pickerCss, type Picker } from "../src/picker.js";
  import { paletteFromCss } from "../src/palette.js";
  import { swatchSvg } from "../src/draw.js";
  import type { LiveSeatMap, SeatMapProblem, SeatMapSnapshot } from "../src/load.js";
  import type { Level } from "../src/view.js";
  import {
    companionBeside, mapNotice, picksStorageKey, priceRange, readPicks, seatPriceMinor, seatsText, shownBandPrices, totalLine, writePicks,
  } from "../src/picker-model.js";

  export type HoldResult = { ok: true; expiresAt: string } | { ok: false; message: string; conflicts?: number[] };
  export type SeatMapLoad = () => Promise<{ ok: true; map: LiveSeatMap } | { ok: false; problem: SeatMapProblem }>;

  interface Props {
    eventId: string;
    eventTitle: string;
    series: SeriesSummary;
    /** Where the map comes from (`loadSeatMap` with the host's gateway, RPC and API). */
    load: SeatMapLoad;
    onclose: () => void;
    /** Hold these seats on this plan. Absent: seat booking is not open yet. */
    onhold?: (req: { seats: number[]; planDigest: string }) => Promise<HoldResult>;
    /**
     * Shown in the panel while a hold runs: the order form and payment. `lost`: checkout
     * says the hold can no longer be paid as it is (the message says why); the panel goes
     * back to holding, the seats still chosen.
     */
    checkout?: Snippet<[{ seats: readonly number[]; expiresAt: string; lost: (message: string) => void }]>;
  }

  let { eventId, eventTitle, series, load: loadMap, onclose, onhold, checkout }: Props = $props();

  const MAX = RESERVATION_MAX_QTY;
  // svelte-ignore state_referenced_locally
  const currency = series.payment?.currency ?? "GBP";
  // svelte-ignore state_referenced_locally
  const fees = series.payment;
  const feeNote = headlinePrice(fees)?.feeLabel ? "incl. booking fee" : null;

  let map = $state.raw<LiveSeatMap | null>(null);
  let problem = $state<SeatMapProblem | null>(null);
  let loading = $state(true);
  let snap = $state.raw<SeatMapSnapshot | null>(null);
  let picks = $state<number[]>([]);
  let filter = $state<number | null>(null);
  let qty = $state(2);
  let level = $state<Level>("seats");
  let note = $state<string | null>(null);
  let confirmWheel = $state<number | null>(null);
  let sheetOpen = $state(false);
  let hold = $state<{ expiresAt: string } | null>(null);
  /** The seats the buyer's last hold named: still theirs while the server's view of it catches up. */
  let heldSeats = $state<number[]>([]);
  let holding = $state(false);
  let holdError = $state<string | null>(null);
  let expired = $state(false);
  let now = $state(Date.now());

  let mapEl: HTMLDivElement | undefined = $state();
  let root: HTMLDivElement | undefined = $state();
  let picker: Picker | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Closed before the map finished loading: the load must not start a refresh loop nobody reads. */
  let destroyed = false;
  let palette = $state.raw<ReturnType<typeof paletteFromCss> | null>(null);
  /** Sections on screen, from the picker: kept fresh by the loader with the picks. */
  let viewSections: readonly number[] = [];

  const bp = $derived(map?.plan ?? null);
  const states = $derived<SeatStates | null>(
    map && snap ? seatStates(map.plan.plan, { chain: snap.chain, organiser: map.organiser, onHold: snap.onHold, mine: hold ? picks : heldSeats, bandPrices: map.bandPrices }) : null,
  );
  /** Per band, what one seat costs with the booking fee: the only per-seat price shown. */
  const shown = $derived(map ? shownBandPrices(map.bandPrices, fees) : []);
  const summaries = $derived(bp && states && map ? sectionSummaries(bp, states, shown) : []);
  const orderLine = (ks: readonly number[]) => totalLine(bp!, map!.bandPrices, ks, currency, fees);
  const notice = $derived(mapNotice({ problem, sale: states?.sale ?? null, serverOk: snap?.serverOk }));
  const lone = $derived(bp && states && !hold && picks.length ? loneSeat(bp, states, picks) : null);
  const allow = (k: number) => filter === null || bp?.plan.seats[k]?.b === filter;
  const priceText = (k: number) => {
    const m = bp && map ? seatPriceMinor(bp, shown, k) : null;
    return m === null ? null : formatMinor(m, currency);
  };
  const storageKey = $derived(bp ? picksStorageKey(eventId, series.seriesId, bp.digest) : null);
  const secsLeft = $derived(hold ? Math.max(0, Math.floor((Date.parse(hold.expiresAt) - now) / 1000)) : 0);
  const bands = $derived(bp && map ? bp.plan.bands.map((b, i) => ({ ...b, index: i, price: shown[i] })).filter((b) => b.price !== null) : []);

  async function load(): Promise<void> {
    loading = true;
    problem = null;
    const r = await loadMap();
    if (destroyed) return;
    loading = false;
    if (!r.ok) { problem = r.problem; return; }
    map = r.map;
    snap = r.map.snapshot();
    unsubscribe?.();
    unsubscribe = r.map.subscribe((s) => {
      snap = s;
      if (r.map.problem) problem = r.map.problem;
    });
    const store = typeof sessionStorage === "undefined" ? null : sessionStorage;
    picks = readPicks(store, picksStorageKey(eventId, series.seriesId, r.map.plan.digest), r.map.plan.seats, MAX);
    r.map.start();
    // The load may be the ticket card's from a while ago: read the live part now.
    void r.map.refresh();
    await tick();
    mountPicker();
  }

  function mountPicker(): void {
    if (!mapEl || !map || picker) return;
    const p = paletteFromCss(root ?? document.documentElement);
    palette = p;
    const style = document.createElement("style");
    style.textContent = pickerCss(p);
    mapEl.appendChild(style);
    picker = createPicker(mapEl, {
      plan: map.plan,
      palette: p,
      id: `seatmap-${series.seriesId}`,
      label: `Seating plan for ${eventTitle}. Enter to go to the seats; the arrow keys move between them.`,
      onSeat: onSeat,
      onLevel: (l) => (level = l),
      onView: (sections) => { viewSections = sections; map?.watch({ sections, picks }); },
    });
    pushToPicker();
    if (picks.length) picker.showSeats(picks);
  }

  function pushToPicker(): void {
    if (!picker || !bp || !states) return;
    const s = states;
    const sums = summaries;
    picker.set({
      picks,
      locked: !!hold || holding,
      free: (k) => (s.codes[k] === SEAT_FREE || s.codes[k] === SEAT_UNKNOWN) && allow(k) && (s.sale === "on-sale" || s.sale === "unknown"),
      canPick: (k) => pickable(s, k) && allow(k),
      label: (k) => spokenLabel(bp, k, priceText(k)),
      reason: (k) => (!allow(k) && s.codes[k] === SEAT_FREE ? "not in the price you chose" : s.sale === "on-sale" ? seatReason(s.codes[k]) : null),
      sectionLine: (i) => {
        const x = sums[i];
        if (!x) return "";
        const price = priceRange(x.min, x.max, currency);
        return s.sale === "on-sale" ? `${x.free} free${price ? ` · ${price}` : ""}` : price;
      },
      sectionEmpty: (i) => !sums[i] || sums[i].free === 0,
    });
  }

  // Redraw on any change the map shows; keep the picks the loader refreshes.
  $effect(() => {
    void states; void picks; void filter; void hold; void holding;
    pushToPicker();
  });
  $effect(() => { map?.watch({ sections: viewSections, picks }); });
  $effect(() => { if (storageKey && !hold) writePicks(typeof sessionStorage === "undefined" ? null : sessionStorage, storageKey, picks); });

  // A pick someone else just bought, or that the sale stopped, leaves the order with a note.
  $effect(() => {
    // Nothing is known to be taken while the chain is unread: keep the picks.
    if (!states || !bp || hold || !picks.length || states.sale === "unknown") return;
    const { kept, lost } = prunePicks(picks, states);
    if (!lost.length) return;
    picks = kept;
    note = lost.length === 1 ? `${seatText(bp, lost[0])} has just been taken.` : `${lost.length} of your seats have just been taken.`;
    picker?.announce(note);
  });

  function onSeat(k: number): void {
    if (!bp || !states || hold) return;
    if (!picks.includes(k) && bp.plan.seats[k]?.a && confirmWheel !== k) {
      confirmWheel = k;
      return;
    }
    addOrRemove(k);
  }

  function addOrRemove(k: number): void {
    if (!bp || !states) return;
    const r = togglePick(picks, k, states, MAX);
    if (r === "full") { note = `Up to ${MAX} seats in one order.`; picker?.announce(note); return; }
    if (r === "not-free") return;
    const added = r.length > picks.length;
    picks = r;
    // A seat a ticket once left is sold only if the organiser confirmed it: read its nonce now,
    // not at the next refresh (the watch is pushed here, the effect that does it runs later).
    if (added && !snap?.chain?.nonces?.has(k)) { map?.watch({ sections: viewSections, picks: r }); void map?.refresh(); }
    note = null;
    holdError = null;
    picker?.announce(`${added ? "Added" : "Removed"} ${seatText(bp, k)}. ${picks.length ? orderLine(picks) : "No seats chosen."}`);
  }

  function confirmWheelchair(): void {
    if (confirmWheel === null) return;
    const k = confirmWheel;
    confirmWheel = null;
    addOrRemove(k);
  }

  function findBest(): void {
    if (!bp || !states) return;
    const best = bestFor(bp, states, qty, allow);
    if (!best) {
      note = `There aren't ${qty} seats together${filter === null ? "" : " at that price"}. Try fewer, or choose seats on the map.`;
      picker?.announce(note);
      return;
    }
    picks = best;
    note = null;
    picker?.showSeats(best);
    picker?.announce(`Found ${seatsText(bp, best)}. ${orderLine(best)}.`);
  }

  async function placeHold(): Promise<void> {
    if (!onhold || !bp || !picks.length || holding) return;
    holding = true;
    holdError = null;
    expired = false;
    try {
      const r = await onhold({ seats: [...picks].sort((a, b) => a - b), planDigest: bp.digest });
      if (r.ok) {
        now = Date.now();
        hold = { expiresAt: r.expiresAt };
        heldSeats = [...picks];
        sheetOpen = true;
      } else {
        holdError = r.message;
        if (r.conflicts?.length) picks = picks.filter((k) => !r.conflicts!.includes(k));
        void map?.refresh();
      }
    } finally {
      holding = false;
    }
  }

  function changeSeats(): void {
    hold = null;
    expired = false;
  }

  function holdLost(message: string): void {
    hold = null;
    expired = false;
    holdError = message;
    picker?.announce(message);
    void map?.refresh();
  }

  // The hold clock.
  $effect(() => {
    if (!hold) return;
    const id = setInterval(() => {
      now = Date.now();
      if (hold && Date.parse(hold.expiresAt) <= now) { hold = null; expired = true; picker?.announce("Your hold ran out. Your seats are still chosen: hold them again to continue."); }
    }, 1000);
    return () => clearInterval(id);
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (confirmWheel !== null) { confirmWheel = null; return; }
    if (sheetOpen) { sheetOpen = false; return; }
    onclose();
  }

  onMount(() => {
    void load();
    document.addEventListener("keydown", onKey);
    // The page behind does not scroll while the map is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  });
  onDestroy(() => {
    destroyed = true;
    unsubscribe?.();
    map?.stop();
    picker?.destroy();
  });

  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  /** "Rear stalls · wheelchair space": the band when it says more than the seat's own label does. */
  function pickDetail(k: number): string {
    if (!bp) return "";
    const s = bp.plan.seats[k];
    const band = bp.plan.bands[s.b]?.name ?? "";
    const area = (bp.plan.items[s.i] as { name?: string }).name ?? "";
    const parts = [band.trim().toLowerCase() === area.trim().toLowerCase() ? "" : band, s.a ? "wheelchair space" : "", s.c ? "companion seat" : ""];
    return parts.filter(Boolean).join(" · ");
  }
</script>

<div class="sp" bind:this={root} role="dialog" aria-modal="true" aria-labelledby="sp-title">
  <header class="sp-head">
    <button class="sp-back" onclick={onclose} aria-label="Back to the event">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <div class="sp-titles">
      <h2 id="sp-title">Choose your seats</h2>
      <p>{eventTitle} · {series.name}</p>
    </div>
  </header>

  <div class="sp-body">
    <div class="sp-map">
      <div class="sp-canvas" bind:this={mapEl}></div>
      {#if loading}
        <div class="sp-center"><span class="sp-spinner" aria-hidden="true"></span><p>Loading the seating plan…</p></div>
      {:else if problem && !map}
        <div class="sp-center">
          <p>{notice?.text}</p>
          {#if notice?.retry}<button class="sp-btn" onclick={load}>Try again</button>{/if}
        </div>
      {:else if map}
        <div class="sp-zoom" aria-label="Zoom">
          <button onclick={() => picker?.zoomBy(1.4)} aria-label="Zoom in">+</button>
          <button onclick={() => picker?.zoomBy(1 / 1.4)} aria-label="Zoom out">&minus;</button>
          <button onclick={() => picker?.fit()} aria-label="Show the whole plan">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" /></svg>
          </button>
        </div>
        <p class="sp-hint">{level === "sections" ? "Tap a section to see its seats" : "Tap seats to choose them · pinch or scroll to zoom"}</p>
      {/if}
    </div>

    {#if map && bp}
      <aside class="sp-panel" class:open={sheetOpen} class:held={!!hold && !!checkout} aria-label="Your order">
        <button class="sp-bar" onclick={() => (sheetOpen = !sheetOpen)} aria-expanded={sheetOpen}>
          <span class="sp-grip" aria-hidden="true"></span>
          <span class="sp-bar-text">{picks.length ? orderLine(picks) : "No seats chosen"}</span>
          {#if hold}<span class="sp-clock" class:warn={secsLeft <= 120}>{clock(secsLeft)}</span>{/if}
        </button>

        <div class="sp-scroll">
          {#if notice}
            <p class="sp-notice" role="status">{notice.text}
              {#if notice.retry && problem}<button class="sp-link" onclick={load}>Try again</button>{/if}
            </p>
          {/if}

          {#if !hold}
            <section class="sp-sec">
              <h3>Price</h3>
              <div class="sp-chips" role="group" aria-label="Show seats at">
                <button class="sp-chip" aria-pressed={filter === null} onclick={() => (filter = null)}>Any price</button>
                {#each bands as b (b.id)}
                  <button class="sp-chip" aria-pressed={filter === b.index} onclick={() => (filter = filter === b.index ? null : b.index)}>
                    <!-- Our own swatch markup (palette tokens only), never page or organiser text. -->
                    {#if palette}{@html swatchSvg(palette, b.style, 12)}{/if}
                    <span>{b.name}</span>
                    <span class="sp-mono">{formatMinor(b.price ?? 0, currency)}</span>
                  </button>
                {/each}
              </div>
              <p class="sp-key" aria-hidden="true">
                <span><i class="mine"></i>Your seats</span>
                <span><i class="gone"></i>Not available</span>
              </p>
            </section>

            <section class="sp-sec">
              <h3>Best available</h3>
              <div class="sp-best">
                <div class="sp-stepper" role="group" aria-label="How many seats">
                  <button onclick={() => (qty = Math.max(1, qty - 1))} disabled={qty <= 1} aria-label="One fewer">&minus;</button>
                  <output aria-live="polite">{qty}</output>
                  <button onclick={() => (qty = Math.min(MAX, qty + 1))} disabled={qty >= MAX} aria-label="One more">+</button>
                </div>
                <button class="sp-btn" onclick={findBest} disabled={states?.sale !== "on-sale"}>
                  Find the best {qty === 1 ? "seat" : `${qty} seats`}
                </button>
              </div>
              <p class="sp-small">Or tap seats on the map. Either way works.</p>
            </section>
          {/if}

          <section class="sp-sec">
            <h3>{hold ? "Held for you" : "Your seats"}</h3>
            {#if picks.length}
              <ul class="sp-picks">
                {#each picks as k (k)}
                  <li>
                    <button class="sp-where" onclick={() => picker?.showSeats([k])} aria-label={`Show ${seatText(bp, k)} on the map`}>
                      <span>{seatText(bp, k)}</span>
                      <small>{pickDetail(k)}</small>
                    </button>
                    <span class="sp-mono">{priceText(k)}</span>
                    {#if !hold}
                      <button class="sp-x" onclick={() => addOrRemove(k)} aria-label={`Remove ${seatText(bp, k)}`}>&times;</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="sp-small">No seats chosen yet.</p>
            {/if}
            {#if note}<p class="sp-note" role="status">{note}</p>{/if}
            {#if lone !== null}
              <p class="sp-note">That leaves {seatText(bp, lone)} empty on its own, which is hard to sell. Fine if these are the seats you want.</p>
            {/if}
            {#each picks.filter((k) => bp.plan.seats[k].a) as k (k)}
              {@const c = states ? companionBeside(bp, states, k, picks) : null}
              {#if c !== null && !hold}
                <p class="sp-note">{seatText(bp, c)} is a companion seat beside your wheelchair space.
                  <button class="sp-link" onclick={() => addOrRemove(c)}>Add it</button>
                </p>
              {/if}
            {/each}
          </section>

          {#if hold && checkout}
            {@render checkout({ seats: picks, expiresAt: hold.expiresAt, lost: holdLost })}
          {/if}
        </div>

        <footer class="sp-foot">
          <div class="sp-total">
            <span>{picks.length ? orderLine(picks) : "0 seats"}</span>
            {#if feeNote && picks.length}<small>{feeNote}</small>{/if}
          </div>
          {#if hold}
            <p class="sp-held" class:warn={secsLeft <= 120}>Held for you · <b>{clock(secsLeft)}</b></p>
            <button class="sp-btn ghost" onclick={changeSeats}>Change seats</button>
          {:else}
            {#if expired}<p class="sp-note">Your hold ran out. Your seats are still chosen.</p>{/if}
            {#if holdError}<p class="sp-note" role="alert">{holdError}</p>{/if}
            <button
              class="sp-btn primary"
              onclick={placeHold}
              disabled={!onhold || !picks.length || holding || states?.sale !== "on-sale" || snap?.serverOk === false}
            >
              {#if !onhold}Seat booking opens soon
              {:else if holding}Holding…
              {:else if expired}Hold again
              {:else if picks.length}Hold {picks.length === 1 ? "this seat" : `these ${picks.length} seats`}
              {:else}Choose seats to continue{/if}
            </button>
            {#if onhold && picks.length}<p class="sp-small">Nobody else can take them while you pay.</p>{/if}
          {/if}
        </footer>
      </aside>
    {/if}
  </div>

  {#if confirmWheel !== null && bp}
    <div class="sp-confirm" role="alertdialog" aria-labelledby="sp-wc-t" aria-describedby="sp-wc-d">
      <div class="sp-confirm-card">
        <h3 id="sp-wc-t">This is a wheelchair space</h3>
        <p id="sp-wc-d">{seatText(bp, confirmWheel)} has room for a wheelchair. Book it if you, or someone you're booking for, uses one.</p>
        <div class="sp-confirm-actions">
          <button class="sp-btn ghost" onclick={() => (confirmWheel = null)}>Not this one</button>
          <button class="sp-btn primary" onclick={confirmWheelchair}>Book this space</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .sp {
    position: fixed; inset: 0; z-index: 1000; display: grid; grid-template-rows: auto 1fr;
    background: var(--bg); color: var(--text); font-family: var(--font-body);
  }
  .sp-head { display: flex; align-items: center; gap: 0.75rem; padding: 0.625rem 1rem; border-bottom: 1px solid var(--border); }
  .sp-back { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: transparent; color: var(--text); cursor: pointer; }
  .sp-back:hover { border-color: var(--border-hover); }
  .sp-titles h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .sp-titles p { margin: 0.125rem 0 0; font-size: 0.8125rem; color: var(--text-muted); }

  .sp-body { display: grid; grid-template-columns: 1fr 22rem; min-height: 0; }
  .sp-map { position: relative; min-height: 0; overflow: hidden; }
  .sp-canvas { position: absolute; inset: 0; }
  .sp-center { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 0.75rem; padding: 2rem; text-align: center; color: var(--text-secondary); }
  .sp-spinner { width: 1.5rem; height: 1.5rem; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sp-spin 0.8s linear infinite; }
  @keyframes sp-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .sp-spinner { animation: none; } }
  .sp-zoom { position: absolute; top: 0.75rem; right: 0.75rem; display: grid; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--border); }
  .sp-zoom button { width: 2.25rem; height: 2.25rem; display: grid; place-items: center; background: var(--bg-surface); color: var(--text); border: 0; font-size: 1.125rem; cursor: pointer; }
  .sp-zoom button:hover { background: var(--bg-elevated); }
  .sp-hint { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); margin: 0; padding: 0.375rem 0.75rem; border-radius: 999px; background: color-mix(in srgb, var(--bg-elevated) 92%, transparent); border: 1px solid var(--border); font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; pointer-events: none; }

  .sp-panel { display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--border); background: var(--bg-surface); }
  .sp-bar { display: none; }
  .sp-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem; display: grid; gap: 1.25rem; align-content: start; }
  .sp-key { display: flex; flex-wrap: wrap; gap: 0.875rem; margin-top: 0.625rem; font-size: 0.75rem; color: var(--text-muted); }
  .sp-key span { display: inline-flex; align-items: center; gap: 0.375rem; }
  .sp-key i { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 2px; }
  .sp-key i.mine { background: var(--accent); }
  .sp-key i.gone { width: 0.5rem; height: 0.5rem; margin: 0.125rem; background: var(--border); }
  .sp-sec h3 { margin: 0 0 0.5rem; font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
  .sp-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
  .sp-chip { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.375rem 0.625rem; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.8125rem; cursor: pointer; min-height: 2rem; }
  .sp-chip:hover { border-color: var(--border-hover); }
  .sp-chip[aria-pressed="true"] { border-color: var(--accent); color: var(--text); background: var(--accent-subtle, transparent); }
  .sp-best { display: flex; gap: 0.5rem; align-items: stretch; }
  .sp-stepper { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .sp-stepper button { width: 2.25rem; height: 2.5rem; background: transparent; color: var(--text); border: 0; font-size: 1.125rem; cursor: pointer; }
  .sp-stepper button:disabled { color: var(--text-dim); cursor: default; }
  .sp-stepper output { min-width: 1.5rem; text-align: center; font-family: var(--font-mono); }
  .sp-best .sp-btn { flex: 1; }
  .sp-small { margin: 0.5rem 0 0; font-size: 0.75rem; color: var(--text-muted); }
  .sp-picks { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
  .sp-picks li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .sp-where { display: grid; text-align: left; background: none; border: 0; padding: 0; color: var(--text); font: inherit; font-size: 0.875rem; cursor: pointer; }
  .sp-where small { color: var(--text-muted); font-size: 0.75rem; }
  .sp-x { width: 2rem; height: 2rem; border: 1px solid transparent; border-radius: var(--radius-md); background: none; color: var(--text-muted); font-size: 1.125rem; cursor: pointer; }
  .sp-x:hover { border-color: var(--border); color: var(--text); }
  .sp-mono { font-family: var(--font-mono); font-size: 0.8125rem; }
  .sp-note, .sp-notice { margin: 0.5rem 0 0; padding: 0.5rem 0.625rem; border-left: 2px solid var(--accent); background: var(--bg-elevated); font-size: 0.8125rem; color: var(--text-secondary); }
  .sp-notice { margin: 0; border-left-color: var(--text-muted); }
  .sp-link { background: none; border: 0; padding: 0; margin-left: 0.25rem; color: var(--accent-text, var(--accent)); font: inherit; text-decoration: underline; cursor: pointer; }

  .sp-foot { padding: 0.875rem 1rem 1rem; border-top: 1px solid var(--border); display: grid; gap: 0.5rem; }
  .sp-total { display: flex; justify-content: space-between; align-items: baseline; font-weight: 600; }
  .sp-total small { color: var(--text-muted); font-weight: 400; font-size: 0.75rem; }
  .sp-held { margin: 0; font-size: 0.875rem; color: var(--text-secondary); }
  .sp-held.warn b, .sp-clock.warn { color: var(--accent-text, var(--accent)); }
  .sp-btn { padding: 0.625rem 1rem; min-height: 2.75rem; border: 1px solid var(--border-hover); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
  .sp-btn:hover:not(:disabled) { border-color: var(--text-muted); }
  .sp-btn:disabled { opacity: 0.5; cursor: default; }
  .sp-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .sp-btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .sp-btn.ghost { background: transparent; }

  .sp-confirm { position: absolute; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--bg) 70%, transparent); padding: 1rem; }
  .sp-confirm-card { max-width: 24rem; padding: 1.25rem; border: 1px solid var(--border-hover); border-radius: var(--radius-lg); background: var(--bg-surface); }
  .sp-confirm-card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
  .sp-confirm-card p { margin: 0 0 1rem; color: var(--text-secondary); font-size: 0.875rem; }
  .sp-confirm-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

  /*
   * Phone: the map fills the screen. The order is a bar at the bottom - what is chosen
   * and the one action - that pulls up into the full order.
   */
  @media (max-width: 899px) {
    .sp-body { grid-template-columns: 1fr; position: relative; }
    .sp-panel {
      position: absolute; left: 0; right: 0; bottom: 0; max-height: 75%; border-left: 0; border-top: 1px solid var(--border);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
    }
    .sp-bar {
      display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.5rem; padding: 0.875rem 1rem 0.625rem; position: relative;
      background: none; border: 0; color: var(--text); font: inherit; font-weight: 600; text-align: left; cursor: pointer; min-height: 3rem;
    }
    .sp-grip { position: absolute; top: 0.375rem; left: 50%; width: 2.25rem; height: 0.25rem; margin-left: -1.125rem; border-radius: 999px; background: var(--border-hover); }
    .sp-clock { font-family: var(--font-mono); }
    .sp-hint { bottom: 5.5rem; }
    /* Collapsed: one row, the summary and the action side by side. */
    .sp-panel:not(.open) { flex-direction: row; align-items: center; }
    .sp-panel:not(.open) .sp-bar { flex: 1; min-width: 0; }
    .sp-panel:not(.open) .sp-scroll,
    .sp-panel:not(.open) .sp-foot > :not(.sp-btn.primary, .sp-held) { display: none; }
    .sp-panel:not(.open) .sp-foot { border-top: 0; padding: 0.5rem 0.75rem 0.5rem 0; }
    .sp-panel:not(.open) .sp-held { display: none; }
    .sp-panel:not(.open) .sp-btn.primary { white-space: nowrap; }
    /* Open while paying: the bar above already shows the total and the clock. */
    .sp-panel.open.held .sp-total, .sp-panel.open.held .sp-held { display: none; }
  }
</style>
