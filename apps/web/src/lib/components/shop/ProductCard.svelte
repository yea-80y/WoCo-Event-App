<script lang="ts">
  /**
   * Product card — the reused visual atom of the WoCo shop (Concrete & Acid).
   *
   * Two variants share one money/stock language:
   *  - "storefront": image + category kicker + name + price/sale + stock, hover "Add".
   *  - "pos":        compact tappable tile (big price, name) for the operator grid.
   *
   * Price is the loudest element; the Add affordance is the single lime surface.
   * Sold-out is the only place vermillion appears here.
   */
  import type { Product, FiatCurrency } from "@woco/shared";

  interface Props {
    product: Product;
    currency: FiatCurrency;
    variant?: "storefront" | "pos";
    /** Category label (storefront only) — shown as a kicker. */
    categoryLabel?: string;
    disabled?: boolean;
    onAdd?: (product: Product) => void;
  }

  let {
    product,
    currency,
    variant = "storefront",
    categoryLabel,
    disabled = false,
    onAdd,
  }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

  /** Format a decimal-string amount for display only (never used for arithmetic). */
  function formatMoney(amount: string, ccy: FiatCurrency): string {
    const sym = SYMBOLS[ccy] ?? "";
    const n = Number(amount);
    if (!Number.isFinite(n)) return sym + amount;
    const body = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sym ? `${sym}${body}` : `${body} ${ccy}`;
  }

  const soldOut = $derived(product.stock != null && product.stock <= 0);
  const lowStock = $derived(product.stock != null && product.stock > 0 && product.stock <= 5);
  const hasVariants = $derived(!!product.variants && product.variants.length > 0);
  const onSale = $derived(
    !!product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price),
  );
  const blocked = $derived(disabled || soldOut);

  function add() {
    if (blocked) return;
    onAdd?.(product);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      add();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="pc pc--{variant}"
  class:blocked
  class:sold-out={soldOut}
  role="button"
  tabindex={blocked ? -1 : 0}
  aria-disabled={blocked}
  onclick={add}
  onkeydown={onKey}
>
  {#if variant === "storefront"}
    <div class="media">
      {#if product.imageRef}
        <img src="{BEE_GATEWAY}/bytes/{product.imageRef}" alt={product.name} loading="lazy" />
      {:else}
        <div class="media-ph"></div>
      {/if}
      {#if soldOut}
        <span class="sold-tag">Sold out</span>
      {:else if onSale}
        <span class="sale-tag">Sale</span>
      {/if}
      <span class="add-fab" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </span>
    </div>
    <div class="body">
      {#if categoryLabel}<span class="kicker">{categoryLabel}</span>{/if}
      <h3 title={product.name}>{product.name}</h3>
      {#if product.description}<p class="desc">{product.description}</p>{/if}
      <div class="foot">
        <div class="price">
          {#if onSale}<span class="was mono">{formatMoney(product.compareAtPrice!, currency)}</span>{/if}
          <span class="now mono">{hasVariants ? "from " : ""}{formatMoney(product.price, currency)}</span>
        </div>
        {#if lowStock}
          <span class="stock low mono">Only {product.stock} left</span>
        {:else if product.stock != null && !soldOut}
          <span class="stock mono">{product.stock} in stock</span>
        {/if}
      </div>
    </div>
  {:else}
    <!-- POS tile: dense, tappable, price-forward -->
    <span class="pos-name" title={product.name}>{product.name}</span>
    <span class="pos-price mono">{hasVariants ? "from " : ""}{formatMoney(product.price, currency)}</span>
    {#if soldOut}
      <span class="pos-sold mono">Sold out</span>
    {:else if lowStock}
      <span class="pos-stock mono">{product.stock} left</span>
    {/if}
  {/if}
</div>

<style>
  .pc {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color 0.12s ease, transform 0.12s ease, background 0.12s ease;
    outline: none;
  }
  .pc:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pc.blocked { cursor: default; }

  /* ---- storefront ---- */
  .pc--storefront { overflow: hidden; display: flex; flex-direction: column; }
  .pc--storefront:not(.blocked):hover { border-color: var(--accent); }
  .pc--storefront:not(.blocked):active { transform: translateY(1px); }

  .media { position: relative; aspect-ratio: 4 / 3; overflow: hidden; }
  .media img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .media-ph { width: 100%; height: 100%; background: linear-gradient(135deg, var(--bg-surface-hover), var(--bg-elevated)); }
  .sold-out .media img { filter: grayscale(1) brightness(0.55); }

  .sale-tag, .sold-tag {
    position: absolute; top: 0.5rem; left: 0.5rem;
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.1em;
    padding: 0.125rem 0.4375rem; border-radius: var(--radius-sm);
  }
  .sale-tag { color: var(--accent-ink); background: var(--accent); }
  .sold-tag { color: var(--text); background: var(--error); }

  /* Add affordance — the one lime surface; slides in on hover, square pixel-y plus. */
  .add-fab {
    position: absolute; right: 0.5rem; bottom: 0.5rem;
    width: 1.75rem; height: 1.75rem;
    display: grid; place-items: center;
    color: var(--accent-ink); background: var(--accent);
    border-radius: var(--radius-sm);
    opacity: 0; transform: translateY(0.375rem);
    transition: opacity 0.12s ease, transform 0.12s ease;
  }
  .pc--storefront:not(.blocked):hover .add-fab,
  .pc--storefront:focus-visible .add-fab { opacity: 1; transform: translateY(0); }

  .body { padding: 0.75rem 0.875rem 0.875rem; display: flex; flex-direction: column; gap: 0.25rem; flex: 1; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.625rem; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  h3 { margin: 0; color: var(--text); font-size: 0.9375rem; font-weight: 600; line-height: 1.25;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc {
    margin: 0; color: var(--text-secondary); font-size: 0.8125rem; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .foot { margin-top: auto; padding-top: 0.5rem; display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .price { display: flex; align-items: baseline; gap: 0.4375rem; min-width: 0; }
  .was { font-size: 0.75rem; color: var(--text-dim); text-decoration: line-through; }
  .now { font-size: 1.0625rem; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
  .stock { font-size: 0.625rem; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; }
  .stock.low { color: var(--accent-text); }

  /* ---- POS tile ---- */
  .pc--pos {
    aspect-ratio: 1 / 1;
    padding: 0.625rem;
    display: flex; flex-direction: column; justify-content: space-between; gap: 0.25rem;
    background: var(--bg-elevated);
  }
  .pc--pos:not(.blocked):hover { border-color: var(--accent); background: var(--bg-surface-hover); }
  .pc--pos:not(.blocked):active { transform: translateY(1px); border-color: var(--accent); }
  .pos-name {
    color: var(--text); font-size: 0.8125rem; font-weight: 600; line-height: 1.2;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pos-price { font-size: 1.125rem; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
  .pos-stock { font-size: 0.5625rem; color: var(--accent-text); text-transform: uppercase; letter-spacing: 0.08em; }
  .pos-sold { font-size: 0.5625rem; color: var(--error); text-transform: uppercase; letter-spacing: 0.08em; }
  .pc--pos.sold-out { opacity: 0.5; }
</style>
