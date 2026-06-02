<script lang="ts">
  import type { ProductGridSection as ProductGridSectionType, Site } from "@woco/shared";
  import type { Shop, Product } from "@woco/shared";
  import { onMount } from "svelte";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../../cache/cache.js";
  import Storefront from "../../shop/Storefront.svelte";
  import Checkout from "../../shop/Checkout.svelte";
  import type { CartLine } from "../../shop/Storefront.svelte";

  interface Props {
    section: ProductGridSectionType;
    site: Site;
    apiUrl: string;
  }

  let { section, site, apiUrl }: Props = $props();

  type LoadState = "loading" | "ready" | "empty" | "error";
  let loadState = $state<LoadState>("loading");
  let shop = $state<Shop | null>(null);
  let products = $state<Product[]>([]);
  let cart = $state<CartLine[]>([]);
  let checkoutOpen = $state(false);

  async function fetchProducts(): Promise<{ shop: Shop; products: Product[] } | null> {
    try {
      const [sr, pr] = await Promise.all([
        fetch(`${apiUrl}/api/shops/${section.shopId}`).then((r) => r.json()),
        fetch(`${apiUrl}/api/shops/${section.shopId}/products`).then((r) => r.json()),
      ]);
      if (!sr.ok || !pr.ok) return null;
      return { shop: sr.data as Shop, products: pr.data as Product[] };
    } catch {
      return null;
    }
  }

  onMount(async () => {
    const ck = cacheKey.shopProducts(section.shopId);
    const isPreview = !!window.SITE_CONFIG?.previewEvents;

    if (!isPreview) {
      const cached = cacheGet<{ shop: Shop; products: Product[] }>(ck);
      if (cached) {
        shop = cached.shop;
        products = cached.products;
        loadState = products.length === 0 ? "empty" : "ready";
        fetchProducts().then((fresh) => {
          if (!fresh) return;
          cacheSet(ck, fresh, TTL.SHOP_PRODUCTS);
          shop = fresh.shop;
          products = fresh.products;
          if (loadState !== "error") loadState = products.length === 0 ? "empty" : "ready";
        }).catch(() => {});
        return;
      }
    }

    const data = await fetchProducts();
    if (!data) { loadState = "error"; return; }
    if (!isPreview) cacheSet(ck, data, TTL.SHOP_PRODUCTS);
    shop = data.shop;
    const filtered = section.categoryId
      ? data.products.filter((p) => p.categoryId === section.categoryId)
      : data.products;
    products = section.max ? filtered.slice(0, section.max) : filtered;
    loadState = products.length === 0 ? "empty" : "ready";
  });

  function addToCart(p: Product) {
    const next = cart.map((l) => ({ ...l }));
    const found = next.find((l) => l.productId === p.productId);
    if (found) { found.qty += 1; cart = next; }
    else cart = [...next, { productId: p.productId, name: p.name, unitPrice: p.price, qty: 1 }];
  }

  function bumpCart(productId: string, delta: number) {
    const next = cart.map((l) => ({ ...l }));
    const i = next.findIndex((l) => l.productId === productId);
    if (i === -1) return;
    next[i].qty += delta;
    cart = next[i].qty <= 0 ? next.filter((_, j) => j !== i) : next;
  }
</script>

<section class="pg-section">
  <div class="inner">
    {#if section.title}
      <h2 class="section-heading">{section.title}</h2>
    {/if}

    {#if loadState === "loading"}
      <div class="skeleton-grid">
        {#each Array(section.max ?? 4) as _, i}
          <div class="skeleton" style="animation-delay:{i * 0.08}s"></div>
        {/each}
      </div>
    {:else if loadState === "error"}
      <p class="notice">Could not load products. Please try again.</p>
    {:else if loadState === "empty" || !shop}
      <p class="notice">No products available.</p>
    {:else}
      <Storefront
        {shop}
        {products}
        {cart}
        onAdd={addToCart}
        onOpenCheckout={() => { checkoutOpen = true; }}
      />
    {/if}
  </div>
</section>

{#if checkoutOpen && shop}
  <Checkout
    {shop}
    {cart}
    onClose={() => { checkoutOpen = false; }}
    onBump={bumpCart}
    onSuccess={(_id, _code) => { cart = []; }}
  />
{/if}

<style>
  .pg-section { padding: var(--sec-pt, 2.5rem) 1.5rem var(--sec-pb, 1.5rem); }
  .inner { max-width: 1060px; margin: 0 auto; }

  .section-heading {
    font-size: 1.25rem; font-weight: 700; color: var(--text);
    margin: 0 0 1.25rem;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.75rem;
  }
  .skeleton {
    aspect-ratio: 4/3;
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--bg-surface) 25%,
      color-mix(in srgb, var(--border) 60%, var(--bg-surface)) 50%,
      var(--bg-surface) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .notice {
    text-align: center; padding: 3rem 0;
    color: var(--text-muted); font-size: 0.9375rem; margin: 0;
  }
</style>
