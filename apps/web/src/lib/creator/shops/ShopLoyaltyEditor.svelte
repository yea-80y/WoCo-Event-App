<script lang="ts">
  /**
   * ShopLoyaltyEditor — configure spend-milestone badges + the display earn rate.
   *
   * Points are DERIVED (never stored), so this only declares: the earn rate (UI
   * display) and the cumulative-spend thresholds that mint a badge POD. Each
   * threshold references a badge POD the merchant already created (Item A); we
   * snapshot its resolved on-chain coordinates (manifestRef + eventId + chainId)
   * so the server can mint editions — only on-chain PODs are eligible.
   *
   * Card buyers earn points but no on-chain badge (no wallet); the panel says so.
   */
  import type { Shop, SpendThresholdReward, PodDirectoryEntry } from "@woco/shared";
  import { updateShop } from "../../api/shops.js";
  import { getMyPods } from "../../api/pod.js";
  import { onMount } from "svelte";

  interface Props {
    shop: Shop;
    onShopUpdate: (shop: Shop) => void;
  }
  let { shop, onShopUpdate }: Props = $props();

  const SYM: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };
  const sym = $derived(SYM[shop.currency] ?? "");

  // One-time capture of the loyalty config as first rendered — the form is a
  // local draft; later prop refreshes must not clobber in-progress edits.
  // svelte-ignore state_referenced_locally
  const initialLoyalty = shop.loyalty;
  let enabled = $state(initialLoyalty?.enabled ?? false);
  let earnRate = $state<number>(initialLoyalty?.earnRate ?? 0);
  // Local editable copy of the thresholds.
  let rows = $state<SpendThresholdReward[]>(
    (initialLoyalty?.spendThresholds ?? []).map((t) => ({ ...t })),
  );

  let badges = $state<PodDirectoryEntry[]>([]);
  let podsPhase = $state<"loading" | "ready" | "error">("loading");
  let saving = $state(false);
  let error = $state("");
  let saved = $state(false);

  onMount(async () => {
    try {
      const dir = await getMyPods();
      // Only on-chain PODs can be minted as awards. Badges/collectibles are the
      // natural reward kinds, but any on-chain POD type is allowed.
      badges = dir.pods.filter((p) => p.eventId && p.chainId);
      podsPhase = "ready";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't load your PODs";
      podsPhase = "error";
    }
  });

  function addRow() {
    rows = [...rows, { threshold: "", badgeManifestRef: "", badgeEventId: "", chainId: 0 }];
  }
  function removeRow(i: number) {
    rows = rows.filter((_, idx) => idx !== i);
  }

  /** Resolve the chosen badge POD into the row's stored coordinates. */
  function pickBadge(i: number, manifestRef: string) {
    const pod = badges.find((b) => b.manifestRef === manifestRef);
    rows = rows.map((r, idx) =>
      idx === i
        ? {
            ...r,
            badgeManifestRef: pod?.manifestRef ?? "",
            badgeEventId: pod?.eventId ?? "",
            chainId: pod?.chainId ?? 0,
            badgeName: pod?.name,
          }
        : r,
    );
  }

  const valid = $derived(
    !enabled ||
      rows.every(
        (r) => r.threshold.trim() && Number(r.threshold) > 0 && r.badgeManifestRef && r.badgeEventId && r.chainId > 0,
      ),
  );

  async function save() {
    if (!valid) {
      error = "Every milestone needs a positive amount and a badge.";
      return;
    }
    saving = true; error = ""; saved = false;
    try {
      const updated = await updateShop(shop.shopId, {
        loyalty: {
          enabled,
          ...(earnRate > 0 ? { earnRate } : {}),
          spendThresholds: enabled
            ? rows.map((r) => ({
                threshold: r.threshold.trim(),
                badgeManifestRef: r.badgeManifestRef,
                badgeEventId: r.badgeEventId,
                chainId: r.chainId,
                ...(r.badgeName ? { badgeName: r.badgeName } : {}),
              }))
            : [],
        },
      });
      onShopUpdate(updated);
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't save loyalty";
    } finally {
      saving = false;
    }
  }
</script>

<div class="loyalty">
  <label class="row-toggle">
    <input type="checkbox" bind:checked={enabled} />
    <span class="rt-label">Loyalty enabled</span>
    <span class="rt-hint">Reward repeat spend with badge PODs at cumulative-spend milestones.</span>
  </label>

  {#if enabled}
    <label class="field">
      <span class="f-label kicker--plain">Points per {sym}1 (display only)</span>
      <input class="input input--sm" type="number" min="0" step="1" bind:value={earnRate} placeholder="e.g. 10" />
      <span class="hint">Shown to customers as their points balance. Derived from spend — not stored. Milestones below trigger on spend, not points.</span>
    </label>

    <div class="section-head">
      <span class="kicker">Spend milestones</span>
      <span class="count mono">{rows.length}</span>
    </div>

    {#if podsPhase === "loading"}
      <p class="hint">Loading your badge PODs…</p>
    {:else if podsPhase === "error"}
      <p class="err-box mono">{error}</p>
    {:else if badges.length === 0}
      <p class="hint">
        No on-chain PODs yet — create a badge in the <a href="/creator/pods">POD manager</a> first.
        Only on-chain PODs can be minted as rewards.
      </p>
    {:else}
      {#each rows as row, i (i)}
        <div class="mrow">
          <div class="m-amount">
            <span class="m-sym">{sym}</span>
            <input
              class="input input--sm"
              type="text"
              inputmode="decimal"
              bind:value={row.threshold}
              placeholder="50.00"
              aria-label="Spend threshold"
            />
          </div>
          <span class="m-arrow">→</span>
          <select
            class="input input--sm m-badge"
            value={row.badgeManifestRef}
            onchange={(e) => pickBadge(i, (e.target as HTMLSelectElement).value)}
            aria-label="Badge to award"
          >
            <option value="">— pick a badge —</option>
            {#each badges as b (b.manifestRef)}
              <option value={b.manifestRef}>{b.name}</option>
            {/each}
          </select>
          <button class="del-btn" onclick={() => removeRow(i)} aria-label="Remove milestone">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 1l9 9M10 1L1 10" /></svg>
          </button>
        </div>
      {/each}
      <button class="btn btn--ghost btn--sm self-start" onclick={addRow}>+ Add milestone</button>

      <p class="hint card-note">
        Badges mint on-chain to the buyer's wallet, so they apply to crypto / tap-to-pay
        purchases. Card buyers still earn points — they receive the badge once they pay
        from a wallet.
      </p>
    {/if}
  {/if}

  {#if error}<p class="err-box mono">{error}</p>{/if}

  <div class="foot">
    {#if saved}<span class="saved-pill">Saved</span>{/if}
    <button class="btn btn--primary btn--sm self-start" onclick={save} disabled={saving || !valid}>
      {saving ? "Saving…" : "Save loyalty"}
    </button>
  </div>
</div>

<style>
  .loyalty { display: flex; flex-direction: column; gap: 14px; }
  .row-toggle {
    display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem; flex-wrap: wrap; cursor: pointer;
  }
  .row-toggle input { margin-top: 0.15rem; width: 0.9rem; height: 0.9rem; accent-color: var(--accent); flex-shrink: 0; }
  .rt-label { font-size: 0.8125rem; font-weight: 600; color: var(--text); }
  .rt-hint { font-size: 0.75rem; color: var(--text-muted); width: 100%; margin-left: 1.4rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .f-label { font-size: 0.8125rem; font-weight: 500; color: var(--text-secondary); }
  .hint { font-size: 0.72rem; color: var(--text-muted); line-height: 1.45; margin: 0; }
  .hint a { color: var(--accent-text); }
  .card-note { border-left: 2px solid var(--border); padding-left: 0.6rem; }
  .input {
    background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); font-family: inherit; font-size: 0.8125rem; padding: 0.375rem 0.5rem;
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .input--sm { font-size: 0.8125rem; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
  .kicker { font-family: var(--font-mono); font-size: 0.66rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
  .count { color: var(--text-dim); font-size: 0.72rem; }
  .mrow { display: flex; align-items: center; gap: 0.5rem; }
  .m-amount { position: relative; display: flex; align-items: center; }
  .m-sym { position: absolute; left: 0.5rem; font-size: 0.8125rem; color: var(--text-muted); pointer-events: none; }
  .m-amount .input { padding-left: 1.2rem; width: 6rem; }
  .m-arrow { color: var(--text-dim); }
  .m-badge { flex: 1; min-width: 0; cursor: pointer; }
  .del-btn {
    display: grid; place-items: center; width: 26px; height: 26px; flex-shrink: 0;
    border-radius: var(--radius-sm); border: 1px solid transparent; background: transparent;
    color: var(--error); cursor: pointer;
  }
  .del-btn:hover { border-color: var(--error); background: rgba(255,80,60,0.07); }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-display);
    font-weight: 600; font-size: 0.86rem; padding: 8px 14px; border-radius: var(--radius-md);
    border: 1px solid transparent; cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn--primary { background: var(--accent); color: var(--accent-ink); }
  .btn--ghost { background: transparent; color: var(--text); border-color: var(--border-hover); }
  .btn--sm { font-size: 0.78rem; padding: 6px 11px; }
  .self-start { align-self: flex-start; }
  .foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .saved-pill { font-size: 0.72rem; color: var(--success); font-family: var(--font-mono); }
  .err-box { font-size: 0.78rem; color: var(--error); margin: 0; }
</style>
