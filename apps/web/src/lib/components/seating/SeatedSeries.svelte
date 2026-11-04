<script lang="ts">
  /**
   * A seated ticket type on an event page (docs/SEATING.md): a small drawing of the
   * plan and "Choose seats", which opens the full-screen picker. The page's host
   * decides the address (`open` + `onopen`/`onclose`: a hash route in the app and on
   * websites, so Back, a reload and a shared link all work); without one, it opens in
   * place.
   *
   * Everything seating-specific is loaded only here, only for a seated series: a
   * general-admission page never downloads the map.
   */
  import { onMount } from "svelte";
  import type { SeriesSummary } from "@woco/shared";
  import { headlinePrice } from "@woco/shared/event/fees";
  import { seatMapFor } from "../../seating/seat-map-source.js";

  interface Props {
    eventId: string;
    eventTitle: string;
    series: SeriesSummary;
    apiUrl: string;
    /** The host's address says the picker is open. Absent: the picker keeps its own state. */
    open?: boolean;
    onopen?: () => void;
    onclose?: () => void;
  }

  let { eventId, eventTitle, series, apiUrl, open, onopen, onclose }: Props = $props();

  let ownOpen = $state(false);
  const isOpen = $derived(open ?? ownOpen);
  let button: HTMLButtonElement | undefined = $state();
  let thumb: SVGSVGElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  let thumbReady = $state(false);

  // What a buyer pays per seat, booking fee included, lowest and highest band.
  const range = $derived.by(() => {
    const prices = (series.seating?.bands ?? [])
      .map((b) => (series.payment ? headlinePrice({ ...series.payment, price: b.price }) : null))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => a.amount - b.amount);
    if (!prices.length) return null;
    const lo = prices[0], hi = prices[prices.length - 1];
    return lo.amount === hi.amount ? lo.label : `${lo.label} - ${hi.label}`;
  });

  function openPicker(): void {
    if (onopen) onopen();
    else ownOpen = true;
  }
  function closePicker(): void {
    if (onclose) onclose();
    else ownOpen = false;
    queueMicrotask(() => button?.focus());
  }

  // The drawing loads once the card is near the screen; the picker reuses the same load.
  onMount(() => {
    if (!card) return;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const r = await seatMapFor(eventId, series, apiUrl);
      if (!r.ok || !thumb) return;
      const [{ drawThumb, drawOverviewThumb }, { paletteFromCss }] = await Promise.all([
        import("@woco/seatmap/draw"), import("@woco/seatmap/palette"),
      ]);
      const palette = paletteFromCss(card ?? document.documentElement);
      // Seat by seat for a small room; outlines for a big one (cheap at any size).
      if (r.map.plan.seats <= 2_500) drawThumb(thumb, r.map.plan.plan, palette);
      else drawOverviewThumb(thumb, r.map.plan.plan, palette);
      thumbReady = true;
    }, { rootMargin: "200px" });
    io.observe(card);
    return () => io.disconnect();
  });
</script>

<div class="ss" bind:this={card}>
  <button class="ss-thumb" class:ready={thumbReady} onclick={openPicker} tabindex="-1" aria-hidden="true">
    <svg bind:this={thumb} id={`ss-thumb-${series.seriesId}`}></svg>
  </button>
  <div class="ss-row">
    {#if range}<span class="ss-range">{range} <small>per seat</small></span>{/if}
    <button class="ss-open" bind:this={button} onclick={openPicker}>Choose seats</button>
  </div>
</div>

{#if isOpen}
  {#await import("@woco/seatmap/svelte/SeatPicker.svelte") then { default: SeatPicker }}
    <SeatPicker {eventId} {eventTitle} {series} load={() => seatMapFor(eventId, series, apiUrl)} onclose={closePicker} />
  {/await}
{/if}

<style>
  .ss { display: grid; gap: 0.75rem; margin-top: 0.75rem; }
  .ss-thumb {
    display: block; width: 100%; height: 9rem; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--bg); cursor: pointer;
  }
  .ss-thumb:not(.ready) { background: linear-gradient(90deg, var(--bg) 0%, var(--bg-elevated) 50%, var(--bg) 100%); background-size: 200% 100%; }
  .ss-thumb svg { width: 100%; height: 100%; display: block; }
  .ss-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .ss-range { font-family: var(--font-mono); font-size: 0.875rem; color: var(--text-secondary); }
  .ss-range small { font-family: var(--font-body); color: var(--text-muted); }
  .ss-open {
    margin-left: auto; padding: 0.625rem 1.125rem; min-height: 2.75rem; border: 1px solid var(--accent); border-radius: var(--radius-md);
    background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 600; cursor: pointer;
  }
  .ss-open:hover { background: var(--accent-hover); }
</style>
