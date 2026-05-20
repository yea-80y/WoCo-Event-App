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
    if (elapsed < 4) return "Allocating storage on Swarm…";
    if (elapsed < 12) return "Registering on Gnosis chain…";
    return `Propagating across the network… (${elapsed}s)`;
  }

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
        else previewError = r.error ?? "Could not load storage preview";
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

  async function handleActivate() {
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
        error = res.error ?? "Activation failed";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Activation failed";
    } finally {
      busy = false;
      stopTimer();
    }
  }
</script>

{#if open}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="pb-title">
    <div class="modal">

      <div class="early-badge">
        <span class="pulse-dot"></span>
        Early Access — Free
      </div>

      <div class="header">
        <h2 id="pb-title" class="title">Activate website hosting</h2>
        <p class="intro">
          Your site will be stored across Swarm's decentralised network.
          Activating allocates a dedicated storage window — covers every page
          and event you publish under this account.
        </p>
      </div>

      {#if preview}
        <dl class="spec">
          <div class="spec-row">
            <dt>Storage depth</dt>
            <dd>{preview.depth}</dd>
          </div>
          <div class="spec-row">
            <dt>Active window</dt>
            <dd>{formatTtl(preview.ttlDays)}</dd>
          </div>
        </dl>
      {:else if previewError}
        <div class="err">{previewError}</div>
      {:else}
        <dl class="spec loading">
          <div class="spec-row"><dt>Loading storage info…</dt><dd></dd></div>
        </dl>
      {/if}

      <div class="notice">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="notice-icon">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M8 5.5v3.5M8 10.5v.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <span>Hosting activation will move behind a payment gateway in a future release.</span>
      </div>

      {#if receipt}
        <div class="ok">
          <div class="ok-title">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" stroke="#22c55e" stroke-width="1.4"/>
              <path d="M5.25 8l2 2 3.5-3.5" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <strong>Storage activated</strong>
          </div>
          <code>{receipt.batchId.slice(0, 12)}…</code>
        </div>
      {/if}

      {#if error}
        <div class="err">{error}</div>
      {/if}

      <div class="actions">
        <button class="btn-ghost" onclick={onclose} disabled={busy}>Cancel</button>
        {#if !receipt}
          <button class="btn-primary" onclick={handleActivate} disabled={busy || !preview}>
            {#if busy}
              <span class="spinner"></span>
              {busyLabel()}
            {:else}
              Activate hosting
            {/if}
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
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; padding: 1rem;
    animation: overlay-in 0.18s ease both;
  }

  @keyframes overlay-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .modal {
    background: var(--bg-elevated, #18181b);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    max-width: 440px; width: 100%;
    padding: 1.5rem;
    display: flex; flex-direction: column; gap: 1rem;
    animation: modal-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes modal-in {
    from { opacity: 0; transform: translateY(8px) scale(0.99); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .early-badge {
    align-self: flex-start;
    display: inline-flex; align-items: center; gap: 0.375rem;
    font-size: 0.6875rem; font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--accent, #C7F23A);
    background: color-mix(in srgb, var(--accent, #C7F23A) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #C7F23A) 28%, transparent);
    border-radius: 999px;
    padding: 0.2rem 0.6rem 0.2rem 0.5rem;
  }

  .pulse-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent, #C7F23A);
    animation: dot-pulse 2.4s ease-in-out infinite;
  }

  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.45; transform: scale(0.8); }
  }

  .header { display: flex; flex-direction: column; gap: 0.375rem; }

  .title { margin: 0; font-size: 1.0625rem; font-weight: 700; letter-spacing: -0.01em; }

  .intro { margin: 0; font-size: 0.8125rem; line-height: 1.6; color: var(--text-secondary); }

  .spec {
    margin: 0; padding: 0.75rem 0.875rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    display: flex; flex-direction: column; gap: 0.5rem;
    transition: opacity 0.2s;
  }

  .spec.loading { opacity: 0.45; }

  .spec-row {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 0.8125rem;
  }

  .spec-row dt { color: var(--text-muted); margin: 0; }

  .spec-row dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }

  .notice {
    display: flex; align-items: flex-start; gap: 0.5rem;
    padding: 0.5625rem 0.75rem;
    background: color-mix(in srgb, var(--text-muted, #888) 5%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    font-size: 0.75rem; line-height: 1.55;
    color: var(--text-muted);
  }

  .notice-icon { flex-shrink: 0; margin-top: 0.125em; opacity: 0.65; }

  .ok {
    padding: 0.625rem 0.75rem; font-size: 0.8125rem;
    background: color-mix(in srgb, #22c55e 9%, transparent);
    border: 1px solid color-mix(in srgb, #22c55e 22%, transparent);
    border-radius: var(--radius-sm, 8px);
    display: flex; flex-direction: column; gap: 0.3rem;
  }

  .ok-title { display: flex; align-items: center; gap: 0.375rem; }

  .ok code {
    font-family: monospace; font-size: 0.7125rem;
    color: var(--text-muted); padding-left: 1.375rem;
  }

  .err {
    padding: 0.5625rem 0.75rem; font-size: 0.8125rem;
    background: color-mix(in srgb, #ef4444 10%, transparent);
    border: 1px solid color-mix(in srgb, #ef4444 28%, transparent);
    border-radius: var(--radius-sm, 8px);
    color: #ef4444;
  }

  .actions {
    display: flex; justify-content: flex-end; gap: 0.5rem;
    margin-top: 0.125rem;
  }

  .btn-primary {
    display: inline-flex; align-items: center; gap: 0.4375rem;
    padding: 0.5rem 1.125rem; font-size: 0.875rem; font-weight: 600;
    background: var(--accent, #C7F23A); color: var(--accent-ink, #0a0a0a);
    border-radius: var(--radius-sm, 8px);
    transition: opacity 0.14s;
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.85; }

  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost {
    padding: 0.5rem 0.875rem; font-size: 0.875rem;
    border: 1px solid var(--border); color: var(--text-muted);
    border-radius: var(--radius-sm, 8px);
    transition: border-color 0.14s, color 0.14s;
  }

  .btn-ghost:hover:not(:disabled) { border-color: var(--text-muted); color: var(--text); }

  .btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }

  .spinner {
    width: 12px; height: 12px; flex-shrink: 0;
    border: 1.75px solid color-mix(in srgb, var(--accent-ink, #0a0a0a) 22%, transparent);
    border-top-color: var(--accent-ink, #0a0a0a);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
