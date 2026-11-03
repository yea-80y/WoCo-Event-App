<script lang="ts">
  /**
   * The seated route's ticket step (docs/SEATING.md): choose a plan, price its
   * bands, say how the booking fee is charged. The builder itself loads only when
   * an organiser opens it.
   */
  import { onMount } from "svelte";
  import { APP_PALETTE, drawThumb, swatchSvg } from "@woco/seatmap";
  import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
  import { canonicalSeats } from "@woco/shared/seating/plan";
  import type { SeatLayout } from "@woco/shared/seating/layout";
  import { BUYER_FEE_FLOOR_PCT, CURRENCY_SYMBOLS, MIN_TICKET_PRICE, cardOrderAmounts } from "@woco/shared";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import { currencyChoices, feeSettings, type Ccy } from "../events/payment-settings.js";
  import { counts } from "./edit.js";
  import { seatedDraftProblems, type SeatedDraft } from "./seated-draft.js";

  interface Props { draft: SeatedDraft }
  let { draft = $bindable() }: Props = $props();

  let builderOpen = $state(false);
  let payoutCurrency = $state<string | undefined>(undefined);
  const currencies = $derived(currencyChoices(payoutCurrency));
  const sym = $derived(CURRENCY_SYMBOLS[draft.currency] ?? "");

  onMount(() => {
    getStripeAccountStatus().then((s) => {
      payoutCurrency = s?.defaultCurrency ?? undefined;
      const options = currencyChoices(payoutCurrency);
      if (!options.includes(draft.currency)) draft.currency = options[0];
    }).catch(() => {});
  });

  const summary = $derived.by(() => {
    if (!draft.layout) return null;
    const c = counts(draft.layout);
    return { seats: canonicalSeats(draft.layout).length, c };
  });
  const problems = $derived(seatedDraftProblems(draft));

  // Every band a seat uses, held ones included: a held seat goes on sale at its band's price.
  const bandSeats = $derived.by(() => {
    const n: Record<string, number> = {};
    for (const it of draft.layout?.items ?? []) {
      const lists = it.kind === "rows" ? it.rows.map((r) => r.seats) : it.kind === "table" ? [it.seats] : [];
      for (const l of lists) for (const s of l) if (!("g" in s)) n[s.b] = (n[s.b] ?? 0) + 1;
    }
    return n;
  });
  const usedBands = $derived(draft.layout ? draft.layout.bands.filter((b) => (bandSeats[b.id] ?? 0) > 0) : []);

  function thumb(node: SVGSVGElement, l: SeatLayout) {
    node.id = `seat-pick-${Math.random().toString(36).slice(2, 9)}`;
    drawThumb(node, l, APP_PALETTE);
    return { update(next: SeatLayout) { drawThumb(node, next, APP_PALETTE); } };
  }

  function choose(id: string) {
    const t = LAYOUT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    draft.layout = t.make();
    draft.prices = {};
    builderOpen = true;
  }

  function done(layout: SeatLayout, prices: Record<string, string>) {
    draft.layout = layout;
    draft.prices = prices;
    builderOpen = false;
  }

  type FeeMode = "percent" | "cover" | "absorb";
  const feeMode = $derived<FeeMode>(!draft.fee.feePassedToCustomer ? "absorb" : draft.fee.coverFees ? "cover" : "percent");
  function setFeeMode(m: FeeMode) {
    draft.fee = { ...draft.fee, feePassedToCustomer: m !== "absorb", coverFees: m === "cover" };
  }

  // A one-seat order at the cheapest price, from the checkout's own arithmetic.
  const example = $derived.by(() => {
    const prices = usedBands.map((b) => parseFloat(draft.prices[b.id] ?? "")).filter((n) => n > 0);
    if (!prices.length) return null;
    const unit = Math.round(Math.min(...prices) * 100);
    const a = cardOrderAmounts(feeSettings(draft.fee), unit, 1);
    const fmt = (m: number) => `${sym}${(m / 100).toFixed(2)}`;
    return { price: fmt(unit), total: fmt(a.totalMinor), fee: fmt(a.bookingFeeMinor), passed: a.mode !== "none" };
  });
</script>

<section class="seating" aria-labelledby="seating-h">
  <h3 id="seating-h">Seating plan</h3>

  {#if !draft.layout}
    <p class="lead">Start from the layout closest to your room. You'll move things until it fits, then price the seats.</p>
    <div class="picks">
      {#each LAYOUT_TEMPLATES as t (t.id)}
        {@const l = t.make()}
        {@const n = canonicalSeats(l).length}
        <button class="pick" onclick={() => choose(t.id)}>
          <svg use:thumb={l} aria-hidden="true"></svg>
          <b>{t.name}</b>
          <small>{n ? `${n} seats` : "Build it your way"}</small>
        </button>
      {/each}
    </div>
  {:else if summary}
    <div class="plan-card">
      <svg use:thumb={draft.layout} aria-hidden="true"></svg>
      <div class="plan-info">
        <b>{draft.layout.name}</b>
        <span>{summary.seats} seats{summary.c.held ? `, ${summary.c.held} held` : ""}{summary.c.wheel ? `, ${summary.c.wheel} wheelchair ${summary.c.wheel === 1 ? "space" : "spaces"}` : ""}</span>
        <div class="plan-actions">
          <button class="btn primary" onclick={() => (builderOpen = true)}>Edit the plan</button>
          <button class="btn ghost" onclick={() => { draft.layout = null; draft.prices = {}; }}>Choose another layout</button>
        </div>
      </div>
    </div>

    <div class="prices">
      <p class="label">Prices</p>
      {#each usedBands as b (b.id)}
        <div class="price-row">
          <span class="sw">{@html swatchSvg(APP_PALETTE, b.style, 16)}</span>
          <span class="band">{b.name} <small>{bandSeats[b.id]} seats</small></span>
          <label class="amount">
            <span>{sym}</span>
            <input inputmode="decimal" aria-label="Price for {b.name}" placeholder="0.00" value={draft.prices[b.id] ?? ""}
              oninput={(e) => { draft.prices[b.id] = (e.currentTarget as HTMLInputElement).value.replace(/[^\d.]/g, "").slice(0, 9); }} />
          </label>
        </div>
      {/each}
      <p class="hint">The minimum ticket price is {sym}{MIN_TICKET_PRICE}.00. Listings show "from" the cheapest price.</p>
    </div>

    <div class="row">
      <label class="field">
        <span class="label">Name on the tickets</span>
        <input type="text" bind:value={draft.name} maxlength="80" placeholder="Seats" />
      </label>
      <label class="field narrow">
        <span class="label">Currency</span>
        <select bind:value={draft.currency} disabled={currencies.length === 1}>
          {#each currencies as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
    </div>

    <fieldset class="fees">
      <legend class="label">Booking fee</legend>
      <label><input type="radio" name="seat-fee" checked={feeMode === "percent"} onchange={() => setFeeMode("percent")} />
        Buyers pay a booking fee of
        <input class="pct" type="number" min={BUYER_FEE_FLOOR_PCT} step="0.5" value={draft.fee.buyerFeePercent}
          onchange={(e) => { draft.fee = { ...draft.fee, buyerFeePercent: Math.max(BUYER_FEE_FLOOR_PCT, Number((e.currentTarget as HTMLInputElement).value) || BUYER_FEE_FLOOR_PCT) }; }} />%
      </label>
      <label><input type="radio" name="seat-fee" checked={feeMode === "cover"} onchange={() => setFeeMode("cover")} /> Buyers pay exactly what the card and WoCo fees cost</label>
      <label><input type="radio" name="seat-fee" checked={feeMode === "absorb"} onchange={() => setFeeMode("absorb")} /> You pay the fees out of the ticket price</label>
      {#if example}
        <p class="hint">A {example.price} seat costs the buyer {example.total}{example.passed ? `, including a ${example.fee} booking fee` : ""}.</p>
      {/if}
    </fieldset>
  {/if}

  {#if draft.layout && problems.length}
    <ul class="problems">{#each problems as p, i (i)}<li>{p}</li>{/each}</ul>
  {/if}
</section>

{#if builderOpen && draft.layout}
  {#await import("./SeatBuilder.svelte") then { default: SeatBuilder }}
    <SeatBuilder layout={draft.layout} prices={draft.prices} currencySymbol={sym} onclose={() => (builderOpen = false)} ondone={done} />
  {/await}
{/if}

<style>
  .seating { display: grid; gap: 1rem; }
  h3 { margin: 0; font-size: 1.05rem; color: var(--text); }
  .lead { margin: 0; color: var(--text-secondary); font-size: 0.9rem; }
  .label { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 0.35rem; padding: 0; }
  .hint { margin: 0.35rem 0 0; color: var(--text-muted); font-size: 0.8rem; }
  .picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.5rem; }
  .pick { display: grid; gap: 0.2rem; text-align: left; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text); font: inherit; cursor: pointer; }
  .pick:hover, .pick:focus-visible { border-color: var(--accent); }
  .pick svg { width: 100%; height: 84px; display: block; background: var(--bg); border-radius: var(--radius-sm); margin-bottom: 0.25rem; }
  .pick small { color: var(--text-muted); }
  .plan-card { display: grid; grid-template-columns: 180px 1fr; gap: 1rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); }
  .plan-card svg { width: 100%; height: 120px; display: block; background: var(--bg); border-radius: var(--radius-sm); }
  .plan-info { display: grid; align-content: start; gap: 0.3rem; }
  .plan-info span { color: var(--text-secondary); font-size: 0.85rem; }
  .plan-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }
  .btn { border: 1px solid var(--border-hover); background: var(--bg-surface); border-radius: var(--radius-md); padding: 0.45rem 0.8rem; color: var(--text); font: inherit; cursor: pointer; }
  .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
  .btn.ghost:hover { color: var(--text); }
  .prices { display: grid; gap: 0.35rem; }
  .price-row { display: grid; grid-template-columns: 22px 1fr 120px; gap: 0.6rem; align-items: center; }
  .sw { display: grid; place-items: center; }
  .band small { color: var(--text-muted); margin-left: 0.35rem; }
  .amount { display: flex; align-items: center; gap: 0.3rem; color: var(--text-muted); }
  .amount input { width: 100%; font-family: var(--font-mono); }
  input[type="text"], .amount input, select, .pct { background: var(--bg-input); border: 1px solid var(--border-hover); border-radius: var(--radius-md); padding: 0.45rem 0.6rem; color: var(--text); font: inherit; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .row { display: grid; grid-template-columns: 1fr 120px; gap: 0.75rem; }
  .field { display: grid; }
  .fees { border: 0; padding: 0; margin: 0; display: grid; gap: 0.4rem; }
  .fees label { display: flex; align-items: center; gap: 0.5rem; color: var(--text-secondary); font-size: 0.9rem; flex-wrap: wrap; }
  .fees input[type="radio"] { accent-color: var(--accent); }
  .pct { width: 4.5rem; padding: 0.25rem 0.4rem; }
  .problems { margin: 0; padding: 0.6rem 0.8rem 0.6rem 1.6rem; border: 1px solid var(--warning); border-radius: var(--radius-md); color: var(--text); font-size: 0.85rem; display: grid; gap: 0.2rem; }
  @media (max-width: 560px) {
    .plan-card { grid-template-columns: 1fr; }
    .price-row { grid-template-columns: 22px 1fr 100px; }
  }
</style>
