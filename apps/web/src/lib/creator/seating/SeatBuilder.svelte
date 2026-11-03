<script lang="ts">
  /**
   * The seating plan builder (docs/SEATING.md; prototype v3.1). Full screen: a tool
   * rail, the room, a bar that follows the selection, and a summary. Step 1 lays out
   * the room by dragging things in; step 2 paints seats with prices, held, wheelchair
   * and companion marks. The room is drawn by @woco/seatmap through BuilderController;
   * this component renders everything around it.
   */
  import { onMount, untrack } from "svelte";
  import { ADD_ICONS, MARK_ICONS, drawDefs, drawItem, drawOrder, drawThumb, paletteFromCss, swatchSvg, type BuyerView } from "@woco/seatmap";
  import type { SeatLayout, TableItem } from "@woco/shared/seating/layout";
  import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
  import { canonicalSeats, formatSeatLabel, seatLabel, seatPlanProblems } from "@woco/shared/seating/plan";
  import { seatRuns } from "@woco/shared/seating/best";
  import { unionBox } from "@woco/shared/seating/geometry";
  import { BuilderController } from "./controller.js";
  import { counts, longestRow, planNotes, tidyLayout, type AddKind, type Brush } from "./edit.js";

  interface Props {
    /** The layout to start from (copied; the original is never touched). */
    layout: SeatLayout;
    /** Band id -> price as typed. When given, step 2 edits prices beside the bands. */
    prices?: Record<string, string>;
    currencySymbol?: string;
    /** What the finish button says ("Use this plan", "Save layout"). */
    finishLabel?: string;
    onclose: () => void;
    ondone: (layout: SeatLayout, prices: Record<string, string>) => void;
  }
  let { layout, prices, currencySymbol = "£", finishLabel = "Use this plan", onclose, ondone }: Props = $props();

  const palette = paletteFromCss(document.documentElement);
  // Copied once on open (the builder edits its own copy until "Use this plan"). A plain
  // copy: the controller clones items, and a Svelte proxy cannot be cloned.
  const initial = untrack(() => ({ layout: $state.snapshot(layout) as SeatLayout, prices: prices ? { ...prices } : undefined }));
  const ctrl = new BuilderController(initial.layout, palette);
  const showPrices = initial.prices !== undefined;
  let priceDraft = $state<Record<string, string>>(initial.prices ?? {});

  let version = $state(0);
  ctrl.onchange = () => { version++; };
  let toastMsg = $state("");
  let toastTimer = 0;
  ctrl.ontoast = (m) => toast(m);

  let svgEl: SVGSVGElement;
  let canvasEl: HTMLDivElement;
  let shellEl: HTMLDivElement;
  let ctxEl: HTMLDivElement;
  let bubbleEl: HTMLDivElement;

  let dialog = $state<"" | "templates" | "check" | "preview" | "leave">("");

  onMount(() => ctrl.attach({ svg: svgEl, canvas: canvasEl, shell: shellEl, ctx: ctxEl, bubble: bubbleEl }));

  function toast(m: string) {
    toastMsg = m;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastMsg = ""), 3400);
  }

  const ui = $derived.by(() => {
    void version;
    const sel = ctrl.selItems();
    return {
      step: ctrl.step,
      sel,
      brush: ctrl.brush,
      bands: ctrl.plan.bands,
      counts: counts(ctrl.plan),
      canUndo: ctrl.undoStack.length > 0,
      canRedo: ctrl.redoStack.length > 0,
      dragging: ctrl.dragging,
      selBand: ctrl.bandOfItems(sel),
    };
  });

  const potential = $derived(
    showPrices
      ? ui.bands.reduce((sum, b) => sum + (ui.counts.byBand[b.id] ?? 0) * (parseFloat(priceDraft[b.id] ?? "") || 0), 0)
      : 0,
  );

  const ADD: { kind: AddKind; label: string }[] = [
    { kind: "rows", label: "Rows of seats" },
    { kind: "round", label: "Round table" },
    { kind: "long", label: "Long table" },
    { kind: "head", label: "Top table" },
    { kind: "stage", label: "Stage" },
    { kind: "ring", label: "Ring" },
    { kind: "pitch", label: "Pitch or court" },
    { kind: "bar", label: "Bar" },
    { kind: "floor", label: "Dance floor" },
    { kind: "label", label: "Label" },
  ];
  const MARKS: { id: Exclude<Brush, { band: string }>; label: string; desc: string; key: string }[] = [
    { id: "held", label: "Held", desc: "Off sale for now - sound desk, guests, or not sure yet.", key: "H" },
    { id: "wheel", label: "Wheelchair space", desc: "Shown on the map and bookable online.", key: "W" },
    { id: "companion", label: "Companion seat", desc: "Beside a wheelchair space, for whoever comes with them.", key: "C" },
    { id: "gap", label: "No seat here", desc: "Aisles, pillars and gaps. Never sold.", key: "N" },
  ];
  const brushIs = (b: Brush) => JSON.stringify(ui.brush) === JSON.stringify(b);

  type Seg = string | { k: string };
  const hint = $derived.by((): Seg[] => {
    const mod = ctrl.mod;
    if (ui.step === "seats") {
      const br = ui.brush;
      if (br === "held") return ["Painting Held: kept off sale until you put them on sale, even after tickets go on sale."];
      if (br === "wheel") return ["Painting Wheelchair space: buyers see it on the map and can book it online."];
      if (br === "companion") return ["Painting Companion seat: the seat beside a wheelchair space."];
      if (br === "gap") return ["Painting No seat here: for aisles, pillars and gaps. Nothing is ever sold there."];
      const b = ui.bands.find((x) => x.id === br.band);
      return [`Painting ${b?.name ?? "a price"}. Tap seats, or drag across them. A price puts a held seat back on sale.`];
    }
    const items = ui.sel;
    if (ctrl.touch) {
      if (!items.length) return ["Tap something below to add it. Tap anything on the plan to move or change it."];
      if (items.length > 1) return ["Drag to move them together."];
      if (items[0].kind === "table") return ["Drag the handle for more seats. Duplicate puts a copy beside it - tap it again to keep going."];
      if (items[0].kind === "rows") return ["Drag the handles: sideways for seats, down for rows, the top one to turn it."];
      return ["Drag it to move it. The handles resize and turn it."];
    }
    if (!items.length) return ["Drag things from the left onto the plan. Click anything to move it, change it or copy it."];
    if (items.length > 1) return ["Drag to move them together. Shift-click adds or removes one. ", { k: `${mod}+D` }, " copies them all."];
    const it = items[0];
    if (it.kind === "rows") return ["Drag the round handles: sideways for seats in every row, down for more rows, the top one to turn it."];
    if (it.kind === "table") return ["Drag the handle out for more seats, or press ", { k: "+" }, " and ", { k: "-" }, ". ", { k: `${mod}+D` }, " puts a copy beside it - press it again to keep going."];
    return ["Drag the corner to resize it and the top handle to turn it."];
  });

  // ── Rail: tiles (tap adds in the middle; drag drops where let go) ──────────
  function tileClick(kind: AddKind) {
    if (ctrl.swallowClick) { ctrl.swallowClick = false; return; }
    ctrl.addAtCentre(kind);
  }

  function setPrice(id: string, value: string) {
    priceDraft[id] = value.replace(/[^\d.]/g, "").slice(0, 9);
  }

  // ── Thumbnails (templates, preview) ───────────────────────────────────────
  let thumbSeq = 0;
  function thumb(node: SVGSVGElement, l: SeatLayout) {
    node.id = `seat-thumb-${++thumbSeq}`;
    drawThumb(node, l, palette);
  }

  function applyTemplate(id: string) {
    const t = LAYOUT_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    ctrl.replacePlan(t.make());
    dialog = "";
    toast(`Started from ${t.name}. ${ctrl.mod}+Z puts your old plan back.`);
  }

  // The buyer's view of the plan as it stands: every seat free, nothing to pick.
  function preview(node: SVGSVGElement) {
    node.id = "seat-preview";
    const plan = ctrl.plan;
    const runs = seatRuns(plan.items);
    const seats = canonicalSeats(plan);
    const bandName = new Map(plan.bands.map((b) => [b.id, b.name]));
    const sym = currencySymbol;
    const view: BuyerView = {
      seatAt: (i, r, p) => runs.find((x) => x.item === i && x.row === r)?.seats[p] ?? -1,
      free: () => true,
      picked: () => false,
      label: (k) => {
        const l = seatLabel({ items: plan.items, seats }, k);
        const band = plan.bands[seats[k].b];
        const price = showPrices && band && priceDraft[band.id] ? `, ${sym}${priceDraft[band.id]}` : "";
        return l ? `${formatSeatLabel(l)}, ${bandName.get(band?.id ?? "") ?? ""}${price}` : "";
      },
      number: (k) => seats[k].n,
      locked: true,
    };
    const cb = unionBox(plan.items), pad = 24;
    node.setAttribute("viewBox", `${cb.x0 - pad} ${cb.y0 - pad} ${cb.x1 - cb.x0 + pad * 2} ${cb.y1 - cb.y0 + pad * 2}`);
    drawDefs(node, palette);
    for (const i of drawOrder(plan.items)) drawItem(node, plan.items[i], { mode: "buy", svgId: node.id, palette, bands: plan.bands, itemIndex: i, buyer: view });
  }

  // ── Check and finish ──────────────────────────────────────────────────────
  const check = $derived.by(() => {
    if (dialog !== "check") return null;
    void version;
    const tidy = structuredClone(ctrl.plan);
    tidyLayout(tidy);
    return { problems: seatPlanProblems(tidy), notes: planNotes(tidy), counts: counts(tidy) };
  });

  function finish() {
    const removed = tidyLayout(ctrl.plan);
    if (seatPlanProblems(ctrl.plan).length) return;
    if (removed) toast(`Tidied ${removed} empty ${removed === 1 ? "row" : "rows"} away.`);
    ondone(structuredClone(ctrl.plan), { ...priceDraft });
  }

  function leave() {
    if (ui.canUndo) dialog = "leave";
    else onclose();
  }

  const fmtMoney = (n: number) => `${currencySymbol}${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
</script>

<div class="seat-builder" class:seat-dialog-open={dialog !== ""} role="application" aria-label="Seating plan builder">
  <aside class="side" aria-label="Plan tools">
    <div class="plan-name">
      <input aria-label="Plan name" value={ctrl.plan.name} oninput={(e) => { ctrl.plan.name = (e.currentTarget as HTMLInputElement).value.slice(0, 80); }} />
    </div>

    {#if ui.step === "layout"}
      <button class="btn wide" onclick={() => (dialog = "templates")}>Start from a layout</button>
      <hr class="hairline" />
      <p class="panel-h">Add to the room</p>
      <p class="note tight">{ctrl.touch ? "Tap to drop it in the middle of the plan." : "Drag onto the plan, or tap to drop it in the middle."}</p>
      <div class="tiles">
        {#each ADD as a (a.kind)}
          <button class="tile" onpointerdown={(e) => ctrl.tileDown(a.kind, e)} onclick={() => tileClick(a.kind)}>
            {@html ADD_ICONS[a.kind]}<span>{a.label}</span>
          </button>
        {/each}
      </div>
      <hr class="hairline" />
      <p class="note">Each event keeps its own copy of the plan, so changing a saved plan later never touches an event already on sale.</p>
    {:else}
      <p class="panel-h">{showPrices ? "Prices" : "Price levels"}</p>
      {#each ui.bands as b, k (b.id)}
        <div class="band-row" class:on={brushIs({ band: b.id })} class:no-price={!showPrices}>
          <button class="band-pick" aria-pressed={brushIs({ band: b.id })} aria-label="Paint seats at {b.name}" title="Paint with this price ({k + 1})" onclick={() => ctrl.setBrush({ band: b.id })}>
            {@html swatchSvg(palette, b.style, 16)}
          </button>
          <input class="input" value={b.name} aria-label="Price name" onfocus={() => ctrl.setBrush({ band: b.id })} onchange={(e) => ctrl.renameBand(b.id, (e.currentTarget as HTMLInputElement).value)} />
          {#if showPrices}
            <div class="price-in">
              <span class="note">{currencySymbol}</span>
              <input class="input mono" inputmode="decimal" aria-label="Price for {b.name}" value={priceDraft[b.id] ?? ""} placeholder="0.00"
                onfocus={() => ctrl.setBrush({ band: b.id })} oninput={(e) => setPrice(b.id, (e.currentTarget as HTMLInputElement).value)} />
            </div>
          {/if}
        </div>
        <div class="band-count">{ui.counts.byBand[b.id] ?? 0} seats</div>
      {/each}
      {#if ui.bands.length < 8}
        <button class="btn ghost" onclick={() => ctrl.addPriceBand()}>Add a price</button>
      {/if}
      <hr class="hairline" />
      <p class="panel-h">Mark seats</p>
      <div class="brushes">
        {#each MARKS as m (m.id)}
          <button class="brush" aria-pressed={brushIs(m.id)} onclick={() => ctrl.setBrush(m.id)}>
            {@html MARK_ICONS[m.id]}<span>{m.label} <kbd>{m.key}</kbd><small>{m.desc}</small></span>
          </button>
        {/each}
      </div>
      <hr class="hairline" />
      <ul class="tips">
        <li>Tap a seat, or drag across seats.</li>
        <li>Tap a row letter for the whole row.</li>
        <li>Tap the middle of a table for the whole table.</li>
        {#if !ctrl.touch}<li>Drag on an empty spot to paint everything in a box.</li>{/if}
      </ul>
    {/if}
  </aside>

  <section class="stage-wrap" aria-label="The room">
    <div class="toolbar">
      <button class="btn ghost" onclick={leave}>Close</button>
      <span class="tb-sep" aria-hidden="true"></span>
      <div class="steps" role="group" aria-label="Steps">
        <button aria-pressed={ui.step === "layout"} onclick={() => ctrl.setStep("layout")}><b>1</b>Lay out the room</button>
        <button aria-pressed={ui.step === "seats"} onclick={() => ctrl.setStep("seats")}><b>2</b>Seats and prices</button>
      </div>
      <span class="tb-spacer"></span>
      <div class="tb-group">
        <button class="btn ghost icon-btn" aria-label="Undo" title="Undo ({ctrl.mod}+Z)" disabled={!ui.canUndo} onclick={() => ctrl.undo()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 5H9a3 3 0 0 1 0 6H6M4 5l2.5-2.5M4 5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
        <button class="btn ghost icon-btn" aria-label="Redo" title="Redo ({ctrl.mod}+Shift+Z)" disabled={!ui.canRedo} onclick={() => ctrl.redo()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M10 5H5a3 3 0 0 0 0 6h3M10 5L7.5 2.5M10 5L7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
      </div>
      <span class="tb-sep" aria-hidden="true"></span>
      <div class="tb-group">
        <button class="btn icon-btn" aria-label="Zoom out" onclick={() => ctrl.zoomBy(1 / 1.2)}>&minus;</button>
        <button class="btn icon-btn" aria-label="Zoom in" onclick={() => ctrl.zoomBy(1.2)}>+</button>
        <button class="btn icon-btn" aria-label="Fit the room on screen" title="Fit the room on screen" onclick={() => ctrl.fit()}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
      </div>
    </div>
    <div class="hint" aria-live="polite">
      {#each hint as seg, i (i)}{#if typeof seg === "string"}{seg}{:else}<kbd>{seg.k}</kbd>{/if}{/each}
    </div>
    <div class="canvas-shell" bind:this={shellEl}>
      <div class="canvas" bind:this={canvasEl}>
        <svg id="seat-build-svg" bind:this={svgEl} aria-label="Seating plan"></svg>
      </div>
      <div class="ctx" role="toolbar" aria-label="Selected on the plan" bind:this={ctxEl} hidden={ui.step !== "layout" || !ui.sel.length || ui.dragging}>
        {#if ui.sel.length > 1}
          {@const seated = ui.sel.filter((x) => x.kind === "rows" || x.kind === "table")}
          <span class="count">{ui.sel.length} selected</span>
          <span class="ctx-sep" aria-hidden="true"></span>
          {#if seated.length}
            <span class="mini">Seats
              <span class="stepper" role="group" aria-label="Seats at each">
                <button aria-label="One fewer seat at each" onclick={() => ctrl.changeSeats(-1)}>&minus;</button><output>each</output><button aria-label="One more seat at each" onclick={() => ctrl.changeSeats(1)}>+</button>
              </span>
            </span>
            {@render bandSelect()}
            <span class="ctx-sep" aria-hidden="true"></span>
          {/if}
          <button class="btn ghost" onclick={() => ctrl.lineUpSel()}>Line up</button>
          {#if ui.sel.length > 2}<button class="btn ghost" onclick={() => ctrl.spreadSel()}>Space evenly</button>{/if}
        {:else if ui.sel.length === 1}
          {@const it = ui.sel[0]}
          {#if it.kind === "rows"}
            <input class="input name" aria-label="Section name" value={it.name} oninput={(e) => ctrl.editText("name", (e.currentTarget as HTMLInputElement).value)} onchange={() => ctrl.endEdit()} />
            <span class="mini">Seats per row
              <span class="stepper" role="group" aria-label="Seats per row">
                <button aria-label="One fewer seat per row" onclick={() => ctrl.changeSeats(-1)}>&minus;</button><output>{longestRow(it)}</output><button aria-label="One more seat per row" onclick={() => ctrl.changeSeats(1)}>+</button>
              </span>
            </span>
            <span class="mini">Rows
              <span class="stepper" role="group" aria-label="Rows">
                <button aria-label="One fewer row" onclick={() => ctrl.changeRows(-1)}>&minus;</button><output>{it.rows.length}</output><button aria-label="One more row" onclick={() => ctrl.changeRows(1)}>+</button>
              </span>
            </span>
            <label class="mini">Curve <input type="range" min="0" max="100" step="1" value={it.curve} oninput={(e) => ctrl.editText("curve", (e.currentTarget as HTMLInputElement).value)} onchange={() => ctrl.endEdit()} /></label>
            {@render bandSelect()}
            <label class="mini">Seat 1
              <select class="input" value={it.numberFrom} onchange={(e) => ctrl.setNumberFrom((e.currentTarget as HTMLSelectElement).value as "left" | "right")}>
                <option value="left">on the left</option><option value="right">on the right</option>
              </select>
            </label>
            <label class="mini">Count
              <select class="input" value={it.numberStep === 2 ? "2" : "1"} onchange={(e) => ctrl.setNumberStep((e.currentTarget as HTMLSelectElement).value === "2" ? 2 : 1)}>
                <option value="1">1, 2, 3</option><option value="2">in twos (odd or even)</option>
              </select>
            </label>
            <label class="mini">from
              <input class="input num" type="number" min="1" value={it.numberStart ?? 1} onchange={(e) => ctrl.setNumberStart(Number((e.currentTarget as HTMLInputElement).value))} />
            </label>
          {:else if it.kind === "table"}
            <input class="input name" aria-label="Table name" value={it.name} oninput={(e) => ctrl.editText("name", (e.currentTarget as HTMLInputElement).value)} onchange={() => ctrl.endEdit()} />
            <span class="mini">Seats
              <span class="stepper" role="group" aria-label="Seats">
                <button aria-label="One fewer seat" onclick={() => ctrl.changeSeats(-1)}>&minus;</button><output>{it.seats.length}</output><button aria-label="One more seat" onclick={() => ctrl.changeSeats(1)}>+</button>
              </span>
            </span>
            <span class="seg" role="group" aria-label="Table shape">
              {#each [["round", "Round"], ["long", "Long"], ["head", "One side"]] as [v, l] (v)}
                <button aria-pressed={(it as TableItem).shape === v} onclick={() => ctrl.setShape(v as TableItem["shape"])}>{l}</button>
              {/each}
            </span>
            {@render bandSelect()}
          {:else}
            <input class="input name" aria-label="Text on the plan" value={it.text} oninput={(e) => ctrl.editText("text", (e.currentTarget as HTMLInputElement).value)} onchange={() => ctrl.endEdit()} />
          {/if}
        {/if}
        {#if ui.sel.length}
          <span class="ctx-sep" aria-hidden="true"></span>
          <button class="btn ghost" title="{ctrl.mod}+D" onclick={() => ctrl.duplicateSel()}>Duplicate</button>
          <button class="btn ghost danger" title="Delete key" onclick={() => ctrl.deleteSel()}>Delete</button>
        {/if}
      </div>
    </div>
  </section>

  <footer class="summary">
    <div class="stat"><b>{ui.counts.forSale}</b><span>seats on sale</span></div>
    <div class="stat"><b>{ui.counts.held}</b><span>held</span></div>
    <div class="stat"><b>{ui.counts.wheel}</b><span>wheelchair spaces</span></div>
    <div class="stat"><b>{ui.counts.tables}</b><span>tables</span></div>
    {#if showPrices}<div class="stat"><b>{fmtMoney(potential)}</b><span>if every seat on sale sells</span></div>{/if}
    <span class="spacer"></span>
    <button class="btn" onclick={() => (dialog = "preview")}>See it as a buyer</button>
    <button class="btn primary" onclick={() => (dialog = "check")}>Check and finish</button>
  </footer>

  <div class="bubble" aria-hidden="true" bind:this={bubbleEl}></div>
  {#if toastMsg}<div class="toast" role="status">{toastMsg}</div>{/if}

  {#if dialog === "templates"}
    <div class="scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) dialog = ""; }}>
      <div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="sb-tpl-h">
        <h2 id="sb-tpl-h">Start from a layout</h2>
        <p class="lead">Pick the closest match to your room, then move things until it fits. This replaces what's on the plan now - undo brings it back.</p>
        <div class="tpl-grid">
          {#each LAYOUT_TEMPLATES as t (t.id)}
            {@const l = t.make()}
            {@const n = canonicalSeats(l).length}
            <button class="tpl" onclick={() => applyTemplate(t.id)}>
              <svg use:thumb={l} aria-hidden="true"></svg>
              <b>{t.name}</b><small>{t.description}{n ? `. ${n} seats` : ""}</small>
            </button>
          {/each}
        </div>
        <div class="actions"><button class="btn ghost" onclick={() => (dialog = "")}>Cancel</button></div>
      </div>
    </div>
  {/if}

  {#if dialog === "preview"}
    <div class="scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) dialog = ""; }}>
      <div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="sb-prev-h">
        <h2 id="sb-prev-h">What buyers see</h2>
        <p class="lead">Every seat on sale, as the map shows it before anyone buys. Held seats look taken.</p>
        <svg class="preview" use:preview aria-label="Seat map preview"></svg>
        <div class="legend">
          {#each ui.bands as b (b.id)}
            <span>{@html swatchSvg(palette, b.style, 12)}{b.name}{#if showPrices && priceDraft[b.id]} <span class="mono">{currencySymbol}{priceDraft[b.id]}</span>{/if}</span>
          {/each}
          <span>{@html MARK_ICONS.wheel}Wheelchair space</span>
        </div>
        <div class="actions"><button class="btn" onclick={() => (dialog = "")}>Back to the plan</button></div>
      </div>
    </div>
  {/if}

  {#if dialog === "check" && check}
    <div class="scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) dialog = ""; }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sb-check-h">
        <h2 id="sb-check-h">Check your plan</h2>
        <p class="lead">{check.counts.forSale + check.counts.held} seats, {check.counts.forSale} on sale and {check.counts.held} held.</p>
        <div class="fixed-warning">
          <b>Seats can't be added once tickets are on sale.</b>
          <span class="note">Add every seat the room has. If you're unsure about some, mark them held: you can put held seats on sale whenever you like, and move people to other seats later.</span>
        </div>
        {#if check.problems.length}
          <p class="panel-h">Fix these first</p>
          <ul class="checks">
            {#each check.problems as p, i (i)}
              <li class="stop"><span class="dot"></span><span>
                {#if p.kind === "duplicate-label"}Two seats would both be called "{p.label}". Rename a section or table, or a row.
                {:else if p.kind === "no-seats"}There are no seats on the plan yet.
                {:else}Something on the plan can't be saved. Undo the last change and try again.{/if}
              </span></li>
            {/each}
          </ul>
        {/if}
        <table class="tally">
          <thead><tr><th>Price</th><th class="n">Seats</th>{#if showPrices}<th class="n">Each</th><th class="n">If all sell</th>{/if}</tr></thead>
          <tbody>
            {#each ui.bands as b (b.id)}
              {@const n = check.counts.byBand[b.id] ?? 0}
              {@const each = parseFloat(priceDraft[b.id] ?? "") || 0}
              <tr><td>{b.name}</td><td class="n">{n}</td>{#if showPrices}<td class="n">{fmtMoney(each)}</td><td class="n">{fmtMoney(n * each)}</td>{/if}</tr>
            {/each}
          </tbody>
        </table>
        <p class="panel-h">Worth a second look</p>
        <ul class="checks">
          {#each check.notes as n, i (i)}
            <li class:warn={n.warn}><span class="dot"></span><span>{n.text}</span></li>
          {:else}
            <li><span class="dot"></span><span>Nothing stands out. Have a last look as a buyer before you use it.</span></li>
          {/each}
        </ul>
        <div class="actions">
          <button class="btn ghost" onclick={() => (dialog = "")}>Back to the plan</button>
          <button class="btn primary" disabled={check.problems.length > 0} onclick={finish}>{finishLabel}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if dialog === "leave"}
    <div class="scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) dialog = ""; }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sb-leave-h">
        <h2 id="sb-leave-h">Leave without using these changes?</h2>
        <p class="lead">The plan goes back to how it was when you opened it.</p>
        <div class="actions">
          <button class="btn ghost" onclick={() => (dialog = "")}>Keep editing</button>
          <button class="btn danger-solid" onclick={onclose}>Leave</button>
        </div>
      </div>
    </div>
  {/if}
</div>

{#snippet bandSelect()}
  <label class="mini">Price
    <select class="input" value={ui.selBand} onchange={(e) => ctrl.setItemsBand((e.currentTarget as HTMLSelectElement).value)}>
      {#if !ui.selBand}<option value="" disabled>Mixed</option>{/if}
      {#each ui.bands as b (b.id)}<option value={b.id}>{b.name}{showPrices && priceDraft[b.id] ? `, ${currencySymbol}${priceDraft[b.id]}` : ""}</option>{/each}
    </select>
  </label>
{/snippet}

<style>
  .seat-builder {
    position: fixed; inset: 0; z-index: 50; display: grid; background: var(--bg); color: var(--text);
    grid-template-columns: 264px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto;
    font-size: 14px; line-height: 1.45;
  }
  .side { grid-row: 1; grid-column: 1; border-right: 1px solid var(--border); overflow: auto; padding: 14px; }
  .stage-wrap { grid-row: 1; grid-column: 2; display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; }
  .summary { grid-row: 2; grid-column: 1 / -1; display: flex; align-items: center; gap: 18px; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg-surface); flex-wrap: wrap; }

  .btn { border: 1px solid var(--border-hover); background: var(--bg-surface); border-radius: var(--radius-md); padding: 7px 12px; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; color: var(--text); font: inherit; cursor: pointer; }
  .btn:hover { border-color: var(--text-muted); }
  .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  .btn.primary:hover { background: var(--accent-hover); }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
  .btn.ghost:hover { color: var(--text); border-color: var(--border); }
  .btn.danger { color: var(--error); }
  .btn.danger-solid { background: var(--error); border-color: var(--error); color: var(--accent-ink); font-weight: 600; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.wide { width: 100%; justify-content: center; }
  .icon-btn { width: 30px; height: 30px; padding: 0; justify-content: center; }
  .input { background: var(--bg-input); border: 1px solid var(--border-hover); border-radius: var(--radius-md); padding: 7px 9px; width: 100%; color: var(--text); font: inherit; }
  .input:focus { outline: none; border-color: var(--accent); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .note { color: var(--text-muted); font-size: 12px; margin: 0; }
  .note.tight { margin: -4px 0 10px; }
  .panel-h { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; font-weight: 500; }
  .hairline { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .plan-name { margin-bottom: 12px; }
  .plan-name input { font: inherit; font-size: 17px; font-weight: 600; color: var(--text); background: transparent; border: 1px solid transparent; padding: 4px 6px; margin-left: -7px; border-radius: var(--radius-md); width: calc(100% + 7px); }
  .plan-name input:hover { border-color: var(--border); }
  .plan-name input:focus { outline: none; border-color: var(--accent); }

  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .tile { display: grid; justify-items: center; gap: 5px; padding: 10px 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12.5px; text-align: center; cursor: grab; user-select: none; -webkit-user-select: none; }
  .tile:hover { border-color: var(--border-hover); color: var(--text); }
  .tile:active { cursor: grabbing; }
  @media (pointer: fine) { .tile { touch-action: none; } }

  .band-row { display: grid; grid-template-columns: 28px 1fr 84px; gap: 6px; align-items: center; padding: 4px; border: 1px solid transparent; border-radius: var(--radius-md); }
  .band-row.no-price { grid-template-columns: 28px 1fr; }
  .band-row.on { border-color: var(--accent); background: var(--accent-subtle); }
  .band-row .input { padding: 5px 7px; }
  .band-pick { width: 28px; height: 28px; display: grid; place-items: center; background: transparent; border: 0; padding: 0; cursor: pointer; }
  .price-in { display: flex; align-items: center; gap: 4px; }
  .band-count { color: var(--text-muted); font-size: 12px; margin: 0 0 6px 38px; }
  .brushes { display: grid; gap: 6px; }
  .brush { display: grid; grid-template-columns: 22px 1fr; gap: 9px; align-items: center; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); text-align: left; width: 100%; color: var(--text-secondary); font: inherit; cursor: pointer; }
  .brush:hover { border-color: var(--border-hover); color: var(--text); }
  .brush[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-subtle); color: var(--text); }
  .brush small { display: block; color: var(--text-muted); font-size: 11.5px; line-height: 1.35; }
  kbd { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 4px; }
  .tips { margin: 0; padding: 0 0 0 16px; color: var(--text-muted); font-size: 12px; display: grid; gap: 4px; }

  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .steps { display: inline-flex; border: 1px solid var(--border-hover); border-radius: var(--radius-md); overflow: hidden; }
  .steps button { background: transparent; border: 0; border-right: 1px solid var(--border-hover); padding: 6px 12px; color: var(--text-secondary); display: inline-flex; gap: 8px; align-items: center; font: inherit; cursor: pointer; }
  .steps button:last-child { border-right: 0; }
  .steps button b { font-family: var(--font-mono); font-weight: 500; width: 19px; height: 19px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--border-hover); font-size: 11px; }
  .steps button[aria-pressed="true"] { background: var(--bg-elevated); color: var(--text); }
  .steps button[aria-pressed="true"] b { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .tb-spacer { flex: 1; }
  .tb-group { display: inline-flex; gap: 4px; }
  .tb-sep { width: 1px; height: 22px; background: var(--border); margin: 0 2px; }
  .hint { padding: 7px 14px; color: var(--text-secondary); font-size: 13px; border-bottom: 1px solid var(--border); min-height: 34px; }
  .hint kbd { font-size: 11px; color: var(--text); border-color: var(--border-hover); }

  .canvas-shell { position: relative; min-height: 0; }
  .canvas { position: absolute; inset: 0; overflow: auto; touch-action: pan-x pan-y; background: radial-gradient(circle at 1px 1px, var(--bg-surface-hover) 1px, transparent 0) 0 0 / 22px 22px, var(--bg); }
  .canvas :global(svg) { display: block; margin: 0 auto; user-select: none; -webkit-user-select: none; }
  .canvas:global(.drop) { box-shadow: inset 0 0 0 2px var(--accent); }

  /* The room is drawn imperatively (@woco/seatmap): its behaviour is styled here. */
  .canvas :global(.mode-layout .it) { cursor: move; outline: none; touch-action: none; }
  .canvas :global(.mode-layout .it:hover .hover-box) { stroke: var(--border-hover); stroke-dasharray: 3 3; }
  .canvas :global(.mode-layout .it:focus-visible .hover-box) { stroke: var(--accent); stroke-dasharray: 2 2; }
  .canvas :global(.mode-layout .it.is-sel .hover-box) { stroke: var(--accent); }
  .canvas :global(.handle) { touch-action: none; }
  .canvas :global(.h-seats), .canvas :global(.h-tseats) { cursor: ew-resize; }
  .canvas :global(.h-rows) { cursor: ns-resize; }
  .canvas :global(.h-resize) { cursor: nwse-resize; }
  .canvas :global(.h-rotate) { cursor: grab; }
  .canvas :global(.mode-seats .seat) { cursor: crosshair; touch-action: none; }
  .canvas :global(.mode-seats [data-rowlab]), .canvas :global(.mode-seats .tabletop) { cursor: pointer; touch-action: none; }
  .canvas :global(.mode-seats [data-rowlab]:hover) { fill: var(--accent); }
  .canvas :global(.mode-seats .tabletop:hover) { stroke: var(--accent); }

  .ctx { position: absolute; z-index: 5; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: min(780px, calc(100% - 16px)); padding: 6px 8px; background: var(--bg-elevated); border: 1px solid var(--border-hover); border-radius: var(--radius-lg); }
  .ctx[hidden] { display: none; }
  .ctx .input { width: auto; padding: 4px 7px; height: 30px; }
  .ctx .name { width: 118px; font-weight: 500; }
  .ctx .num { width: 64px; }
  .ctx select.input { padding: 3px 6px; max-width: 160px; }
  .mini { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
  .count { color: var(--text-secondary); font-size: 13px; padding: 0 4px; }
  .ctx input[type="range"] { accent-color: var(--accent); width: 84px; }
  .ctx .btn { padding: 4px 9px; height: 30px; }
  .ctx-sep { width: 1px; align-self: stretch; background: var(--border-hover); margin: 2px; }
  .stepper { display: inline-flex; align-items: stretch; border: 1px solid var(--border-hover); border-radius: var(--radius-md); height: 30px; }
  .stepper button { background: transparent; border: 0; width: 30px; color: var(--text); font: inherit; cursor: pointer; }
  .stepper button:hover { background: var(--bg-elevated); }
  .stepper output { min-width: 38px; padding: 0 4px; display: grid; place-items: center; border-inline: 1px solid var(--border-hover); font-family: var(--font-mono); font-size: 13px; }
  .seg { display: inline-flex; border: 1px solid var(--border-hover); border-radius: var(--radius-md); overflow: hidden; }
  .seg button { background: transparent; border: 0; padding: 5px 10px; color: var(--text-secondary); border-right: 1px solid var(--border-hover); font: inherit; cursor: pointer; }
  .seg button:last-child { border-right: 0; }
  .seg button[aria-pressed="true"] { background: var(--bg-elevated); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }

  .bubble { position: fixed; z-index: 60; pointer-events: none; background: var(--bg); border: 1px solid var(--accent); color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 3px 7px; border-radius: var(--radius-md); display: none; }
  .stat { display: grid; }
  .stat b { font-family: var(--font-mono); font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--text-muted); font-size: 12px; }
  .spacer { flex: 1; }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--bg-elevated); border: 1px solid var(--accent); padding: 10px 14px; border-radius: var(--radius-md); z-index: 70; max-width: calc(100% - 32px); }

  .scrim { position: fixed; inset: 0; background: rgba(5, 5, 4, 0.72); display: grid; place-items: center; z-index: 65; padding: 16px; }
  .dialog { width: min(560px, 100%); max-height: calc(100% - 32px); overflow: auto; background: var(--bg-surface); border: 1px solid var(--border-hover); border-radius: var(--radius-lg); padding: 20px; }
  .dialog.wide { width: min(860px, 100%); }
  .dialog h2 { font-size: 20px; margin: 0 0 6px; font-weight: 600; letter-spacing: -0.02em; }
  .lead { color: var(--text-secondary); margin: 0 0 16px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
  .tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .tpl { display: grid; gap: 4px; text-align: left; padding: 10px; border: 1px solid var(--border-hover); border-radius: var(--radius-md); background: var(--bg); color: var(--text); font: inherit; cursor: pointer; }
  .tpl:hover, .tpl:focus-visible { border-color: var(--accent); }
  .tpl svg { width: 100%; height: 118px; display: block; background: var(--bg-surface); border-radius: var(--radius-sm); margin-bottom: 4px; }
  .tpl small { color: var(--text-muted); }
  .preview { width: 100%; height: min(60vh, 520px); display: block; background: var(--bg); border-radius: var(--radius-md); }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; padding: 10px 0 0; color: var(--text-secondary); font-size: 12px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .fixed-warning { border: 1px solid var(--accent); background: var(--accent-subtle); padding: 12px 14px; border-radius: var(--radius-md); display: grid; gap: 4px; margin-bottom: 14px; }
  .fixed-warning b { font-size: 15px; }
  .tally { width: 100%; border-collapse: collapse; margin: 14px 0; }
  .tally th, .tally td { text-align: left; padding: 7px 4px; border-bottom: 1px solid var(--border); }
  .tally th { color: var(--text-muted); font-weight: 500; font-size: 12px; }
  .tally .n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .checks { display: grid; gap: 6px; margin: 0 0 6px; padding: 0; list-style: none; }
  .checks li { display: grid; grid-template-columns: 16px 1fr; gap: 8px; color: var(--text-secondary); }
  .checks .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--text-muted); }
  .checks li.warn .dot { background: var(--warning); }
  .checks li.stop .dot { background: var(--error); }
  .checks li.stop { color: var(--text); }

  @media (max-width: 760px) {
    /* On a phone the page scrolls: the room gets most of the screen, the tools sit under it. */
    .seat-builder { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto; overflow: auto; align-content: start; }
    .stage-wrap { grid-row: 1; grid-column: 1; height: 72svh; }
    .side { grid-row: 2; grid-column: 1; border-right: 0; border-top: 1px solid var(--border); overflow: visible; }
    .summary { grid-row: 3; }
    .steps button { padding: 6px 9px; }
    .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .ctx { left: 0 !important; right: 0; bottom: 0; top: auto !important; max-width: none; border-radius: 0; flex-wrap: nowrap; overflow-x: auto; border-width: 1px 0 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
