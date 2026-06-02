<script lang="ts">
  /**
   * Builder shop tab — links/creates one shop for the current site and edits its
   * catalog inline. Catalog CRUD is delegated to the shared ShopCatalogEditor so
   * the standalone Shop editor (/creator/shops/:id) and this tab stay in sync.
   * Full shop management (payments, surfaces, orders) lives in the Shop editor.
   */
  import type { Shop, FiatCurrency } from "@woco/shared";
  import { auth } from "../../../auth/auth-store.svelte.js";
  import { createShop, updateShop, getShop } from "../../../api/shops.js";
  import { navigate } from "../../../router/router.svelte.js";
  import { onMount } from "svelte";
  import ShopCatalogEditor from "../../shops/ShopCatalogEditor.svelte";

  interface Props {
    siteId: string;
    /** Persisted shopId for this site (stored in builder parent's state). */
    shopId: string | null;
    onshopchange: (shopId: string) => void;
  }
  let { siteId: _siteId, shopId, onshopchange }: Props = $props();

  type Phase = "loading" | "create-form" | "ready" | "error";
  let phase = $state<Phase>("loading");
  let shop = $state<Shop | null>(null);
  let saving = $state(false);
  let errorMsg = $state("");

  let formName = $state("");
  let formCurrency = $state<FiatCurrency>("GBP");

  async function load() {
    if (!shopId) { phase = "create-form"; return; }
    const s = await getShop(shopId);
    if (!s) { phase = "create-form"; return; }
    shop = s;
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
      shop = await updateShop(shop.shopId, { name: formName.trim() });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Save failed";
    } finally { saving = false; }
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
      <div class="header-actions">
        <button class="btn btn--ghost btn--sm" onclick={handleSaveShop} disabled={saving}>
          {saving ? "Saving…" : "Save name"}
        </button>
        <button class="btn btn--ghost btn--sm" onclick={() => navigate(`/creator/shops/${shop!.shopId}`)}>
          Full shop settings →
        </button>
      </div>
    </div>

    <ShopCatalogEditor {shop} onShopUpdate={(s) => { shop = s; }} />
  {/if}
</div>

<style>
  .shop-tab { display: flex; flex-direction: column; gap: 0; }

  .state-msg { color: var(--text-muted); font-size: 0.8125rem; padding: 1.5rem; }
  .state-msg.err { color: var(--error); }

  .create-form { padding: 1rem; display: flex; flex-direction: column; gap: 0.875rem; }
  .hint { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); }

  .section-block { border-bottom: 1px solid var(--border); padding: 0.875rem 1rem; display: flex; flex-direction: column; gap: 0.625rem; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.125rem; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }
  .kicker--plain { font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .shop-id { font-family: var(--font-mono); font-size: 0.625rem; color: var(--text-dim); }

  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .f-label { display: block; font-family: var(--font-mono); font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .input {
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
    padding: 0.4375rem 0.625rem; font-size: 0.8125rem; width: 100%;
    transition: border-color 0.1s;
  }
  .input:focus { outline: none; border-color: var(--accent); }

  .header-actions { display: flex; flex-wrap: wrap; gap: 0.375rem; }

  .err-box {
    background: var(--error-subtle); color: var(--error); border: 1px solid var(--error);
    border-radius: var(--radius-sm); padding: 0.375rem 0.5rem; font-size: 0.625rem;
  }
</style>
