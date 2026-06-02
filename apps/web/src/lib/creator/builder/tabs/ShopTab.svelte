<script lang="ts">
  /**
   * Builder shop tab — shop config + product CRUD.
   * Lets the creator create/manage one shop tied to the current site,
   * and add a productGrid section to any page.
   */
  import type {
    Shop,
    Product,
    ProductCategory,
    FiatCurrency,
    UpsertProductRequest,
  } from "@woco/shared";
  import { auth } from "../../../auth/auth-store.svelte.js";
  import {
    createShop,
    updateShop,
    upsertProduct,
    deleteProduct,
    getShop,
    getProducts,
  } from "../../../api/shops.js";
  import { onMount } from "svelte";

  function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

  interface Props {
    siteId: string;
    /** Persisted shopId for this site (stored in builder parent's state). */
    shopId: string | null;
    onshopchange: (shopId: string) => void;
  }

  let { siteId, shopId, onshopchange }: Props = $props();

  type Phase = "loading" | "create-form" | "ready" | "error";
  let phase = $state<Phase>("loading");
  let shop = $state<Shop | null>(null);
  let products = $state<Product[]>([]);
  let saving = $state(false);
  let errorMsg = $state("");

  // shop form
  let formName = $state("");
  let formCurrency = $state<FiatCurrency>("GBP");

  // product form
  let productFormOpen = $state(false);
  let editingProduct = $state<Product | null>(null);
  let pName = $state("");
  let pDesc = $state("");
  let pPrice = $state("");
  let pCompareAt = $state("");
  let pCategory = $state("");
  let pChannels = $state<"both" | "web" | "pos">("both");
  let pActive = $state(true);
  let productSaving = $state(false);
  let productError = $state("");

  // category form
  let catInput = $state("");

  async function load() {
    if (!shopId) { phase = "create-form"; return; }
    const [s, ps] = await Promise.all([getShop(shopId), getProducts(shopId)]);
    if (!s) { phase = "create-form"; return; }
    shop = s;
    products = ps;
    formName = s.name;
    phase = "ready";
  }

  onMount(load);

  async function handleCreateShop() {
    if (!formName.trim() || !auth.parent) return;
    if (!auth.hasSession) { const ok = await auth.ensureSession(); if (!ok) return; }
    saving = true; errorMsg = "";
    try {
      const s = await createShop({
        name: formName.trim(),
        currency: formCurrency,
        payment: { stripeEnabled: true, cryptoEnabled: false },
      });
      shop = s;
      products = [];
      phase = "ready";
      onshopchange(s.shopId);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Create failed";
    } finally { saving = false; }
  }

  async function handleSaveShop() {
    if (!shop || !formName.trim()) return;
    saving = true; errorMsg = "";
    try {
      const s = await updateShop(shop.shopId, { name: formName.trim() });
      shop = s;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Save failed";
    } finally { saving = false; }
  }

  async function addCategory() {
    if (!shop || !catInput.trim()) return;
    const label = catInput.trim();
    const cat: ProductCategory = { id: uid(), label, sortIndex: shop.categories.length };
    const updated = await updateShop(shop.shopId, { categories: [...shop.categories, cat] });
    shop = updated; catInput = "";
  }

  async function removeCategory(id: string) {
    if (!shop) return;
    const updated = await updateShop(shop.shopId, { categories: shop.categories.filter(c => c.id !== id) });
    shop = updated;
  }

  function openAddProduct() {
    editingProduct = null;
    pName = ""; pDesc = ""; pPrice = ""; pCompareAt = ""; pCategory = ""; pChannels = "both"; pActive = true;
    productFormOpen = true; productError = "";
  }

  function openEditProduct(p: Product) {
    editingProduct = p;
    pName = p.name; pDesc = p.description ?? ""; pPrice = p.price;
    pCompareAt = p.compareAtPrice ?? ""; pCategory = p.categoryId ?? "";
    pChannels = !p.channels ? "both" : p.channels.length === 2 ? "both" : (p.channels[0] as "web" | "pos");
    pActive = p.active; productFormOpen = true; productError = "";
  }

  async function handleSaveProduct() {
    if (!shop || !pName.trim() || !pPrice.trim()) return;
    productSaving = true; productError = "";
    try {
      const req: UpsertProductRequest = {
        ...(editingProduct ? { productId: editingProduct.productId } : {}),
        name: pName.trim(),
        description: pDesc.trim() || undefined,
        price: pPrice.trim(),
        compareAtPrice: pCompareAt.trim() || undefined,
        categoryId: pCategory || undefined,
        channels: pChannels === "both" ? undefined : [pChannels as import("@woco/shared").SalesChannel],
        active: pActive,
        sortIndex: editingProduct?.sortIndex ?? products.length,
      };
      const saved = await upsertProduct(shop.shopId, req);
      if (editingProduct) {
        products = products.map(p => p.productId === saved.productId ? saved : p);
      } else {
        products = [...products, saved];
      }
      productFormOpen = false;
    } catch (e) {
      productError = e instanceof Error ? e.message : "Save failed";
    } finally { productSaving = false; }
  }

  async function handleDeleteProduct(p: Product) {
    if (!shop) return;
    await deleteProduct(shop.shopId, p.productId);
    products = products.filter(x => x.productId !== p.productId);
  }

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  function fmt(s: string, ccy: FiatCurrency) {
    const sym = SYMBOLS[ccy] ?? "";
    const n = Number(s);
    return Number.isFinite(n) ? `${sym}${n.toFixed(2)}` : `${sym}${s}`;
  }
</script>

<div class="shop-tab">
  {#if phase === "loading"}
    <div class="state-msg mono">Loading…</div>

  {:else if phase === "error"}
    <div class="state-msg err mono">{errorMsg}</div>

  {:else if phase === "create-form"}
    <div class="create-form">
      <p class="hint">Create a shop for this site to start selling products.</p>
      <label class="field">
        <span class="f-label kicker">Shop name</span>
        <input class="input" bind:value={formName} placeholder="e.g. Festival Merch" />
      </label>
      <label class="field">
        <span class="f-label kicker">Currency</span>
        <select class="input" bind:value={formCurrency}>
          <option value="GBP">GBP £</option>
          <option value="USD">USD $</option>
          <option value="EUR">EUR €</option>
        </select>
      </label>
      {#if errorMsg}<div class="err-box mono">{errorMsg}</div>{/if}
      <button class="btn btn--primary" onclick={handleCreateShop} disabled={saving || !formName.trim()}>
        {saving ? "Creating…" : "Create shop"}
      </button>
    </div>

  {:else if phase === "ready" && shop}
    <!-- shop header -->
    <div class="section-block">
      <div class="section-head">
        <span class="kicker">Shop config</span>
        <span class="shop-id mono">{shop.shopId.slice(-8)}</span>
      </div>
      <label class="field">
        <span class="f-label kicker--plain">Name</span>
        <input class="input" bind:value={formName} />
      </label>
      {#if errorMsg}<div class="err-box mono">{errorMsg}</div>{/if}
      <button class="btn btn--ghost btn--sm" onclick={handleSaveShop} disabled={saving}>
        {saving ? "Saving…" : "Save name"}
      </button>
    </div>

    <!-- categories -->
    <div class="section-block">
      <div class="section-head">
        <span class="kicker">Categories</span>
        <span class="count mono">{shop.categories.length}</span>
      </div>
      {#if shop.categories.length > 0}
        <ul class="cat-list">
          {#each [...shop.categories].sort((a, b) => a.sortIndex - b.sortIndex) as cat}
            <li>
              <span class="cat-label">{cat.label}</span>
              <button class="del-btn" onclick={() => removeCategory(cat.id)} aria-label="Remove category">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1 1l8 8M9 1L1 9" /></svg>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="add-cat">
        <input class="input input--sm" bind:value={catInput} placeholder="New category…" onkeydown={(e) => e.key === "Enter" && addCategory()} />
        <button class="btn btn--ghost btn--sm" onclick={addCategory} disabled={!catInput.trim()}>Add</button>
      </div>
    </div>

    <!-- products -->
    <div class="section-block">
      <div class="section-head">
        <span class="kicker">Products</span>
        <button class="btn btn--primary btn--sm" onclick={openAddProduct}>+ Add product</button>
      </div>

      {#if productFormOpen}
        <div class="product-form">
          <div class="pf-head">
            <span class="kicker--plain">{editingProduct ? "Edit product" : "New product"}</span>
            <button class="close" onclick={() => { productFormOpen = false; }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M1 1l8 8M9 1L1 9" /></svg>
            </button>
          </div>
          <label class="field">
            <span class="f-label kicker--plain">Name *</span>
            <input class="input" bind:value={pName} placeholder="e.g. Festival T-shirt" />
          </label>
          <label class="field">
            <span class="f-label kicker--plain">Description</span>
            <textarea class="input" rows="2" bind:value={pDesc} placeholder="Short description…"></textarea>
          </label>
          <div class="pf-row">
            <label class="field">
              <span class="f-label kicker--plain">Price *</span>
              <input class="input mono" bind:value={pPrice} placeholder="15.00" />
            </label>
            <label class="field">
              <span class="f-label kicker--plain">Compare-at</span>
              <input class="input mono" bind:value={pCompareAt} placeholder="20.00" />
            </label>
          </div>
          <label class="field">
            <span class="f-label kicker--plain">Category</span>
            <select class="input" bind:value={pCategory}>
              <option value="">None</option>
              {#each shop.categories as cat}
                <option value={cat.id}>{cat.label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span class="f-label kicker--plain">Channels</span>
            <select class="input" bind:value={pChannels}>
              <option value="both">Web + POS</option>
              <option value="web">Web only</option>
              <option value="pos">POS only</option>
            </select>
          </label>
          <label class="check-row">
            <input type="checkbox" bind:checked={pActive} />
            <span>Active (visible to customers)</span>
          </label>
          {#if productError}<div class="err-box mono">{productError}</div>{/if}
          <div class="pf-actions">
            <button class="btn btn--ghost btn--sm" onclick={() => { productFormOpen = false; }}>Cancel</button>
            <button
              class="btn btn--primary btn--sm"
              onclick={handleSaveProduct}
              disabled={productSaving || !pName.trim() || !pPrice.trim()}
            >
              {productSaving ? "Saving…" : "Save product"}
            </button>
          </div>
        </div>
      {/if}

      {#if products.length === 0 && !productFormOpen}
        <p class="empty-hint">No products yet. Add your first product above.</p>
      {:else}
        <ul class="product-list">
          {#each products as p (p.productId)}
            <li class:inactive={!p.active}>
              <div class="pl-info">
                <span class="pl-name">{p.name}</span>
                {#if !p.active}<span class="kicker pl-status">hidden</span>{/if}
              </div>
              <span class="pl-price mono">{fmt(p.price, shop.currency)}</span>
              <div class="pl-actions">
                <button class="act-btn" onclick={() => openEditProduct(p)} aria-label="Edit">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M8.5 1.5l2 2L3 11H1V9L8.5 1.5z" /></svg>
                </button>
                <button class="act-btn act-btn--del" onclick={() => handleDeleteProduct(p)} aria-label="Delete">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M2 3h8M5 3V1.5h2V3M4 3v7h4V3" /></svg>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .shop-tab { display: flex; flex-direction: column; gap: 0; }

  .state-msg { color: var(--text-muted); font-size: 0.8125rem; padding: 1.5rem; }
  .state-msg.err { color: var(--error); }

  /* ── create form ── */
  .create-form { padding: 1rem; display: flex; flex-direction: column; gap: 0.875rem; }
  .hint { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); }

  /* ── section blocks ── */
  .section-block { border-bottom: 1px solid var(--border); padding: 0.875rem 1rem; display: flex; flex-direction: column; gap: 0.625rem; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.125rem; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  .kicker--plain { font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .count, .shop-id { font-family: var(--font-mono); font-size: 0.625rem; color: var(--text-dim); }

  /* ── fields ── */
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .f-label { display: block; font-family: var(--font-mono); font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .input {
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
    padding: 0.4375rem 0.625rem; font-size: 0.8125rem; width: 100%;
    transition: border-color 0.1s;
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .input--sm { padding: 0.3125rem 0.5rem; font-size: 0.75rem; }
  textarea.input { resize: vertical; min-height: 3.5rem; }

  .check-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; color: var(--text-secondary); cursor: pointer; }
  .check-row input { accent-color: var(--accent); }

  .err-box {
    background: var(--error-subtle); color: var(--error); border: 1px solid var(--error);
    border-radius: var(--radius-sm); padding: 0.375rem 0.5rem; font-size: 0.625rem;
  }

  /* ── categories ── */
  .cat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .cat-list li {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.3125rem 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 0.8125rem; color: var(--text-secondary);
  }
  .cat-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .del-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0.25rem; line-height: 0; border-radius: var(--radius-sm); }
  .del-btn:hover { color: var(--error); }

  .add-cat { display: grid; grid-template-columns: 1fr auto; gap: 0.375rem; }

  /* ── product form ── */
  .product-form {
    background: var(--bg-elevated); border: 1px solid var(--accent);
    border-radius: var(--radius-md); padding: 0.75rem;
    display: flex; flex-direction: column; gap: 0.625rem;
    margin-bottom: 0.625rem;
  }
  .pf-head { display: flex; align-items: center; justify-content: space-between; }
  .pf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .pf-actions { display: flex; justify-content: flex-end; gap: 0.375rem; }
  .close { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0.25rem; line-height: 0; }
  .close:hover { color: var(--text); }

  /* ── product list ── */
  .product-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .product-list li {
    display: grid; grid-template-columns: 1fr auto auto;
    align-items: center; gap: 0.5rem;
    padding: 0.4375rem 0.5rem;
    background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
    transition: border-color 0.1s;
  }
  .product-list li:hover { border-color: var(--border-hover); }
  .product-list li.inactive { opacity: 0.55; }
  .pl-info { min-width: 0; display: flex; align-items: center; gap: 0.4375rem; }
  .pl-name { font-size: 0.8125rem; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pl-status { color: var(--text-dim) !important; }
  .pl-price { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text); white-space: nowrap; }
  .pl-actions { display: flex; gap: 0.25rem; }
  .act-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0.25rem; line-height: 0; border-radius: var(--radius-sm); }
  .act-btn:hover { color: var(--text); background: var(--bg-surface-hover); }
  .act-btn--del:hover { color: var(--error); }

  .empty-hint { color: var(--text-muted); font-size: 0.8125rem; margin: 0; padding: 0.5rem 0; }
</style>
