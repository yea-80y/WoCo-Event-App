<script lang="ts">
  import type { ShopDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { getMyShops } from "../../api/shops.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";

  const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

  type Phase = "loading" | "ready" | "unauth" | "error";
  let phase = $state<Phase>("loading");
  let shops = $state<ShopDirectoryEntry[]>([]);
  let error = $state("");

  async function load() {
    if (!auth.isConnected || !auth.parent) { phase = "unauth"; return; }
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) { phase = "unauth"; return; }
    }
    const addr = auth.parent.toLowerCase();
    const cached = cacheGet<ShopDirectoryEntry[]>(cacheKey.creatorShops(addr));
    if (cached) {
      shops = cached;
      phase = "ready";
    }
    try {
      const fresh = await getMyShops();
      cacheSet(cacheKey.creatorShops(addr), fresh, TTL.CREATOR_SHOPS);
      shops = fresh;
      phase = "ready";
    } catch (e) {
      if (phase !== "ready") {
        error = e instanceof Error ? e.message : "Failed to load shops";
        phase = "error";
      }
    }
  }

  onMount(load);
</script>

<div class="my-shops">
  <div class="page-head">
    <div class="head-left">
      <h1>My shops</h1>
      <span class="kicker">Manage catalogs · POS · Spend permissions</span>
    </div>
    <button class="btn btn--primary" onclick={() => navigate("/creator/shops/new")}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M6 1v10M1 6h10" /></svg>
      New shop
    </button>
  </div>

  {#if phase === "loading"}
    <div class="grid">
      {#each Array(3) as _, i}
        <div class="skeleton" style="animation-delay:{i * 0.1}s"></div>
      {/each}
    </div>

  {:else if phase === "unauth"}
    <div class="empty-state">
      <span class="kicker">Not connected</span>
      <p>Connect your wallet to manage your shops.</p>
    </div>

  {:else if phase === "error"}
    <div class="empty-state error">
      <span class="kicker">Error</span>
      <p class="mono">{error}</p>
    </div>

  {:else if shops.length === 0}
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
          <rect x="3" y="8" width="22" height="17" />
          <path d="M3 8l3-5h16l3 5" />
          <path d="M10 8v4a4 4 0 008 0V8" />
        </svg>
      </div>
      <p>No shops yet. A shop is one catalog you can sell from a POS, a standalone page, or your website.</p>
      <button class="btn btn--primary" onclick={() => navigate("/creator/shops/new")}>Create your first shop</button>
    </div>

  {:else}
    <div class="grid">
      {#each shops as s (s.shopId)}
        <div class="shop-card">
          <div class="card-head">
            <span class="shop-name">{s.name}</span>
            <span class="currency mono">{SYMBOLS[s.currency] ?? s.currency}</span>
          </div>
          <div class="card-meta">
            <span class="meta-item mono">{s.productCount} product{s.productCount !== 1 ? "s" : ""}</span>
            {#if s.deployedUrl}
              <span class="meta-sep">·</span>
              <a class="meta-link mono" href={s.deployedUrl} target="_blank" rel="noopener">live site</a>
            {/if}
          </div>
          <div class="card-actions">
            <button
              class="btn btn--ghost btn--sm"
              onclick={() => navigate(`/creator/shops/${s.shopId}`)}
            >
              Manage
            </button>
            <button
              class="btn btn--primary btn--sm pos-btn"
              onclick={() => navigate(`/creator/shops/${s.shopId}/pos`)}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square">
                <rect x="1" y="3" width="9" height="7" />
                <path d="M1 3L3.5 1h4L10 3" />
                <path d="M3.5 3v2.5A2 2 0 007.5 5.5V3" />
              </svg>
              Open POS
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .my-shops { padding: 1.5rem; max-width: 900px; }

  .page-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .head-left { display: flex; flex-direction: column; gap: 0.25rem; }
  h1 { margin: 0; font-size: 1.375rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; }
  .kicker {
    font-family: var(--font-mono); font-size: 0.5625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.75rem;
  }

  /* ── shop card ── */
  .shop-card {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 1rem;
    display: flex; flex-direction: column; gap: 0.625rem;
    transition: border-color 0.12s;
  }
  .shop-card:hover { border-color: var(--border-hover); }

  .card-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem;
  }
  .shop-name {
    font-size: 1rem; font-weight: 700; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .currency {
    font-size: 1.125rem; font-weight: 700; color: var(--accent-text); flex-shrink: 0;
  }
  .card-meta { display: flex; align-items: center; gap: 0.375rem; }
  .meta-item { font-size: 0.6875rem; color: var(--text-muted); }
  .meta-sep { color: var(--text-dim); font-size: 0.75rem; }
  .meta-link { font-size: 0.6875rem; color: var(--text-muted); text-decoration: none; }
  .meta-link:hover { color: var(--accent-text); }

  .card-actions { display: flex; gap: 0.375rem; margin-top: 0.25rem; }
  .pos-btn { display: inline-flex; align-items: center; gap: 0.375rem; }

  /* ── skeleton ── */
  .skeleton {
    height: 8rem; border-radius: var(--radius-md);
    background: linear-gradient(90deg, var(--bg-surface) 25%, color-mix(in srgb, var(--border) 60%, var(--bg-surface)) 50%, var(--bg-surface) 75%);
    background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* ── empty states ── */
  .empty-state {
    text-align: center; padding: 3rem 1rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  }
  .empty-state p { margin: 0; font-size: 0.875rem; color: var(--text-secondary); max-width: 320px; }
  .empty-state.error p { color: var(--error); font-size: 0.75rem; }
  .empty-icon { color: var(--text-dim); margin-bottom: 0.25rem; }
</style>
