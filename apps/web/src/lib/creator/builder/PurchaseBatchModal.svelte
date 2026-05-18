<script lang="ts">
  import { purchaseEthernaBatch, getPurchasePreview, type PurchasePreview } from "../../api/etherna.js";

  interface Props {
    open: boolean;
    onclose: () => void;
    onpurchased: () => void;
  }

  let { open, onclose, onpurchased }: Props = $props();

  let preview = $state<PurchasePreview | null>(null);
  let previewError = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let receipt = $state<{ batchId: string; expiresAt: string; debit: string; estimatedBZZ?: string } | null>(null);
  let elapsed = $state(0);
  let elapsedInterval: ReturnType<typeof setInterval> | null = null;

  function startTimer() {
    elapsed = 0;
    elapsedInterval = setInterval(() => { elapsed += 1; }, 1000);
  }
  function stopTimer() {
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  }

  function busyLabel(): string {
    if (elapsed < 4) return "Contacting Etherna…";
    if (elapsed < 12) return "Purchasing batch on Gnosis chain…";
    return `Waiting for batch to propagate… (${elapsed}s)`;
  }

  // Fetch preview whenever the modal opens fresh (clears any prior receipt).
  $effect(() => {
    if (!open) return;
    receipt = null;
    error = null;
    preview = null;
    previewError = null;
    (async () => {
      try {
        const r = await getPurchasePreview();
        if (r.ok && r.data) preview = r.data;
        else previewError = r.error ?? "Could not load batch preview";
      } catch (e) {
        previewError = e instanceof Error ? e.message : "Preview failed";
      }
    })();
  });

  function formatTtl(d: number): string {
    if (d >= 1) {
      const days = Math.floor(d);
      const extraHours = Math.round((d - days) * 24);
      return extraHours > 0 ? `${days}d ${extraHours}h` : `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${Math.round(d * 24)}h`;
  }

  async function handleBuy() {
    if (busy) return;
    busy = true;
    error = null;
    startTimer();
    try {
      const res = await purchaseEthernaBatch();
      if (res.ok && res.data) {
        receipt = res.data;
        onpurchased();
      } else {
        error = res.error ?? "Purchase failed";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Purchase failed";
    } finally {
      busy = false;
      stopTimer();
    }
  }
</script>

{#if open}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="pb-title">
    <div class="modal">
      <h2 id="pb-title" class="title">Buy your hosting batch</h2>
      <p class="intro">
        Your website is hosted on Swarm via Etherna. You need a postage batch — it
        funds the chunks that store your site for a fixed window. One batch covers
        every website and event you publish. Purchase takes 1–3 minutes while the
        batch propagates on the Gnosis chain.
      </p>

      {#if preview}
        <dl class="spec">
          <div><dt>Batch depth</dt><dd>{preview.depth}</dd></div>
          <div><dt>Time to live</dt><dd>{formatTtl(preview.ttlDays)}</dd></div>
          <div><dt>Est. committed</dt><dd>≈ {preview.estimatedBZZ} BZZ</dd></div>
          <div><dt>Safety cap</dt><dd>≤ {preview.maxBZZ} BZZ</dd></div>
        </dl>
      {:else if previewError}
        <div class="err">{previewError}</div>
      {:else}
        <div class="spec"><div><dt>Loading batch preview…</dt><dd></dd></div></div>
      {/if}

      {#if receipt}
        <div class="ok">
          <strong>Batch purchased ✓</strong>
          <code>{receipt.batchId.slice(0, 12)}…</code>
          <span class="debit">Debit: {receipt.debit} xDai{receipt.estimatedBZZ ? ` (${receipt.estimatedBZZ} BZZ committed)` : ''}</span>
        </div>
      {/if}

      {#if error}
        <div class="err">{error}</div>
      {/if}

      <div class="actions">
        <button class="btn-ghost" onclick={onclose} disabled={busy}>Cancel</button>
        {#if !receipt}
          <button class="btn-primary" onclick={handleBuy} disabled={busy || !preview}>
            {busy ? busyLabel() : "Buy batch"}
          </button>
        {:else}
          <button class="btn-primary" onclick={onclose}>Continue</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; padding: 1rem;
  }
  .modal {
    background: var(--bg-elevated, #18181b);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    max-width: 460px; width: 100%;
    padding: 1.5rem;
    display: flex; flex-direction: column; gap: 1rem;
  }
  .title { margin: 0; font-size: 1.125rem; font-weight: 700; }
  .intro { margin: 0; font-size: 0.875rem; line-height: 1.5; color: var(--text-secondary); }
  .spec {
    margin: 0; padding: 0.75rem 0.875rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    display: flex; flex-direction: column; gap: 0.375rem;
  }
  .spec div { display: flex; justify-content: space-between; font-size: 0.8125rem; }
  .spec dt { color: var(--text-muted); margin: 0; }
  .spec dd { margin: 0; font-weight: 600; }
  .ok {
    padding: 0.625rem 0.75rem; font-size: 0.8125rem;
    background: color-mix(in srgb, #22c55e 12%, transparent);
    border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
    border-radius: var(--radius-sm, 8px);
    display: flex; flex-direction: column; gap: 0.25rem;
  }
  .ok code { font-family: monospace; font-size: 0.75rem; }
  .ok .debit { color: var(--text-muted); font-size: 0.75rem; }
  .err {
    padding: 0.625rem 0.75rem; font-size: 0.8125rem;
    background: color-mix(in srgb, #ef4444 12%, transparent);
    border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
    border-radius: var(--radius-sm, 8px);
    color: #ef4444;
  }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .btn-primary {
    padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 600;
    background: var(--accent); color: var(--accent-ink, #fff);
    border-radius: var(--radius-sm, 8px);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost {
    padding: 0.5rem 0.875rem; font-size: 0.875rem;
    border: 1px solid var(--border); color: var(--text-muted);
    border-radius: var(--radius-sm, 8px);
  }
  .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
