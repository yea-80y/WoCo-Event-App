<script module lang="ts">
  /** One assembled cart line — maps 1:1 to the server's OrderLineRequest. */
  export interface PosCartLine {
    productId: string;
    name: string;
    /** Decimal string, snapshotted at tap time (display only; server reprices). */
    unitPrice: string;
    qty: number;
  }

  export interface PlaceAndChargeResult {
    ok: boolean;
    /** Pickup / short code on success. */
    code?: string;
    error?: string;
  }
</script>

<script lang="ts">
  /**
   * WoCo POS — festival tap-and-go (Concrete & Acid). The headline spend-permission
   * surface: the customer authorised ONCE at entry (a capped, time-boxed permission),
   * so each round is a single operator tap — no per-round customer prompt.
   *
   * This view owns assembly + UX only. The parent owns data/transport: `placeAndCharge`
   * creates the order and draws against the permission (api/shop-spend-permission). All
   * funds/signature logic stays out of here by design.
   */
  import type { Shop, Product, FiatCurrency } from "@woco/shared";
  import ProductCard from "../ProductCard.svelte";

  interface Props {
    shop: Shop;
    products: Product[];
    placeAndCharge: (lines: PosCartLine[], permissionId: string) => Promise<PlaceAndChargeResult>;
  }

  let { shop, products, placeAndCharge }: Props = $props();

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  function money(minor: number, ccy: FiatCurrency): string {
    const sym = SYMBOLS[ccy] ?? "";
    const body = (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym ? `${sym}${body}` : `${body} ${ccy}`;
  }
  /** Decimal string → integer minor units (display arithmetic only). */
  const toMinor = (s: string) => Math.round(Number(s) * 100);

  // --- catalog: POS-visible, grouped by category for fast finger-finding.
  const posProducts = $derived(
    products.filter((p) => p.active && (!p.channels || p.channels.includes("pos"))),
  );
  const groups = $derived.by(() => {
    const byCat = new Map<string, { label: string; items: Product[] }>();
    const labelFor = (id?: string) =>
      shop.categories.find((c) => c.id === id)?.label ?? "Other";
    for (const p of [...posProducts].sort((a, b) => a.sortIndex - b.sortIndex)) {
      const key = p.categoryId ?? "_";
      if (!byCat.has(key)) byCat.set(key, { label: labelFor(p.categoryId), items: [] });
      byCat.get(key)!.items.push(p);
    }
    return [...byCat.values()];
  });

  // --- cart
  let cart = $state<Map<string, PosCartLine>>(new Map());
  const lines = $derived([...cart.values()]);
  const itemCount = $derived(lines.reduce((n, l) => n + l.qty, 0));
  const totalMinor = $derived(lines.reduce((n, l) => n + toMinor(l.unitPrice) * l.qty, 0));

  function add(p: Product) {
    const next = new Map(cart);
    const existing = next.get(p.productId);
    if (existing) existing.qty += 1;
    else next.set(p.productId, { productId: p.productId, name: p.name, unitPrice: p.price, qty: 1 });
    cart = next;
  }
  function bump(id: string, delta: number) {
    const next = new Map(cart);
    const l = next.get(id);
    if (!l) return;
    l.qty += delta;
    if (l.qty <= 0) next.delete(id);
    cart = next;
  }
  function clearCart() {
    cart = new Map();
  }

  // --- charge flow
  type Phase = "shop" | "identify" | "charging" | "done";
  let phase = $state<Phase>("shop");
  let permissionId = $state("");
  let error = $state<string | null>(null);
  let lastCode = $state<string | null>(null);

  function openCharge() {
    if (itemCount === 0) return;
    error = null;
    phase = "identify";
  }
  function cancelCharge() {
    if (phase === "charging") return;
    phase = "shop";
    error = null;
  }
  async function take() {
    if (!permissionId.trim() || phase === "charging") return;
    error = null;
    phase = "charging";
    try {
      const res = await placeAndCharge(lines, permissionId.trim());
      if (res.ok) {
        lastCode = res.code ?? null;
        phase = "done";
        clearCart();
        permissionId = "";
      } else {
        error = res.error ?? "Payment failed";
        phase = "identify";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Payment failed";
      phase = "identify";
    }
  }
  function newOrder() {
    lastCode = null;
    error = null;
    phase = "shop";
  }
</script>

<div class="pos">
  <!-- ===== catalog pane ===== -->
  <section class="catalog">
    <header class="cat-head">
      <span class="kicker">{shop.name} · Point of sale</span>
      <span class="live mono"><i class="dot"></i> Spend permission rail</span>
    </header>

    {#if posProducts.length === 0}
      <div class="empty">No products on the POS channel yet.</div>
    {:else}
      {#each groups as g}
        <div class="group">
          <h2 class="kicker kicker--plain">{g.label}</h2>
          <div class="grid">
            {#each g.items as p (p.productId)}
              <ProductCard product={p} currency={shop.currency} variant="pos" onAdd={add} />
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </section>

  <!-- ===== order rail ===== -->
  <aside class="rail">
    <div class="rail-head">
      <span class="kicker kicker--plain">Current order</span>
      {#if itemCount > 0}
        <button class="link" onclick={clearCart} disabled={phase === "charging"}>Clear</button>
      {/if}
    </div>

    <div class="ticket">
      {#if lines.length === 0}
        <div class="ticket-empty">
          <span class="big mono">{money(0, shop.currency)}</span>
          <p>Tap products to build the order.</p>
        </div>
      {:else}
        <ul class="lines">
          {#each lines as l (l.productId)}
            <li>
              <div class="l-main">
                <span class="l-name">{l.name}</span>
                <span class="l-sub mono">{money(toMinor(l.unitPrice), shop.currency)} each</span>
              </div>
              <div class="stepper">
                <button onclick={() => bump(l.productId, -1)} disabled={phase === "charging"} aria-label="Remove one">–</button>
                <span class="qty mono">{l.qty}</span>
                <button onclick={() => bump(l.productId, 1)} disabled={phase === "charging"} aria-label="Add one">+</button>
              </div>
              <span class="l-amt mono">{money(toMinor(l.unitPrice) * l.qty, shop.currency)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="rail-foot">
      <div class="total">
        <span class="t-label kicker kicker--plain">Total · {itemCount} {itemCount === 1 ? "item" : "items"}</span>
        <span class="t-amt mono">{money(totalMinor, shop.currency)}</span>
      </div>
      <button class="btn btn--primary btn--lg charge" onclick={openCharge} disabled={itemCount === 0}>
        Charge {money(totalMinor, shop.currency)}
      </button>
    </div>

    <!-- ===== charge overlay ===== -->
    {#if phase !== "shop"}
      <div class="overlay">
        {#if phase === "done"}
          <div class="done">
            <span class="ok-mark" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square">
                <path d="M4 11.5l4.5 4.5L18 6.5" />
              </svg>
            </span>
            <span class="kicker">Paid · no customer prompt</span>
            {#if lastCode}
              <span class="code mono">{lastCode}</span>
              <p class="code-hint">Pickup code — read it back to the customer.</p>
            {:else}
              <p class="code-hint">Order settled.</p>
            {/if}
            <button class="btn btn--primary btn--lg" onclick={newOrder}>New order</button>
          </div>
        {:else}
          <div class="identify">
            <div class="id-head">
              <span class="kicker">Take payment</span>
              <span class="id-amt mono">{money(totalMinor, shop.currency)}</span>
            </div>
            <p class="id-note">Customer tapped in at entry — scan or enter their permission to draw this round. No approval prompt on their device.</p>
            <label class="field">
              <span class="f-label kicker kicker--plain">Customer permission</span>
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="input mono"
                bind:value={permissionId}
                placeholder="scan QR or paste permission id"
                disabled={phase === "charging"}
                autofocus
                onkeydown={(e) => e.key === "Enter" && take()}
              />
            </label>
            {#if error}<div class="err mono">{error}</div>{/if}
            <div class="id-actions">
              <button class="btn btn--ghost" onclick={cancelCharge} disabled={phase === "charging"}>Back</button>
              <button class="btn btn--primary btn--lg" onclick={take} disabled={!permissionId.trim() || phase === "charging"}>
                {phase === "charging" ? "Drawing…" : `Take ${money(totalMinor, shop.currency)}`}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </aside>
</div>

<style>
  .pos {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1px;
    background: var(--border);
    height: 100%;
    min-height: 0;
  }

  /* ---- catalog ---- */
  .catalog { background: var(--bg); padding: 1rem 1.25rem 2rem; overflow-y: auto; }
  .cat-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
  .live { font-size: 0.625rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.1em; display: inline-flex; align-items: center; gap: 0.4375rem; }
  .live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 var(--accent); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--accent-subtle); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

  .group { margin-bottom: 1.5rem; }
  .group h2 { margin: 0 0 0.625rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.625rem; }
  .empty { color: var(--text-muted); font-size: 0.875rem; padding: 3rem 0; text-align: center; }

  /* ---- order rail ---- */
  .rail { position: relative; background: var(--bg-surface); display: flex; flex-direction: column; min-height: 0; }
  .rail-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.125rem 0.75rem; border-bottom: 1px solid var(--border); }
  .link { background: none; border: none; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer; padding: 0; }
  .link:hover { color: var(--error); }

  .ticket { flex: 1; overflow-y: auto; padding: 0.5rem 0; min-height: 0; }
  .ticket-empty { padding: 2.5rem 1.125rem; text-align: center; color: var(--text-muted); }
  .ticket-empty .big { display: block; font-size: 2rem; font-weight: 700; color: var(--text-dim); margin-bottom: 0.5rem; letter-spacing: -0.02em; }
  .ticket-empty p { margin: 0; font-size: 0.8125rem; }

  .lines { list-style: none; margin: 0; padding: 0; }
  .lines li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 0.75rem; padding: 0.625rem 1.125rem; border-bottom: 1px solid var(--border); }
  .l-main { min-width: 0; }
  .l-name { display: block; color: var(--text); font-size: 0.875rem; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l-sub { display: block; color: var(--text-muted); font-size: 0.625rem; margin-top: 0.125rem; }
  .stepper { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .stepper button { width: 1.5rem; height: 1.5rem; background: none; border: none; color: var(--text-secondary); font-size: 1rem; line-height: 1; cursor: pointer; }
  .stepper button:hover { color: var(--accent); background: var(--bg-surface-hover); }
  .stepper .qty { min-width: 1.5rem; text-align: center; font-size: 0.8125rem; font-weight: 600; color: var(--text); }
  .l-amt { font-size: 0.875rem; font-weight: 600; color: var(--text); min-width: 3rem; text-align: right; }

  .rail-foot { border-top: 1px solid var(--border); padding: 0.875rem 1.125rem 1.125rem; }
  .total { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.75rem; }
  .t-amt { font-size: 1.625rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
  .charge { width: 100%; justify-content: center; }

  /* ---- charge overlay ---- */
  .overlay { position: absolute; inset: 0; background: var(--bg-surface); display: flex; flex-direction: column; justify-content: center; padding: 1.25rem; animation: rise 0.16s ease; }
  @keyframes rise { from { opacity: 0; transform: translateY(0.5rem); } to { opacity: 1; transform: none; } }

  .identify, .done { display: flex; flex-direction: column; }
  .id-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.75rem; }
  .id-amt { font-size: 1.5rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
  .id-note { margin: 0 0 1rem; font-size: 0.8125rem; line-height: 1.4; color: var(--text-secondary); }
  .field { display: block; margin-bottom: 0.875rem; }
  .f-label { display: block; margin-bottom: 0.375rem; }
  .input { width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); padding: 0.625rem 0.75rem; font-size: 0.8125rem; }
  .input:focus { outline: none; border-color: var(--accent); }
  .err { background: var(--error-subtle); color: var(--error); border: 1px solid var(--error); border-radius: var(--radius-sm); padding: 0.5rem 0.625rem; font-size: 0.6875rem; margin-bottom: 0.875rem; }
  .id-actions { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem; }
  .id-actions .btn--lg { justify-content: center; }

  .done { align-items: center; text-align: center; }
  .ok-mark { width: 3rem; height: 3rem; display: grid; place-items: center; color: var(--accent-ink); background: var(--accent); border-radius: var(--radius-md); margin-bottom: 0.875rem; }
  .code { font-size: 2.25rem; font-weight: 700; color: var(--accent-text); letter-spacing: 0.04em; margin: 0.5rem 0 0.25rem; }
  .code-hint { margin: 0 0 1.25rem; font-size: 0.8125rem; color: var(--text-muted); }

  @media (max-width: 720px) {
    .pos { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
    .rail { max-height: 50vh; }
  }
</style>
