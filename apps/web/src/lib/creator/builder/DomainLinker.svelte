<script lang="ts">
  import { onMount } from 'svelte';
  import type { DomainEntry } from '../../api/domains.js';
  import { registerSiteDomain, verifyDomainDns, getSiteDomains, removeDomain } from '../../api/domains.js';
  import { getProviderInstructions } from './domain-instructions.js';

  interface Props {
    siteId: string;
    contentHash: string;
    feedManifestHash?: string;
  }

  let { siteId, contentHash, feedManifestHash = '' }: Props = $props();

  let hostnameInput = $state('');
  let entry       = $state<DomainEntry | null>(null);
  let loadingInit = $state(true);
  let registering = $state(false);
  let verifying   = $state(false);
  let removing    = $state(false);
  let error       = $state('');
  let copied      = $state<string | null>(null);

  const instr = $derived(entry ? getProviderInstructions(entry.provider ?? 'Unknown') : null);

  const cnameNameField = $derived((() => {
    if (!entry) return 'www';
    const parts = entry.hostname.split('.');
    return parts.length > 2 ? parts.slice(0, -2).join('.') : '@';
  })());

  const isApex = $derived(entry ? entry.hostname.split('.').length === 2 : false);

  const providerLabel = $derived(
    entry?.provider && entry.provider !== 'Unknown' ? entry.provider : 'your DNS provider'
  );

  onMount(async () => {
    try {
      const domains = await getSiteDomains(siteId);
      if (domains.length > 0) {
        entry = domains[0];
        hostnameInput = entry.hostname;
      }
    } catch { /* non-fatal */ }
    loadingInit = false;
  });

  async function connect() {
    const h = hostnameInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!h || registering) return;
    if (!contentHash) {
      error = 'Re-publish your site first — the deploy hash is needed to link a domain.';
      return;
    }
    error = '';
    registering = true;
    try {
      entry = await registerSiteDomain(h, siteId, contentHash, feedManifestHash);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Registration failed';
    } finally {
      registering = false;
    }
  }

  async function verify() {
    if (!entry || verifying) return;
    error = '';
    verifying = true;
    try {
      const res = await verifyDomainDns(entry.hostname);
      if (res.verified) {
        entry = { ...entry, verified: true, verifiedAt: new Date().toISOString() };
      } else {
        error = res.error ?? "DNS not found yet — it can take a few minutes to propagate";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Check failed';
    } finally {
      verifying = false;
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    copied = key;
    setTimeout(() => { if (copied === key) copied = null; }, 2000);
  }

  function editDomain() {
    hostnameInput = entry?.hostname ?? '';
    entry = null;
    error = '';
  }

  async function disconnect() {
    if (!entry || removing) return;
    removing = true;
    error = '';
    try {
      await removeDomain(entry.hostname);
      hostnameInput = '';
      entry = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to remove domain';
    } finally {
      removing = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') connect();
  }

  const PROVIDER_COLORS: Record<string, string> = {
    Cloudflare:          '#f48120',
    GoDaddy:             '#00a4a6',
    Namecheap:           '#de3c25',
    Squarespace:         '#000000',
    IONOS:               '#003d8f',
    'AWS Route 53':      '#ff9900',
    Porkbun:             '#ef4444',
    OVHcloud:            '#123f82',
    Gandi:               '#00bcd4',
    Bluehost:            '#2563eb',
    HostGator:           '#f97316',
    DreamHost:           '#47b5e6',
    'Heart Internet':    '#d6284f',
    'Hetzner DNS':       '#d50c2d',
    'Network Solutions': '#005a9c',
    '123-reg':           '#e11d48',
    'One.com':           '#1d4ed8',
    Strato:              '#e83e2e',
    Fasthosts:           '#ff3c00',
    'Name.com':          '#6d28d9',
    Hover:               '#374151',
  };

  const providerColor = $derived(
    entry?.provider ? (PROVIDER_COLORS[entry.provider] ?? '#6b7280') : '#6b7280'
  );
</script>

<!-- Only shown once the site has been deployed (parent controls visibility) -->
<div class="domain-linker">

  <!-- ── Top row — always visible ──────────────────────────────────────── -->
  <div class="top-row">
    <div class="row-left">
      <svg class="link-icon" width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <path d="M5.5 7.5a3.5 3.5 0 0 0 5 0l1.5-1.5a3.536 3.536 0 0 0-5-5L6 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M7.5 5.5a3.5 3.5 0 0 0-5 0L1 7a3.536 3.536 0 0 0 5 5L7 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="row-label">Custom domain</span>
    </div>

    {#if loadingInit}
      <span class="loading-pulse"></span>

    {:else if !entry}
      <!-- Input form -->
      <div class="input-wrap">
        <input
          class="domain-input"
          type="text"
          placeholder="events.mybar.com or mybar.com"
          bind:value={hostnameInput}
          onkeydown={handleKeydown}
          disabled={registering}
          spellcheck={false}
          autocapitalize="none"
          autocomplete="off"
        />
        <button
          class="connect-btn"
          onclick={connect}
          disabled={registering || !hostnameInput.trim()}
        >
          {#if registering}
            <span class="btn-spinner" aria-hidden="true"></span>Checking…
          {:else}
            Connect
          {/if}
        </button>
      </div>
      <span class="row-hint">Visitors use your URL</span>

    {:else if entry.verified}
      <!-- Verified — compact success row -->
      <span class="hostname-text">{entry.hostname}</span>
      <span class="badge badge--live">✓ Live</span>
      <button class="ghost-btn" onclick={editDomain}>Change</button>
      <button class="ghost-btn ghost-btn--danger" onclick={disconnect} disabled={removing}>
        {removing ? '…' : 'Disconnect'}
      </button>

    {:else}
      <!-- Registered but awaiting DNS -->
      <span class="hostname-text">{entry.hostname}</span>
      {#if entry.provider && entry.provider !== 'Unknown'}
        <span class="provider-pill" style="--pc: {providerColor}">
          {entry.provider}
        </span>
      {/if}
      <span class="badge badge--pending">Awaiting DNS</span>
      <button class="ghost-btn" onclick={editDomain}>Change</button>
      <button class="ghost-btn ghost-btn--danger" onclick={disconnect} disabled={removing}>
        {removing ? '…' : 'Disconnect'}
      </button>
    {/if}
  </div>

  <!-- ── Error bar ───────────────────────────────────────────────────── -->
  {#if error}
    <div class="error-bar">{error}</div>
  {/if}

  <!-- ── Instructions — shown when registered but not yet verified ──── -->
  {#if entry && !entry.verified}
    <div class="instr-panel">

      {#if isApex}
        <!-- Bare domain → A record -->
        <p class="instr-lead">Add this record at <strong>{providerLabel}</strong>:</p>
        <div class="dns-record-block">
          <div class="dns-field">
            <span class="dns-field-label">Type</span>
            <span class="dns-field-value">A</span>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Name</span>
            <span class="dns-field-value mono">@</span>
            <button class="copy-btn" onclick={() => copy('@', 'name')}>
              {copied === 'name' ? '✓' : 'Copy'}
            </button>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Value</span>
            <span class="dns-field-value mono">46.225.174.72</span>
            <button class="copy-btn" onclick={() => copy('46.225.174.72', 'target')}>
              {copied === 'target' ? '✓' : 'Copy'}
            </button>
          </div>
        </div>
        {#if entry?.provider === 'Cloudflare'}
          <div class="proxy-warning">
            <strong>Important:</strong> set Proxy status to <strong>DNS Only (grey cloud)</strong> — not Proxied (orange). Click the cloud icon to toggle.
          </div>
        {:else}
          <p class="apex-note">SSL is issued automatically on first visit — no extra configuration needed.</p>
        {/if}

      {:else}
        <!-- Subdomain → CNAME -->
        <p class="instr-lead">Add this record at <strong>{providerLabel}</strong>:</p>
        <div class="dns-record-block">
          <div class="dns-field">
            <span class="dns-field-label">Type</span>
            <span class="dns-field-value">CNAME</span>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Name</span>
            <span class="dns-field-value mono">{cnameNameField}</span>
            <button class="copy-btn" onclick={() => copy(cnameNameField, 'name')}>
              {copied === 'name' ? '✓' : 'Copy'}
            </button>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Target</span>
            <span class="dns-field-value mono">sites.woco-net.com</span>
            <button class="copy-btn" onclick={() => copy('sites.woco-net.com', 'target')}>
              {copied === 'target' ? '✓' : 'Copy'}
            </button>
          </div>
        </div>
        {#if entry?.provider === 'Cloudflare'}
          <div class="proxy-warning">
            <strong>Important:</strong> set Proxy status to <strong>DNS Only (grey cloud)</strong> — not Proxied (orange). Click the cloud icon to toggle.
          </div>
        {/if}
      {/if}

      {#if instr}
        {@const steps = isApex ? (instr.aRecordSteps ?? instr.cnameSteps) : instr.cnameSteps}
        {#if steps.length > 0}
          <details class="steps-details">
            <summary class="steps-summary">Step-by-step for {instr.provider}</summary>
            <ol class="steps-list">
              {#each steps as step}
                <li>{step}</li>
              {/each}
            </ol>
            {#if instr.gotcha}
              <p class="steps-gotcha">⚠ {instr.gotcha}</p>
            {/if}
          </details>
        {/if}
      {/if}

      <div class="verify-row">
        <button class="verify-btn" onclick={verify} disabled={verifying}>
          {#if verifying}<span class="btn-spinner btn-spinner--dark" aria-hidden="true"></span>{/if}
          {verifying ? 'Checking…' : 'Check DNS now'}
        </button>
        <span class="verify-hint">We also check automatically every 15 minutes</span>
      </div>
    </div>
  {/if}
</div>

<style>
  /* ── Shell ──────────────────────────────────────────────────────────────── */
  .domain-linker {
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 3%, var(--bg));
    border-left: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }

  /* ── Top row ─────────────────────────────────────────────────────────────── */
  .top-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4rem 1.25rem;
    flex-wrap: wrap;
    min-height: 2.5rem;
  }

  .row-left {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .link-icon {
    color: var(--accent);
    flex-shrink: 0;
  }

  .row-label {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
  }

  /* ── Input form ──────────────────────────────────────────────────────────── */
  .input-wrap {
    display: flex;
    align-items: center;
    gap: 0;
    flex: 1;
    max-width: 28rem;
    min-width: 14rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
    transition: border-color 150ms;
  }

  .input-wrap:focus-within {
    border-color: var(--accent);
  }

  .domain-input {
    flex: 1;
    min-width: 0;
    padding: 0.375rem 0.625rem;
    font-size: 0.8125rem;
    font-family: monospace;
    background: transparent;
    color: var(--text);
    border: none;
    outline: none;
  }

  .domain-input::placeholder {
    color: var(--text-muted);
    font-family: inherit;
    opacity: 0.6;
  }

  .connect-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    background: var(--accent);
    color: #000;
    border-left: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    white-space: nowrap;
    flex-shrink: 0;
    transition: opacity 150ms;
  }

  .connect-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .row-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── Verified / pending row elements ─────────────────────────────────────── */
  .hostname-text {
    font-size: 0.8125rem;
    font-family: monospace;
    color: var(--text);
    font-weight: 600;
  }

  .provider-pill {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.15em 0.5em;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--pc, #6b7280) 18%, transparent);
    color: color-mix(in srgb, var(--pc, #6b7280) 90%, #fff);
    border: 1px solid color-mix(in srgb, var(--pc, #6b7280) 30%, transparent);
    white-space: nowrap;
  }

  .badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.15em 0.5em;
    border-radius: 9999px;
    white-space: nowrap;
  }

  .badge--live {
    background: color-mix(in srgb, #22c55e 15%, transparent);
    color: #22c55e;
    border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
  }

  .badge--pending {
    background: color-mix(in srgb, #f59e0b 12%, transparent);
    color: #f59e0b;
    border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
  }

  .ghost-btn {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: color 150ms, border-color 150ms;
    white-space: nowrap;
  }

  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .ghost-btn--danger:hover {
    color: #f87171;
    border-color: #f87171;
  }

  /* ── Error bar ───────────────────────────────────────────────────────────── */
  .error-bar {
    padding: 0.375rem 1.25rem;
    font-size: 0.8125rem;
    color: #f87171;
    background: color-mix(in srgb, #ef4444 8%, var(--bg));
    border-top: 1px solid color-mix(in srgb, #ef4444 20%, transparent);
  }

  /* ── Instructions panel ─────────────────────────────────────────────────── */
  .instr-panel {
    padding: 0.75rem 1.25rem 1rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .instr-lead {
    font-size: 0.8125rem;
    color: var(--text);
    margin: 0;
    line-height: 1.5;
  }

  /* ── DNS record block ──────────────────────────────────────────────────── */
  .dns-record-block {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
  }

  .dns-field {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .dns-field:last-child {
    border-bottom: none;
  }

  .dns-field-label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    width: 3.5rem;
    flex-shrink: 0;
  }

  .dns-field-value {
    font-size: 0.8125rem;
    color: var(--text);
    flex: 1;
  }

  .dns-field-value.mono {
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .copy-btn {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: all 150ms;
    flex-shrink: 0;
  }

  .copy-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Notes ───────────────────────────────────────────────────────────────── */
  .apex-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .proxy-warning {
    font-size: 0.8125rem;
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 7%, var(--bg));
    border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    line-height: 1.5;
  }

  /* ── Steps ───────────────────────────────────────────────────────────────── */
  .steps-details {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .steps-summary {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
    background: var(--bg-elevated);
    list-style: none;
    transition: color 150ms;
  }

  .steps-summary:hover { color: var(--text); }

  .steps-details[open] .steps-summary {
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }

  .steps-list {
    margin: 0;
    padding: 0.625rem 0.75rem 0.625rem 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    background: var(--bg-elevated);
  }

  .steps-list li {
    font-size: 0.8125rem;
    color: var(--text);
    line-height: 1.5;
  }

  .steps-gotcha {
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 6%, var(--bg-elevated));
    border-top: 1px solid color-mix(in srgb, #f59e0b 15%, transparent);
  }

  /* ── Verify row ──────────────────────────────────────────────────────────── */
  .verify-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    border-top: 1px solid var(--border);
    padding-top: 0.625rem;
    margin-top: 0.125rem;
  }

  .verify-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 700;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius-sm);
    transition: border-color 150ms, color 150ms;
    white-space: nowrap;
  }

  .verify-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .verify-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .verify-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* ── Spinners ─────────────────────────────────────────────────────────────── */
  .btn-spinner {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid rgba(0,0,0,0.25);
    border-top-color: #000;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .btn-spinner--dark {
    border-color: rgba(255,255,255,0.2);
    border-top-color: var(--text);
  }

  .loading-pulse {
    display: inline-block;
    width: 5rem;
    height: 0.75rem;
    background: var(--border);
    border-radius: var(--radius-sm);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes spin  { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

  /* ── Responsive ──────────────────────────────────────────────────────────── */
  @media (max-width: 540px) {
    .top-row { padding: 0.4rem 0.875rem; }
    .instr-panel { padding: 0.75rem 0.875rem 1rem; }
    .input-wrap { max-width: none; flex: 1 0 100%; }
    .row-hint { display: none; }
  }
</style>
