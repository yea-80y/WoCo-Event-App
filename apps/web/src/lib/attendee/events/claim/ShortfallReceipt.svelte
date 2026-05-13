<script lang="ts">
  import type { PaymentChainId } from "@woco/shared";
  import { CHAIN_NAMES } from "@woco/shared";
  import { explorerUrl, shortHash, copyToClipboard } from "./helpers.js";

  interface ShortfallData {
    txHash: string;
    chainId: PaymentChainId;
    paid: string;
    expected: string;
    currency: string;
    at: string;
  }

  interface Props {
    data: ShortfallData;
    onretry: () => void;
    ondismiss: () => void;
  }

  let { data, onretry, ondismiss }: Props = $props();
</script>

<!--
  Ledger-receipt card for an on-chain payment that confirmed but was rejected
  by the server because the ETH amount was short of the slippage tolerance.
-->
<div class="receipt">
  <header class="receipt-head">
    <span class="receipt-stripe" aria-hidden="true"></span>
    <div class="receipt-head-text">
      <h3 class="receipt-title">Payment recorded, ticket pending</h3>
      <p class="receipt-sub">Your transaction confirmed on-chain — but the market moved between your sign and our verification. The amount came up short of the {data.currency} we need for this ticket.</p>
    </div>
  </header>

  <div class="receipt-body">
    <dl class="receipt-rows">
      <div class="receipt-row">
        <dt>You paid</dt>
        <dd class="mono tnum">{data.paid} {data.currency}</dd>
      </div>
      <div class="receipt-row">
        <dt>We required</dt>
        <dd class="mono tnum">{data.expected} {data.currency}</dd>
      </div>
      <div class="receipt-row receipt-row--delta">
        <dt>Shortfall</dt>
        <dd class="mono tnum">
          &minus;{(parseFloat(data.expected) - parseFloat(data.paid)).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} {data.currency}
          <span class="receipt-delta-pct">{((1 - parseFloat(data.paid) / parseFloat(data.expected)) * 100).toFixed(1)}%</span>
        </dd>
      </div>
    </dl>

    <div class="receipt-tx">
      <span class="receipt-tx-label">Transaction</span>
      <div class="receipt-tx-body">
        <code class="mono receipt-tx-hash" title={data.txHash}>{shortHash(data.txHash)}</code>
        <span class="receipt-tx-chain">on {CHAIN_NAMES[data.chainId]}</span>
      </div>
      <div class="receipt-tx-actions">
        <button type="button" class="receipt-icon-btn" onclick={() => copyToClipboard(data.txHash)} title="Copy hash">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <a
          class="receipt-icon-btn"
          href={explorerUrl(data.chainId, data.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          title="View on explorer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>
    </div>
  </div>

  <footer class="receipt-foot">
    <button type="button" class="receipt-btn receipt-btn--primary" onclick={onretry}>
      Retry with a fresh payment
    </button>
    <button type="button" class="receipt-btn receipt-btn--ghost" onclick={ondismiss}>
      Dismiss
    </button>
    <p class="receipt-note">
      Your prior transaction is irreversible &mdash; contact the event organiser if you'd like a refund rather than retrying.
    </p>
  </footer>
</div>

<style>
  .receipt {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 28rem;
    margin: 0 auto;
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-card, var(--bg)));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md);
    box-shadow:
      0 1px 0 color-mix(in srgb, var(--accent) 12%, transparent) inset,
      0 8px 24px -16px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    animation: receipt-rise 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes receipt-rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .receipt-head {
    position: relative;
    display: flex;
    gap: 0.75rem;
    padding: 0.875rem 1rem 0.75rem;
  }

  .receipt-stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: repeating-linear-gradient(
      135deg,
      var(--accent) 0 8px,
      transparent 8px 16px
    );
    opacity: 0.7;
  }

  .receipt-head-text { flex: 1; min-width: 0; }

  .receipt-title {
    margin: 0 0 0.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--text);
  }

  .receipt-sub {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .receipt-body {
    padding: 0.25rem 1rem 0.75rem;
  }

  .receipt-rows {
    margin: 0;
    padding: 0.25rem 0;
    display: flex;
    flex-direction: column;
  }

  .receipt-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 0.4375rem 0;
    font-size: 0.8125rem;
    border-bottom: 1px dashed color-mix(in srgb, var(--text-muted) 28%, transparent);
  }

  .receipt-row:last-child { border-bottom: none; }

  .receipt-row dt {
    color: var(--text-muted);
    font-size: 0.75rem;
    letter-spacing: 0.01em;
  }

  .receipt-row dd {
    margin: 0;
    color: var(--text);
    font-size: 0.8125rem;
    text-align: right;
  }

  .receipt-row--delta dt,
  .receipt-row--delta dd {
    color: var(--accent-text, var(--accent));
    font-weight: 600;
  }

  .receipt-delta-pct {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.0625rem 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--accent-text, var(--accent));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: 999px;
    vertical-align: 1px;
  }

  .receipt-tx {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-top: 0.625rem;
    padding: 0.5rem 0.625rem;
    background: color-mix(in srgb, var(--text) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
    border-radius: var(--radius-sm);
  }

  .receipt-tx-label {
    flex-shrink: 0;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .receipt-tx-body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    overflow: hidden;
  }

  .receipt-tx-hash {
    font-size: 0.75rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .receipt-tx-chain {
    font-size: 0.6875rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .receipt-tx-actions {
    display: flex;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .receipt-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .receipt-icon-btn:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 22%, transparent);
  }

  .receipt-foot {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 1rem 0.875rem;
    border-top: 1px solid color-mix(in srgb, var(--text-muted) 16%, transparent);
    background: color-mix(in srgb, var(--accent) 3%, transparent);
  }

  .receipt-btn {
    width: 100%;
    padding: 0.5625rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .receipt-btn--primary {
    background: var(--accent);
    color: var(--accent-on, #fff);
  }

  .receipt-btn--primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, #000);
  }

  .receipt-btn--ghost {
    background: transparent;
    color: var(--text-muted);
    border-color: color-mix(in srgb, var(--text-muted) 22%, transparent);
  }

  .receipt-btn--ghost:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--text-muted) 38%, transparent);
  }

  .receipt-note {
    margin: 0.125rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--text-muted);
    text-align: center;
  }

  .mono {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
  }

  .tnum {
    font-variant-numeric: tabular-nums;
  }
</style>
