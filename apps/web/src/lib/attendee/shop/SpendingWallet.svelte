<script lang="ts">
  /**
   * Spending-wallet view — the attendee's active tap-to-pay authorisations. Lists
   * each spend permission (cap / spent / remaining), lets them re-show the staff
   * scan code, and revoke. Non-custodial: USDC never left their wallet; a
   * permission is a capped, revocable pull authorisation. Passkey accounts only.
   */
  import type { ShopSpendPermission } from "@woco/shared";
  import { onMount } from "svelte";
  import { getMySpendPermissions, revokeSpendPermission } from "../../api/shop-spend-permission.js";
  import { getShop } from "../../api/shops.js";

  type Phase = "loading" | "ready" | "error";
  let phase = $state<Phase>("loading");
  let perms = $state<ShopSpendPermission[]>([]);
  let shopNames = $state<Record<string, string>>({});
  let errorMsg = $state("");
  let revoking = $state<string | null>(null);
  let qrFor = $state<string | null>(null);
  let qrSvg = $state<string | null>(null);

  const DECIMALS = 6;
  const usdc = (atomic: string) => (Number(atomic) / 10 ** DECIMALS);

  function status(p: ShopSpendPermission): "active" | "revoked" | "expired" | "spent" {
    if (p.revoked) return "revoked";
    if (p.validUntil * 1000 < Date.now()) return "expired";
    if (Number(p.spentAtomic) >= Number(p.capAtomic)) return "spent";
    return "active";
  }

  function expiry(unix: number): string {
    try {
      return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(unix * 1000));
    } catch { return String(unix); }
  }

  onMount(async () => {
    try {
      perms = await getMySpendPermissions();
      // Resolve shop names for the cards (best-effort, deduped).
      const ids = [...new Set(perms.map((p) => p.shopId))];
      const entries = await Promise.all(ids.map(async (id) => [id, (await getShop(id))?.name ?? id] as const));
      shopNames = Object.fromEntries(entries);
      phase = "ready";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Couldn't load your tap-to-pay";
      phase = "error";
    }
  });

  async function revoke(p: ShopSpendPermission) {
    if (revoking) return;
    revoking = p.permissionId;
    try {
      await revokeSpendPermission(p.shopId, p.permissionId);
      perms = perms.map((x) => x.permissionId === p.permissionId ? { ...x, revoked: true } : x);
      if (qrFor === p.permissionId) { qrFor = null; qrSvg = null; }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Revoke failed";
    } finally { revoking = null; }
  }

  async function toggleCode(p: ShopSpendPermission) {
    if (qrFor === p.permissionId) { qrFor = null; qrSvg = null; return; }
    qrFor = p.permissionId; qrSvg = null;
    try {
      const { renderSVG } = await import("uqr");
      qrSvg = renderSVG(`woco-spend-v1:${p.shopId}:${p.permissionId}`, { ecc: "M", blackColor: "#0B0B09", whiteColor: "#ffffff" });
    } catch { qrSvg = null; }
  }
</script>

<section class="wallet">
  <header class="wallet-head">
    <span class="kicker">Tap to pay</span>
    <span class="sub">Spending caps you've authorised. Funds stay in your wallet until spent.</span>
  </header>

  {#if phase === "loading"}
    <div class="state mono">Loading…</div>
  {:else if phase === "error"}
    <div class="err-box mono">{errorMsg}</div>
  {:else if perms.length === 0}
    <div class="empty">
      <p>No active tap-to-pay. Scan a venue's gate code to authorise a spending cap.</p>
    </div>
  {:else}
    {#if errorMsg}<div class="err-box mono">{errorMsg}</div>{/if}
    <ul class="perm-list">
      {#each perms as p (p.permissionId)}
        {@const st = status(p)}
        {@const cap = usdc(p.capAtomic)}
        {@const spent = usdc(p.spentAtomic)}
        {@const remaining = Math.max(0, cap - spent)}
        <li class="perm" class:dim={st !== "active"}>
          <div class="perm-top">
            <span class="shop">{shopNames[p.shopId] ?? p.shopId.slice(-8)}</span>
            <span class="badge badge--{st}">{st}</span>
          </div>

          <div class="amounts">
            <span class="remain mono">{remaining.toFixed(2)}<small> USDC left</small></span>
            <span class="of mono">of {cap.toFixed(2)} cap</span>
          </div>
          <div class="bar"><span class="bar-fill" style="width:{cap > 0 ? Math.min(100, (spent / cap) * 100) : 0}%"></span></div>

          <div class="meta">
            <span class="mono">{spent.toFixed(2)} spent</span>
            <span class="mono">expires {expiry(p.validUntil)}</span>
          </div>

          {#if st === "active"}
            <div class="actions">
              <button class="btn btn--ghost btn--sm" onclick={() => toggleCode(p)}>
                {qrFor === p.permissionId ? "Hide code" : "Show code"}
              </button>
              <button class="btn btn--ghost btn--sm danger" onclick={() => revoke(p)} disabled={revoking === p.permissionId}>
                {revoking === p.permissionId ? "Revoking…" : "Revoke"}
              </button>
            </div>
            {#if qrFor === p.permissionId && qrSvg}
              <div class="qr">{@html qrSvg}</div>
              <span class="qr-hint">Show this to staff to pay</span>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .wallet { display: flex; flex-direction: column; gap: 0.875rem; }
  .wallet-head { display: flex; flex-direction: column; gap: 0.2rem; }
  .kicker { font-family: var(--font-mono); font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); }
  .sub { font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.4; }

  .state, .empty p { color: var(--text-muted); font-size: 0.8125rem; margin: 0; }
  .empty { padding: 1rem 0; }
  .err-box { background: var(--error-subtle); color: var(--error); border: 1px solid var(--error); border-radius: var(--radius-sm); padding: 0.5rem 0.75rem; font-size: 0.6875rem; }

  .perm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.625rem; }
  .perm { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.875rem; background: var(--bg-surface); display: flex; flex-direction: column; gap: 0.5rem; }
  .perm.dim { opacity: 0.62; }

  .perm-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .shop { font-size: 0.9375rem; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-family: var(--font-mono); font-size: 0.5rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; padding: 0.1rem 0.35rem; border-radius: 2px; flex-shrink: 0; }
  .badge--active { color: var(--accent-ink); background: var(--accent); }
  .badge--revoked, .badge--expired { color: var(--text-secondary); border: 1px solid var(--border); }
  .badge--spent { color: var(--text-secondary); border: 1px solid var(--border); }

  .amounts { display: flex; align-items: baseline; gap: 0.5rem; }
  .remain { font-size: 1.375rem; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
  .remain small { font-size: 0.625rem; font-weight: 600; color: var(--text-muted); letter-spacing: 0.04em; }
  .of { font-size: 0.6875rem; color: var(--text-muted); }

  .bar { height: 4px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--accent); }

  .meta { display: flex; justify-content: space-between; font-size: 0.625rem; color: var(--text-muted); }

  .actions { display: flex; gap: 0.375rem; margin-top: 0.125rem; }
  .danger:hover { color: var(--error); border-color: var(--error); }

  .qr { background: #fff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.625rem; width: 148px; height: 148px; display: grid; place-items: center; align-self: center; margin-top: 0.25rem; }
  .qr :global(svg) { width: 100%; height: 100%; display: block; }
  .qr-hint { font-size: 0.625rem; color: var(--text-muted); text-align: center; }
</style>
