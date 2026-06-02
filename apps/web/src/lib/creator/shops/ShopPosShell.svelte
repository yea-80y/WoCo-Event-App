<script lang="ts">
  /**
   * POS shell — operator auth gate + data loader for ShopPos.
   *
   * This component:
   *   1. Verifies creator auth (ensureSession) so the POS is operator-only.
   *   2. Loads shop + products from the API.
   *   3. Wires placeAndCharge: POST /api/shops/:id/orders (rail "crypto")
   *      then paySpendPermission() from api/shop-spend-permission.ts.
   *   4. Mounts ShopPos — all UX lives there.
   *
   * ⛔ No signature/spend-permission logic lives here — only calling the API.
   */
  import type { Shop, Product } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { getShop, getProducts, createOrderAuth } from "../../api/shops.js";
  import { paySpendPermission } from "../../api/shop-spend-permission.js";
  import ShopPos from "../../components/shop/pos/ShopPos.svelte";
  import type { PosCartLine, PlaceAndChargeResult } from "../../components/shop/pos/ShopPos.svelte";
  import { onMount } from "svelte";

  interface Props {
    shopId: string;
  }

  let { shopId }: Props = $props();

  type Phase = "loading" | "auth" | "ready" | "error";
  let phase = $state<Phase>("loading");
  let shop = $state<Shop | null>(null);
  let products = $state<Product[]>([]);
  let errorMsg = $state("");

  async function load() {
    if (!auth.isConnected || !auth.parent) { phase = "auth"; return; }
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) { phase = "auth"; return; }
    }
    try {
      const [s, ps] = await Promise.all([getShop(shopId), getProducts(shopId)]);
      if (!s) { errorMsg = "Shop not found"; phase = "error"; return; }
      shop = s;
      products = ps;
      phase = "ready";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load shop";
      phase = "error";
    }
  }

  onMount(load);

  async function placeAndCharge(
    lines: PosCartLine[],
    permissionId: string,
  ): Promise<PlaceAndChargeResult> {
    try {
      const lineReqs = lines.map((l) => ({ productId: l.productId, qty: l.qty }));
      const order = await createOrderAuth(shopId, lineReqs);
      const settled = await paySpendPermission(shopId, order.orderId, permissionId);
      return { ok: true, code: settled.code };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Payment failed" };
    }
  }
</script>

<div class="pos-shell">
  {#if phase === "loading"}
    <div class="center-msg">
      <span class="mono">Loading POS…</span>
    </div>

  {:else if phase === "auth"}
    <div class="center-msg">
      <span class="kicker">Operator access required</span>
      <p>You need to be signed in as the shop owner to use the POS.</p>
      <button class="btn btn--primary" onclick={() => auth.ensureSession()}>Connect wallet</button>
    </div>

  {:else if phase === "error"}
    <div class="center-msg error">
      <span class="kicker">Error</span>
      <p class="mono">{errorMsg}</p>
      <button class="btn btn--ghost" onclick={() => navigate("/creator/shops")}>
        ← Back to shops
      </button>
    </div>

  {:else if phase === "ready" && shop}
    <div class="pos-wrapper">
      <div class="pos-nav">
        <button class="back-btn" onclick={() => navigate("/creator/shops")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
            <path d="M8 1L3 6l5 5" />
          </svg>
          My shops
        </button>
        <span class="shop-name">{shop.name}</span>
        <span class="kicker pos-badge">POS</span>
      </div>
      <div class="pos-body">
        <ShopPos {shop} {products} {placeAndCharge} />
      </div>
    </div>
  {/if}
</div>

<style>
  .pos-shell { display: flex; flex-direction: column; height: 100%; }

  .center-msg {
    display: flex; flex-direction: column; align-items: center; text-align: center;
    padding: 4rem 1.5rem; gap: 0.75rem;
  }
  .center-msg p { margin: 0; font-size: 0.875rem; color: var(--text-secondary); }
  .center-msg.error p { color: var(--error); font-size: 0.75rem; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }

  .pos-wrapper { display: flex; flex-direction: column; flex: 1; min-height: 0; }

  .pos-nav {
    display: flex; align-items: center; gap: 0.875rem;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .back-btn {
    display: inline-flex; align-items: center; gap: 0.375rem;
    background: none; border: none; color: var(--text-muted);
    font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.1em; cursor: pointer;
    padding: 0.25rem;
  }
  .back-btn:hover { color: var(--text); }
  .shop-name { font-size: 0.9375rem; font-weight: 700; color: var(--text); flex: 1; }
  .pos-badge {
    padding: 0.1875rem 0.5rem;
    background: var(--accent); color: var(--accent-ink);
    border-radius: var(--radius-sm);
  }

  .pos-body { flex: 1; min-height: 0; overflow: hidden; }
</style>
