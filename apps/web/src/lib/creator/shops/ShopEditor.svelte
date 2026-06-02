<script lang="ts">
  /**
   * Shop editor (/creator/shops/:id) — the standalone home for one shop, making
   * it a first-class entity rather than a website-builder tab. `:id === "new"`
   * shows the create flow. Tabs:
   *   Catalog   — products + categories (shared ShopCatalogEditor)
   *   Payments  — name, currency, card/USDC rails, recipient
   *   Surfaces  — where this catalog projects: POS, tap-to-pay QR, storefront, website
   *   Orders    — order log (owner only)
   *
   * One catalog, many surfaces. See docs/SHOP_IA.md.
   */
  import type { Shop, FiatCurrency, Order, Hex0x } from "@woco/shared";
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { createShop, updateShop, getShop, getShopOrders } from "../../api/shops.js";
  import ShopCatalogEditor from "./ShopCatalogEditor.svelte";

  interface Props { shopId: string; }
  let { shopId }: Props = $props();

  const isNew = $derived(shopId === "new");

  type Tab = "catalog" | "payments" | "surfaces" | "orders";
  let tab = $state<Tab>("catalog");

  let phase = $state<"loading" | "create" | "ready" | "error">("loading");
  let shop = $state<Shop | null>(null);
  let errorMsg = $state("");
  let saving = $state(false);

  // create-form
  let formName = $state("");
  let formCurrency = $state<FiatCurrency>("GBP");

  // payments form
  let payStripe = $state(true);
  let payCrypto = $state(false);
  let payRecipient = $state("");

  // orders
  let orders = $state<Order[]>([]);
  let ordersLoaded = $state(false);
  let ordersError = $state("");

  // surfaces
  let tapQr = $state<string | null>(null);
  let copied = $state("");

  const tapUrl = $derived(
    typeof window !== "undefined" ? `${window.location.origin}/#/shops/${shopId}/tap` : "",
  );
  const posPath = $derived(`/creator/shops/${shopId}/pos`);

  onMount(async () => {
    if (isNew) { phase = "create"; return; }
    try {
      const s = await getShop(shopId);
      if (!s) { errorMsg = "Shop not found."; phase = "error"; return; }
      hydrate(s);
      phase = "ready";
    } catch {
      errorMsg = "Couldn't load this shop.";
      phase = "error";
    }
  });

  function hydrate(s: Shop) {
    shop = s;
    formName = s.name;
    payStripe = s.payment.stripeEnabled ?? false;
    payCrypto = s.payment.cryptoEnabled ?? false;
    payRecipient = s.payment.recipientAddress ?? "";
  }

  async function ensureAuthed(): Promise<boolean> {
    if (!auth.parent) return false;
    if (!auth.hasSession) return auth.ensureSession();
    return true;
  }

  async function handleCreate() {
    if (!formName.trim()) return;
    if (!(await ensureAuthed())) return;
    saving = true; errorMsg = "";
    try {
      const s = await createShop({
        name: formName.trim(),
        currency: formCurrency,
        payment: { stripeEnabled: true, cryptoEnabled: false },
      });
      navigate(`/creator/shops/${s.shopId}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't create shop";
    } finally { saving = false; }
  }

  async function savePayments() {
    if (!shop) return;
    if (!(await ensureAuthed())) return;
    saving = true; errorMsg = "";
    try {
      const updated = await updateShop(shop.shopId, {
        name: formName.trim() || shop.name,
        payment: {
          ...shop.payment,
          stripeEnabled: payStripe,
          cryptoEnabled: payCrypto,
          recipientAddress: (payRecipient.trim() || undefined) as Hex0x | undefined,
          // USDC settles on Arb Sepolia at launch (locked decision) — default the
          // accepted chain when crypto is first enabled and none is set.
          acceptedChains: payCrypto && (!shop.payment.acceptedChains || shop.payment.acceptedChains.length === 0)
            ? [421614]
            : shop.payment.acceptedChains,
        },
      });
      hydrate(updated);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't save";
    } finally { saving = false; }
  }

  async function loadOrders() {
    if (ordersLoaded || !shop) return;
    try {
      orders = await getShopOrders(shop.shopId);
    } catch (e) {
      ordersError = e instanceof Error ? e.message : "Couldn't load orders";
    } finally { ordersLoaded = true; }
  }

  $effect(() => {
    if (tab === "orders" && phase === "ready" && !ordersLoaded) void loadOrders();
  });

  async function makeTapQr() {
    if (tapQr || !tapUrl) return;
    try {
      const { renderSVG } = await import("uqr");
      tapQr = renderSVG(tapUrl, { ecc: "M", blackColor: "#0B0B09", whiteColor: "#ffffff" });
    } catch { tapQr = null; }
  }

  $effect(() => {
    if (tab === "surfaces" && phase === "ready") void makeTapQr();
  });

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => { if (copied === key) copied = ""; }, 1600);
    } catch { /* clipboard blocked — non-fatal */ }
  }

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  function money(total: string, ccy: FiatCurrency) {
    const sym = SYMBOLS[ccy] ?? "";
    const n = Number(total);
    return Number.isFinite(n) ? `${sym}${n.toFixed(2)}` : `${sym}${total}`;
  }
  function when(iso: string) {
    try { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
    catch { return iso; }
  }
</script>

<div class="shop-editor">
  {#if phase === "loading"}
    <div class="state mono">Loading…</div>

  {:else if phase === "error"}
    <div class="state err mono">{errorMsg}</div>
    <button class="btn btn--ghost" onclick={() => navigate("/creator/shops")}>← All shops</button>

  {:else if phase === "create"}
    <div class="create card">
      <button class="back" onclick={() => navigate("/creator/shops")}>← Shops</button>
      <span class="kicker">New shop</span>
      <h1 class="title">Create a shop</h1>
      <p class="lede">One catalog you can sell from a POS, a standalone page, or your website.</p>
      <label class="field">
        <span class="f-label">Shop name</span>
        <input class="input" bind:value={formName} placeholder="e.g. The Anchor Bar" />
      </label>
      <label class="field">
        <span class="f-label">Currency</span>
        <select class="input" bind:value={formCurrency}>
          <option value="GBP">GBP £</option>
          <option value="USD">USD $</option>
          <option value="EUR">EUR €</option>
        </select>
      </label>
      {#if errorMsg}<div class="err-box mono">{errorMsg}</div>{/if}
      <button class="btn btn--primary" onclick={handleCreate} disabled={saving || !formName.trim()}>
        {saving ? "Creating…" : "Create shop"}
      </button>
    </div>

  {:else if phase === "ready" && shop}
    <header class="head">
      <button class="back" onclick={() => navigate("/creator/shops")}>← Shops</button>
      <div class="head-main">
        <div class="head-text">
          <span class="kicker">Shop · {shop.currency}</span>
          <h1 class="title">{shop.name}</h1>
        </div>
        <button class="btn btn--primary btn--sm" onclick={() => navigate(posPath)}>Open POS</button>
      </div>
    </header>

    <nav class="tabs" role="tablist">
      {#each [["catalog","Catalog"],["payments","Payments"],["surfaces","Surfaces"],["orders","Orders"]] as [id, label] (id)}
        <button class="tab" class:active={tab === id} role="tab" aria-selected={tab === id} onclick={() => { tab = id as Tab; }}>
          {label}
        </button>
      {/each}
    </nav>

    <div class="tab-body card">
      {#if tab === "catalog"}
        <ShopCatalogEditor {shop} onShopUpdate={(s) => { shop = s; }} />

      {:else if tab === "payments"}
        <div class="pane">
          <label class="field">
            <span class="f-label">Shop name</span>
            <input class="input" bind:value={formName} />
          </label>
          <div class="rail">
            <label class="toggle">
              <input type="checkbox" bind:checked={payStripe} />
              <span><strong>Card</strong> — Stripe (1.5% platform fee)</span>
            </label>
            <label class="toggle">
              <input type="checkbox" bind:checked={payCrypto} />
              <span><strong>USDC</strong> — crypto (0.25% platform fee)</span>
            </label>
          </div>
          {#if payCrypto}
            <label class="field">
              <span class="f-label">Crypto payout address</span>
              <input class="input mono" bind:value={payRecipient} placeholder="0x… (where USDC lands)" />
              <span class="f-hint">USDC settles on Arbitrum. Full amount lands here — no platform split at launch.</span>
            </label>
          {/if}
          {#if errorMsg}<div class="err-box mono">{errorMsg}</div>{/if}
          <button class="btn btn--primary btn--sm self-start" onclick={savePayments} disabled={saving}>
            {saving ? "Saving…" : "Save payments"}
          </button>
        </div>

      {:else if tab === "surfaces"}
        <div class="pane surfaces">
          <p class="pane-lede">One catalog → many surfaces. Turn on the ones you need.</p>

          <div class="surface">
            <div class="surface-text">
              <span class="s-title">Point of sale</span>
              <span class="s-desc">Staff-operated counter — tap-to-charge against spend permissions.</span>
            </div>
            <button class="btn btn--ghost btn--sm" onclick={() => navigate(posPath)}>Open POS</button>
          </div>

          <div class="surface surface--col">
            <div class="surface-text">
              <span class="s-title">Tap to pay (festival gate)</span>
              <span class="s-desc">Print this QR at the entrance. Attendees scan to authorise a spending cap once, then pay all event.</span>
            </div>
            {#if tapQr}
              <div class="qr">{@html tapQr}</div>
            {/if}
            <div class="link-row">
              <code class="link mono">{tapUrl}</code>
              <button class="copy" onclick={() => copy(tapUrl, "tap")}>{copied === "tap" ? "Copied" : "Copy"}</button>
            </div>
          </div>

          <div class="surface">
            <div class="surface-text">
              <span class="s-title">Standalone storefront <span class="soon">soon</span></span>
              <span class="s-desc">Deploy a hosted shop page at its own URL — no full website needed. Lands next.</span>
            </div>
          </div>

          <div class="surface">
            <div class="surface-text">
              <span class="s-title">On your website</span>
              <span class="s-desc">In the site builder, add a <strong>Product grid</strong> section and pick this shop.</span>
            </div>
            <button class="btn btn--ghost btn--sm" onclick={() => navigate("/creator/sites")}>Open builder</button>
          </div>
        </div>

      {:else if tab === "orders"}
        <div class="pane">
          {#if !ordersLoaded}
            <p class="empty mono">Loading orders…</p>
          {:else if ordersError}
            <div class="err-box mono">{ordersError}</div>
          {:else if orders.length === 0}
            <p class="empty">No orders yet.</p>
          {:else}
            <ul class="orders">
              {#each orders as o (o.orderId)}
                <li>
                  <span class="o-code mono">{o.code}</span>
                  <span class="o-meta">{o.lines.length} item{o.lines.length !== 1 ? "s" : ""} · {o.rail} · {when(o.createdAt)}</span>
                  <span class="o-status status--{o.status}">{o.status}</span>
                  <span class="o-total mono">{money(o.total, o.currency)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .shop-editor { max-width: 640px; margin: 0 auto; padding: 1rem 1rem 4rem; display: flex; flex-direction: column; gap: 1rem; }
  .card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-md); }

  .state { color: var(--text-muted); font-size: 0.875rem; padding: 2rem 0; }
  .state.err { color: var(--error); }

  .back { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font-mono); padding: 0; text-align: left; }
  .back:hover { color: var(--text); }

  .kicker { font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); }
  .title { margin: 0.125rem 0 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); line-height: 1.1; }
  .lede, .pane-lede { margin: 0; font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.45; }

  /* create */
  .create { padding: 1.25rem; display: flex; flex-direction: column; gap: 0.875rem; }

  /* header + tabs */
  .head { display: flex; flex-direction: column; gap: 0.5rem; }
  .head-main { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }
  .head-text { min-width: 0; }

  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); }
  .tab {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-muted); cursor: pointer; padding: 0.5rem 0.75rem;
    font-size: 0.8125rem; font-weight: 600; margin-bottom: -1px;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }

  .tab-body { overflow: hidden; }
  .pane { padding: 1rem; display: flex; flex-direction: column; gap: 0.875rem; }

  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .f-label { font-family: var(--font-mono); font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .f-hint { font-size: 0.6875rem; color: var(--text-dim); }
  .input {
    background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); padding: 0.4375rem 0.625rem; font-size: 0.8125rem; width: 100%; transition: border-color 0.1s;
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .self-start { align-self: flex-start; }

  .rail { display: flex; flex-direction: column; gap: 0.5rem; }
  .toggle { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; color: var(--text-secondary); cursor: pointer; }
  .toggle input { accent-color: var(--accent); }
  .toggle strong { color: var(--text); }

  .err-box { background: var(--error-subtle); color: var(--error); border: 1px solid var(--error); border-radius: var(--radius-sm); padding: 0.375rem 0.5rem; font-size: 0.625rem; }

  /* surfaces */
  .surfaces { gap: 0.625rem; }
  .surface {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.875rem;
  }
  .surface--col { flex-direction: column; align-items: stretch; gap: 0.75rem; }
  .surface-text { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .s-title { font-size: 0.875rem; font-weight: 700; color: var(--text); }
  .s-desc { font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4; }
  .soon { font-family: var(--font-mono); font-size: 0.5rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent-ink); background: var(--accent); padding: 0.05rem 0.3rem; border-radius: 2px; vertical-align: middle; }

  .qr { background: #fff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.75rem; width: 168px; height: 168px; display: grid; place-items: center; align-self: center; }
  .qr :global(svg) { width: 100%; height: 100%; display: block; }

  .link-row { display: flex; align-items: center; gap: 0.5rem; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.375rem 0.5rem; }
  .link { flex: 1; font-size: 0.6875rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .copy { background: none; border: none; cursor: pointer; color: var(--accent-text); font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; flex-shrink: 0; }

  /* orders */
  .empty { color: var(--text-muted); font-size: 0.8125rem; margin: 0; padding: 0.5rem 0; }
  .orders { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .orders li {
    display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 0.625rem;
    padding: 0.5rem; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .o-code { font-size: 0.8125rem; font-weight: 700; color: var(--text); }
  .o-meta { font-size: 0.6875rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .o-status { font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; padding: 0.1rem 0.35rem; border-radius: 2px; }
  .status--paid { color: var(--accent-ink); background: var(--accent); }
  .status--pending { color: var(--text-secondary); border: 1px solid var(--border); }
  .status--cancelled, .status--refunded { color: var(--error); border: 1px solid var(--error); }
  .o-total { font-size: 0.8125rem; font-weight: 700; color: var(--text); white-space: nowrap; }
</style>
