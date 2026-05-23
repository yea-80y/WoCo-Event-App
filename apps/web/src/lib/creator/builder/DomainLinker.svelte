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

  const CC_SLDS = new Set(['co', 'org', 'net', 'gov', 'ac', 'me', 'ltd', 'plc', 'sch', 'com', 'edu', 'mil']);

  function apexDomain(hostname: string): string {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && CC_SLDS.has(sld)) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  const isApex = $derived(entry ? entry.hostname === apexDomain(entry.hostname) : false);

  const cnameNameField = $derived((() => {
    if (!entry) return 'www';
    const apex = apexDomain(entry.hostname);
    if (entry.hostname === apex) return '@';
    return entry.hostname.slice(0, -(apex.length + 1));
  })());

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

      <!-- Where to make changes -->
      <div class="where-header">
        <span class="where-label">Where to make changes</span>
        {#if entry.provider && entry.provider !== 'Unknown'}
          <span class="provider-target" style="--pc: {providerColor}">{entry.provider}</span>
        {:else}
          <span class="provider-target" style="--pc: #6b7280">Your DNS provider</span>
        {/if}
        {#if entry.provider && entry.provider !== 'Unknown'}
          <span class="registrar-note">— not your domain registrar</span>
        {/if}
      </div>

      <!-- DNS record block -->
      <div class="dns-record-block">
        <div class="dns-record-header">
          <span class="dns-record-title">DNS RECORD</span>
          <span class="dns-type-tag">{isApex ? 'A' : 'CNAME'}</span>
        </div>
        {#if isApex}
          <div class="dns-field">
            <span class="dns-field-label">Name</span>
            <span class="dns-field-value mono">@</span>
            <button class="copy-btn" onclick={() => copy('@', 'name')}>
              {copied === 'name' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Value</span>
            <span class="dns-field-value mono">46.225.174.72</span>
            <button class="copy-btn" onclick={() => copy('46.225.174.72', 'target')}>
              {copied === 'target' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        {:else}
          <div class="dns-field">
            <span class="dns-field-label">Name</span>
            <span class="dns-field-value mono">{cnameNameField}</span>
            <button class="copy-btn" onclick={() => copy(cnameNameField, 'name')}>
              {copied === 'name' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div class="dns-field">
            <span class="dns-field-label">Target</span>
            <span class="dns-field-value mono">sites.woco-net.com</span>
            <button class="copy-btn" onclick={() => copy('sites.woco-net.com', 'target')}>
              {copied === 'target' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        {/if}
      </div>

      <!-- Cloudflare proxy warning -->
      {#if entry.provider === 'Cloudflare'}
        <div class="proxy-warning">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-2.75a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0V6A.75.75 0 0 1 8 5.25ZM8 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" fill="currentColor"/>
          </svg>
          <span><strong>Proxy must be off.</strong> In Cloudflare, click the orange cloud next to this record to make it grey (DNS Only). Orange cloud will break the connection.</span>
        </div>
      {/if}

      <!-- Existing site warning -->
      <p class="existing-site-warning">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M6 1L1 10h10L6 1Zm0 3v3m0 1.5v.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        If this domain currently points to another website, changing the record will redirect it here.
      </p>

      <!-- HTTPS auto note -->
      <p class="ssl-note">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M6 1a3.5 3.5 0 0 0-3.5 3.5V5H2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.5v-.5A3.5 3.5 0 0 0 6 1Zm2 4v-.5a2 2 0 1 0-4 0V5h4Z" fill="currentColor"/>
        </svg>
        HTTPS is issued automatically on first visit. DNS usually propagates within 15 minutes, but can take up to a few hours.
      </p>

      <!-- Step-by-step walkthrough -->
      {#if instr}
        {@const steps = isApex ? (instr.aRecordSteps ?? instr.cnameSteps) : instr.cnameSteps}
        {#if steps.length > 0}
          <details class="steps-details" open>
            <summary class="steps-summary">
              <svg class="steps-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Step-by-step in {instr.provider}
            </summary>
            <ol class="steps-list">
              {#each steps as step}
                <li>{step}</li>
              {/each}
            </ol>
            {#if instr.gotcha}
              <p class="steps-gotcha">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 1L1 10h10L6 1Zm0 3v3m0 1.5v.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                {instr.gotcha}
              </p>
            {/if}
          </details>
        {/if}
      {/if}

      <!-- Verify CTA -->
      <div class="verify-row">
        <button class="verify-btn" onclick={verify} disabled={verifying}>
          {#if verifying}
            <span class="btn-spinner" aria-hidden="true"></span>
            Checking DNS…
          {:else}
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M6.5 1a5.5 5.5 0 1 0 0 11A5.5 5.5 0 0 0 6.5 1Zm2.7 4.2-3 3a.5.5 0 0 1-.7 0l-1.5-1.5a.5.5 0 0 1 .7-.7l1.15 1.14 2.65-2.65a.5.5 0 0 1 .7.71Z" fill="currentColor"/>
            </svg>
            Check DNS now
          {/if}
        </button>
        <span class="verify-hint">Auto-checked every 15 min</span>
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
    padding: 0.875rem 1.25rem 1rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  /* ── Where header ──────────────────────────────────────────────────────── */
  .where-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .where-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .provider-target {
    font-size: 0.8125rem;
    font-weight: 800;
    color: color-mix(in srgb, var(--pc, #6b7280) 90%, #fff);
    white-space: nowrap;
  }

  .registrar-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── DNS record block ──────────────────────────────────────────────────── */
  .dns-record-block {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
  }

  .dns-record-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0.75rem;
    background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  }

  .dns-record-title {
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .dns-type-tag {
    font-size: 0.625rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 0.1em 0.45em;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 3px;
  }

  .dns-field {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.45rem 0.75rem;
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
    padding: 0.2rem 0.55rem;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: all 150ms;
    flex-shrink: 0;
    min-width: 4rem;
    text-align: center;
  }

  .copy-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Proxy warning ───────────────────────────────────────────────────────── */
  .proxy-warning {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 8%, var(--bg));
    border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    line-height: 1.5;
  }

  .proxy-warning svg {
    flex-shrink: 0;
    margin-top: 0.2em;
  }

  /* ── Existing site warning ──────────────────────────────────────────────── */
  .existing-site-warning {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: color-mix(in srgb, #f59e0b 80%, var(--text-muted));
    margin: 0;
    line-height: 1.5;
  }

  .existing-site-warning svg {
    flex-shrink: 0;
    color: #f59e0b;
    opacity: 0.8;
  }

  /* ── SSL note ────────────────────────────────────────────────────────────── */
  .ssl-note {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .ssl-note svg {
    flex-shrink: 0;
    opacity: 0.6;
  }

  /* ── Steps ───────────────────────────────────────────────────────────────── */
  .steps-details {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .steps-summary {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
    cursor: pointer;
    user-select: none;
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-elevated));
    border-bottom: 1px solid transparent;
    list-style: none;
    transition: background 150ms;
  }

  .steps-summary::-webkit-details-marker { display: none; }

  .steps-details[open] .steps-summary {
    border-bottom-color: var(--border);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));
  }

  .steps-chevron {
    flex-shrink: 0;
    color: var(--accent);
    transition: transform 150ms;
  }

  .steps-details[open] .steps-chevron {
    transform: rotate(180deg);
  }

  .steps-list {
    margin: 0;
    padding: 0.625rem 0.75rem 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--bg-elevated);
    list-style: none;
    counter-reset: step-counter;
  }

  .steps-list li {
    counter-increment: step-counter;
    position: relative;
    padding: 0.375rem 0 0.375rem 2rem;
    font-size: 0.8125rem;
    color: var(--text);
    line-height: 1.5;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }

  .steps-list li:last-child {
    border-bottom: none;
    padding-bottom: 0.25rem;
  }

  .steps-list li::before {
    content: counter(step-counter);
    position: absolute;
    left: 0;
    top: 0.45rem;
    width: 1.25rem;
    height: 1.25rem;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 50%;
    font-size: 0.625rem;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .steps-gotcha {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 6%, var(--bg-elevated));
    border-top: 1px solid color-mix(in srgb, #f59e0b 15%, transparent);
    line-height: 1.5;
  }

  .steps-gotcha svg {
    flex-shrink: 0;
    margin-top: 0.15em;
  }

  /* ── Verify row ──────────────────────────────────────────────────────────── */
  .verify-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .verify-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 1rem;
    font-size: 0.8125rem;
    font-weight: 800;
    background: var(--accent);
    color: #000;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: opacity 150ms;
    letter-spacing: 0.01em;
  }

  .verify-btn:hover:not(:disabled) {
    opacity: 0.88;
  }

  .verify-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

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
    flex-shrink: 0;
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
