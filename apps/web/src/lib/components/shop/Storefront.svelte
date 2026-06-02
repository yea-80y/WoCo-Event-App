<script lang="ts">
  import type { Shop, Product, FiatCurrency } from "@woco/shared";
  import ProductCard from "./ProductCard.svelte";

  export interface CartLine {
    productId: string;
    name: string;
    unitPrice: string;
    qty: number;
  }

  interface Props {
    shop: Shop;
    products: Product[];
    cart: CartLine[];
    onAdd: (product: Product) => void;
    onOpenCheckout: () => void;
  }

  let { shop, products, cart, onAdd, onOpenCheckout }: Props = $props();

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  const toMinor = (s: string) => Math.round(Number(s) * 100);

  function money(minor: number, ccy: FiatCurrency): string {
    const sym = SYMBOLS[ccy] ?? "";
    const body = (minor / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return sym ? `${sym}${body}` : `${body} ${ccy}`;
  }

  const webProducts = $derived(
    products
      .filter((p) => p.active && (!p.channels || p.channels.includes("web")))
      .sort((a, b) => a.sortIndex - b.sortIndex),
  );

  const groups = $derived.by(() => {
    const byCat = new Map<string, { label: string; items: Product[] }>();
    const labelFor = (id?: string) =>
      shop.categories.find((c) => c.id === id)?.label ?? "Other";
    for (const p of webProducts) {
      const key = p.categoryId ?? "_";
      if (!byCat.has(key)) byCat.set(key, { label: labelFor(p.categoryId), items: [] });
      byCat.get(key)!.items.push(p);
    }
    return [...byCat.values()];
  });

  const itemCount = $derived(cart.reduce((n, l) => n + l.qty, 0));
  const totalMinor = $derived(cart.reduce((n, l) => n + toMinor(l.unitPrice) * l.qty, 0));
</script>

<div class="storefront">
  {#if webProducts.length === 0}
    <div class="empty">
      <span class="mono">–––</span>
      <p>No products available yet.</p>
    </div>
  {:else}
    {#each groups as g}
      <section class="group">
        <h2 class="kicker">{g.label}</h2>
        <div class="grid">
          {#each g.items as p (p.productId)}
            <ProductCard
              product={p}
              currency={shop.currency}
              variant="storefront"
              categoryLabel={g.label}
              onAdd={onAdd}
            />
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<!-- sticky cart bar -->
{#if itemCount > 0}
  <div class="cart-bar">
    <div class="cb-inner">
      <span class="cb-count mono">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
      <span class="cb-total mono">{money(totalMinor, shop.currency)}</span>
      <button class="btn btn--primary cb-cta" onclick={onOpenCheckout}>
        View cart
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
          <path d="M2 6h8M7 3l3 3-3 3" />
        </svg>
      </button>
    </div>
  </div>
{/if}

<style>
  .storefront {
    padding-bottom: 5rem; /* room for sticky cart */
  }

  .group { margin-bottom: 2rem; }

  .kicker {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .kicker::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    background: var(--accent);
    flex-shrink: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .empty {
    text-align: center;
    padding: 4rem 1rem;
    color: var(--text-muted);
  }
  .empty .mono { font-family: var(--font-mono); font-size: 1.5rem; color: var(--text-dim); display: block; margin-bottom: 0.75rem; letter-spacing: 0.3em; }
  .empty p { margin: 0; font-size: 0.875rem; }

  /* ── cart bar ── */
  .cart-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 40;
    padding: 0 1rem 1rem;
    pointer-events: none;
    animation: slideup 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes slideup {
    from { transform: translateY(100%); opacity: 0; }
    to { transform: none; opacity: 1; }
  }

  .cb-inner {
    max-width: 560px;
    margin: 0 auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-md);
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    pointer-events: all;
  }

  .cb-count { font-size: 0.75rem; color: var(--text-muted); }
  .cb-total { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em; }
  .cb-cta { display: inline-flex; align-items: center; gap: 0.375rem; }

  @media (max-width: 560px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  }
</style>
