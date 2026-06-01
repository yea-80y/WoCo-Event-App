<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { checkSubEnsLabel, claimSubEnsLabel, claimSubEnsViaPermit } from "../../api/sub-ens.js";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";

  interface Props {
    claimedLabel?: string;
    deployedHash?: string;
    onclaim?: (label: string) => void;
    /** Parent can pre-fetch and pass; if undefined, picker self-checks. */
    stripeConnected?: boolean;
    /** If parent manages the Stripe modal lifecycle, provide this callback. */
    onstripesetup?: () => void;
  }

  let { claimedLabel = $bindable<string | undefined>(undefined), deployedHash = '', onclaim, stripeConnected, onstripesetup }: Props = $props();

  // ── Stripe gate ──────────────────────────────────────────────────────────────
  // null = loading/unknown, false = not connected, true = connected+complete
  let stripeStatus = $state<boolean | null>(null);
  let stripeModalOpen = $state(false);

  $effect(() => {
    if (stripeConnected !== undefined) {
      stripeStatus = stripeConnected;
      return;
    }
    if (!auth.isConnected) {
      stripeStatus = false;
      return;
    }
    stripeStatus = null;
    getStripeAccountStatus().then((s) => {
      stripeStatus = !!(s.ok && s.onboardingComplete);
    }).catch(() => { stripeStatus = false; });
  });

  function openStripeSetup() {
    if (onstripesetup) {
      onstripesetup();
    } else {
      if (!auth.isConnected) {
        loginRequest.request().then((ok) => { if (ok) stripeModalOpen = true; });
        return;
      }
      stripeModalOpen = true;
    }
  }

  function onStripeConnected() {
    stripeStatus = true;
    stripeModalOpen = false;
  }

  // ── Input state ──────────────────────────────────────────────────────────────
  let rawInput  = $state(claimedLabel ?? '');
  let checkPhase = $state<'idle' | 'checking' | 'ok' | 'taken' | 'invalid'>('idle');
  let checkMsg  = $state('');

  // Profile fields shown once the label is confirmed available
  let showProfile = $derived(checkPhase === 'ok');
  let profileBio  = $state('');

  // Claiming
  let claiming   = $state(false);
  let claimError = $state('');

  // Success state — either already had a label or just claimed one
  let claimed = $derived(!!claimedLabel);
  let ensName = $derived(claimedLabel ? `${claimedLabel}.woco.eth` : '');
  let ensUrl  = $derived(claimedLabel ? `https://${claimedLabel}.woco.eth.limo` : '');

  // Live preview as user types (before claim)
  let previewLabel = $derived(rawInput.toLowerCase().trim());
  let previewEns   = $derived(previewLabel ? `${previewLabel}.woco.eth.limo` : '');

  // ── Availability check (debounced) ───────────────────────────────────────────
  let _timer: ReturnType<typeof setTimeout> | null = null;

  function onInput() {
    if (_timer) clearTimeout(_timer);
    const val = rawInput.toLowerCase().trim();
    if (!val) { checkPhase = 'idle'; checkMsg = ''; return; }
    checkPhase = 'checking';
    _timer = setTimeout(() => runCheck(val), 380);
  }

  async function runCheck(label: string) {
    try {
      const res = await checkSubEnsLabel(label);
      if (rawInput.toLowerCase().trim() !== label) return; // stale
      if (!res.ok) {
        checkPhase = 'invalid';
        checkMsg = res.error ?? 'Check failed';
        return;
      }
      if (res.data!.available) {
        checkPhase = 'ok';
        checkMsg = '';
      } else {
        checkPhase = 'taken';
        checkMsg = res.data!.reason ?? 'already taken';
      }
    } catch {
      if (rawInput.toLowerCase().trim() === label) {
        checkPhase = 'invalid';
        checkMsg = 'Network error — try again';
      }
    }
  }

  // ── Claim ────────────────────────────────────────────────────────────────────
  async function doClaim() {
    if (claiming || checkPhase !== 'ok') return;

    if (!auth.isConnected) {
      const ok = await loginRequest.request();
      if (!ok) return;
    }
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) return;
    }

    claiming = true;
    claimError = '';
    const label = rawInput.toLowerCase().trim();

    try {
      // Passkey users own a ZeroDev Kernel → claim client-side via permit +
      // scoped session key (gasless, name owned by their smart account). Every
      // other login kind uses the server-sponsored path.
      const res = auth.kind === 'passkey'
        ? await claimSubEnsViaPermit({
            label,
            kernelAddress: await auth.ensureWocoSessionKey(),
            description: profileBio.trim() || undefined,
          })
        : await claimSubEnsLabel({
            label,
            description: profileBio.trim() || undefined,
          });
      if (!res.ok) {
        claimError = res.error ?? 'Claim failed — try again';
        return;
      }
      claimedLabel = res.data!.label;
      onclaim?.(res.data!.label);
    } catch {
      claimError = 'Network error — try again';
    } finally {
      claiming = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  let copied = $state(false);
  function copyUrl() {
    navigator.clipboard.writeText(ensUrl).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 1800);
    });
  }
</script>

{#if stripeStatus !== true}
  <!-- ── Stripe gate ─────────────────────────────────────────────────────── -->
  <div class="picker picker--locked">
    {#if stripeStatus === null}
      <div class="lock-loading">
        <span class="spinner" aria-label="Checking…"></span>
        <span class="lock-loading-text">Checking your account…</span>
      </div>
    {:else}
      <div class="lock-body">
        <div class="lock-header">
          <span class="lock-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="4" y="8" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
              <path d="M6 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              <circle cx="9" cy="12" r="1.2" fill="currentColor"/>
            </svg>
          </span>
          <div class="lock-text">
            <p class="lock-title">Claim your free <code class="inline-code">.woco.eth</code> address</p>
            <p class="lock-sub">
              {#if !auth.isConnected}
                Connect your wallet to get started.
              {:else}
                Verify your business via Stripe to unlock — takes 2 minutes.
              {/if}
            </p>
          </div>
        </div>

        <button class="setup-btn" onclick={openStripeSetup}>
          {#if !auth.isConnected}
            Connect wallet →
          {:else}
            Set up Stripe →
          {/if}
        </button>

        <ul class="feature-list feature-list--muted" aria-label="What you get">
          <li>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Permanent ENS name on Arbitrum — no domain registrar
          </li>
          <li>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Auto-links to your site on every publish
          </li>
          <li>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Works as a payment address for ETH
          </li>
        </ul>
      </div>
    {/if}
  </div>

  {#if stripeModalOpen && !onstripesetup}
    <StripeConnectModal bind:open={stripeModalOpen} onconnected={onStripeConnected} />
  {/if}

{:else if claimed}
  <!-- ── Success / Already claimed ──────────────────────────────────────── -->
  <div class="picker picker--claimed">
    <div class="claimed-header">
      <span class="claimed-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 1L11.5 6.5H17L12.5 10L14.5 16L9 12.5L3.5 16L5.5 10L1 6.5H6.5L9 1Z" fill="#C7F23A" opacity="0.18" stroke="#C7F23A" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M6.5 9l1.8 1.8L12 7" stroke="#C7F23A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <div class="claimed-title">
        <span class="claimed-headline">{ensName}</span>
        <span class="claimed-sub">is yours</span>
      </div>
    </div>

    <div class="claimed-url-row">
      <span class="claimed-url">{ensUrl}</span>
      <button class="action-btn action-btn--copy" onclick={copyUrl}>
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <span class="action-btn action-btn--soon" title="Goes live once woco.eth's mainnet ENS resolver points to the Arbitrum registry">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <circle cx="5.5" cy="5.5" r="4.2" stroke="currentColor" stroke-width="1.2"/>
          <path d="M5.5 3.4V5.5l1.5 .9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Live soon
      </span>
    </div>

    {#if deployedHash}
      <p class="claimed-note">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style="flex-shrink:0">
          <path d="M6 1v7M2 5l4 3 4-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M1 10h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        Linked to your site — updates automatically when you publish.
      </p>
    {:else}
      <p class="claimed-note">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style="flex-shrink:0">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/>
          <path d="M6 4v3.5M6 9v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        Publish your site to link it to this address.
      </p>
    {/if}
  </div>

{:else}
  <!-- ── Claim form ──────────────────────────────────────────────────────── -->
  <div class="picker">
    <!-- Header -->
    <div class="picker-head">
      <span class="ens-badge" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
          <path d="M7.5 1L9.5 5.5H14.5L10.5 8.5L12 13.5L7.5 10.5L3 13.5L4.5 8.5L0.5 5.5H5.5L7.5 1Z"
                fill="#C7F23A" opacity="0.12" stroke="#C7F23A" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        ENS
      </span>
      <div class="picker-head-text">
        <p class="picker-title">Claim your free web3 address</p>
        <p class="picker-sub">Every WoCo site gets a permanent <code class="inline-code">.woco.eth</code> name — no domain registrar needed.</p>
      </div>
    </div>

    <!-- Label input row -->
    <div class="input-row">
      <div class="input-wrap" class:input-wrap--ok={checkPhase === 'ok'} class:input-wrap--bad={checkPhase === 'taken' || checkPhase === 'invalid'}>
        <input
          class="label-input"
          type="text"
          placeholder="yourname"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          bind:value={rawInput}
          oninput={onInput}
          disabled={claiming}
        />
        <span class="tld-suffix">.woco.eth</span>
        <span class="check-indicator" aria-live="polite">
          {#if checkPhase === 'checking'}
            <span class="spinner" aria-label="Checking…"></span>
          {:else if checkPhase === 'ok'}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Available" role="img">
              <circle cx="8" cy="8" r="7" fill="#22c55e" opacity="0.15"/>
              <path d="M5 8.2l2.2 2.2L11 6" stroke="#22c55e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {:else if checkPhase === 'taken'}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Taken" role="img">
              <circle cx="8" cy="8" r="7" fill="#ef4444" opacity="0.12"/>
              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#ef4444" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          {:else if checkPhase === 'invalid'}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Invalid" role="img">
              <circle cx="8" cy="8" r="7" fill="#f59e0b" opacity="0.12"/>
              <path d="M8 5v4M8 10.5v.5" stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          {/if}
        </span>
      </div>
    </div>

    <!-- Availability message -->
    {#if checkPhase === 'ok' && previewEns}
      <p class="avail-msg avail-msg--ok">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 6.2l2.8 2.8L10 4" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Available — <code class="preview-code">{previewEns}</code>
      </p>
    {:else if checkPhase === 'taken'}
      <p class="avail-msg avail-msg--bad">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        {checkMsg || 'Already taken — try a different name'}
      </p>
    {:else if checkPhase === 'invalid'}
      <p class="avail-msg avail-msg--warn">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M6 2v5M6 8.5v.5" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        {checkMsg}
      </p>
    {:else if previewLabel && checkPhase === 'idle'}
      <p class="avail-msg avail-msg--dim">
        <code class="preview-code">{previewEns}</code>
      </p>
    {/if}

    <!-- Profile fields (shown once available) -->
    {#if showProfile}
      <div class="profile-fields">
        <div class="field-group">
          <label class="field-label" for="ens-bio">Short bio <span class="field-opt">(optional)</span></label>
          <textarea
            id="ens-bio"
            class="field-input field-textarea"
            placeholder="Describe your venue, brand, or project in a sentence…"
            rows="2"
            maxlength="160"
            bind:value={profileBio}
          ></textarea>
          <span class="field-counter">{profileBio.length}/160</span>
        </div>
        <p class="field-hint">
          Stored as ENS text records — portable across any app that reads ENS.
        </p>
      </div>
    {/if}

    <!-- Error -->
    {#if claimError}
      <p class="claim-error">{claimError}</p>
    {/if}

    <!-- Claim button -->
    {#if checkPhase === 'ok'}
      <button class="claim-btn" onclick={doClaim} disabled={claiming}>
        {#if claiming}
          <span class="btn-spinner" aria-hidden="true"></span>
          Registering on Arbitrum…
        {:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 1L9 5.5H13.5L9.5 8.5L11 13L7 10L3 13L4.5 8.5L0.5 5.5H5L7 1Z"
                  fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          Claim {previewLabel}.woco.eth — free
        {/if}
      </button>
    {:else if checkPhase === 'idle' && !rawInput}
      <p class="cta-hint">Enter a name above to get started — it's free and permanent.</p>
    {/if}

    <!-- What you get note -->
    {#if !claimed}
      <ul class="feature-list" aria-label="Benefits">
        <li>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="#C7F23A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Works as a payment address — receive ETH to <code class="inline-code">{previewLabel || 'yourname'}.woco.eth</code>
        </li>
        <li>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="#C7F23A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Permanent — registered on Arbitrum, not a WoCo database
        </li>
        <li>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1.5 5.5l3 3 5-5" stroke="#C7F23A" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Auto-links to your site on every publish
        </li>
      </ul>
    {/if}
  </div>
{/if}

<style>
  /* ── Card shell ──────────────────────────────────────────────────────────── */
  .picker--locked {
    border-left-color: var(--border);
    background: var(--bg-elevated);
  }

  .lock-loading {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.25rem 0;
  }

  .lock-loading-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .lock-body {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .lock-header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .lock-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    color: var(--text-muted);
    background: color-mix(in srgb, currentColor 8%, var(--bg));
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 50%;
    margin-top: 0.0625rem;
  }

  .lock-text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .lock-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .lock-sub {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .setup-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5625rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    background: transparent;
    border: 1.5px solid var(--border);
    border-radius: 5px;
    transition: border-color 120ms, color 120ms;
    cursor: pointer;
    align-self: flex-start;
  }

  .setup-btn:hover {
    border-color: #C7F23A;
    color: #C7F23A;
  }

  .feature-list--muted svg { color: var(--text-muted); opacity: 0.5; }
  .feature-list--muted li  { opacity: 0.65; }

  .picker {
    border: 1px solid var(--border);
    border-left: 3px solid #C7F23A;
    border-radius: 6px;
    background: var(--bg-elevated);
    padding: 1.25rem 1.375rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-bottom: 2rem;
  }

  .picker--claimed {
    border-left-color: #22c55e;
    background: color-mix(in srgb, #22c55e 4%, var(--bg-elevated));
  }

  /* ── Header ────────────────────────────────────────────────────────────── */
  .picker-head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .ens-badge {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem 0.2rem 0.35rem;
    font-size: 0.6875rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #C7F23A;
    background: color-mix(in srgb, #C7F23A 8%, transparent);
    border: 1px solid color-mix(in srgb, #C7F23A 22%, transparent);
    border-radius: 3px;
    white-space: nowrap;
    margin-top: 0.125rem;
  }

  .picker-head-text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .picker-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .picker-sub {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .inline-code {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
    background: color-mix(in srgb, #C7F23A 7%, var(--bg));
    border: 1px solid color-mix(in srgb, #C7F23A 14%, transparent);
    border-radius: 3px;
    padding: 0.1em 0.3em;
  }

  /* ── Input row ─────────────────────────────────────────────────────────── */
  .input-row { display: flex; gap: 0.5rem; align-items: stretch; }

  .input-wrap {
    display: flex;
    align-items: center;
    flex: 1;
    background: var(--bg);
    border: 1.5px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
    transition: border-color 140ms;
  }

  .input-wrap:focus-within { border-color: #C7F23A; }
  .input-wrap--ok  { border-color: color-mix(in srgb, #22c55e 60%, var(--border)); }
  .input-wrap--bad { border-color: color-mix(in srgb, #ef4444 50%, var(--border)); }

  .label-input {
    flex: 1;
    padding: 0.6rem 0.375rem 0.6rem 0.75rem;
    font-size: 0.9375rem;
    font-family: monospace;
    font-weight: 600;
    color: var(--text);
    background: transparent;
    border: none;
    outline: none;
    min-width: 0;
    letter-spacing: 0.01em;
  }

  .label-input::placeholder {
    color: var(--text-muted);
    opacity: 0.5;
    font-weight: 400;
  }

  .tld-suffix {
    font-size: 0.8125rem;
    font-family: monospace;
    color: var(--text-muted);
    padding-right: 0.5rem;
    white-space: nowrap;
    flex-shrink: 0;
    opacity: 0.65;
  }

  .check-indicator {
    display: flex;
    align-items: center;
    padding: 0 0.625rem 0 0.25rem;
    width: 1.875rem;
    flex-shrink: 0;
  }

  /* ── Availability message ───────────────────────────────────────────────── */
  .avail-msg {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .avail-msg--ok   { color: #22c55e; }
  .avail-msg--bad  { color: #ef4444; }
  .avail-msg--warn { color: #f59e0b; }
  .avail-msg--dim  { color: var(--text-muted); }

  .preview-code {
    font-family: monospace;
    font-size: 0.85em;
    letter-spacing: 0.01em;
    color: inherit;
  }

  /* ── Spinner ────────────────────────────────────────────────────────────── */
  .spinner {
    display: inline-block;
    width: 13px;
    height: 13px;
    border: 1.5px solid color-mix(in srgb, #C7F23A 30%, var(--border));
    border-top-color: #C7F23A;
    border-radius: 50%;
    animation: spin 0.55s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Profile fields ─────────────────────────────────────────────────────── */
  .profile-fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem;
    background: color-mix(in srgb, #C7F23A 3%, var(--bg));
    border: 1px solid color-mix(in srgb, #C7F23A 12%, var(--border));
    border-radius: 4px;
  }

  .field-group { display: flex; flex-direction: column; gap: 0.3rem; position: relative; }

  .field-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .field-opt { text-transform: none; font-weight: 400; letter-spacing: 0; opacity: 0.65; }

  .field-input {
    width: 100%;
    padding: 0.5rem 0.6875rem;
    font-size: 0.875rem;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 130ms;
    font-family: inherit;
  }

  .field-input:focus { border-color: #C7F23A; }

  .field-textarea { resize: vertical; min-height: 4rem; line-height: 1.5; }

  .field-counter {
    position: absolute;
    right: 0;
    bottom: 0.3rem;
    font-size: 0.6875rem;
    color: var(--text-muted);
    opacity: 0.55;
    padding: 0 0.6rem;
    pointer-events: none;
  }

  .field-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    opacity: 0.65;
    line-height: 1.4;
  }

  /* ── Claim button ───────────────────────────────────────────────────────── */
  .claim-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.6875rem 1rem;
    font-size: 0.9375rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #0d0d0d;
    background: #C7F23A;
    border-radius: 5px;
    transition: background 120ms, transform 100ms;
  }

  .claim-btn:hover:not(:disabled)  { background: #d4f54d; transform: translateY(-1px); }
  .claim-btn:active:not(:disabled) { transform: translateY(0); }
  .claim-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 1.5px solid rgba(0,0,0,0.2);
    border-top-color: #0d0d0d;
    border-radius: 50%;
    animation: spin 0.55s linear infinite;
  }

  /* ── Error / hints ──────────────────────────────────────────────────────── */
  .claim-error {
    margin: 0;
    font-size: 0.8125rem;
    color: #ef4444;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, #ef4444 8%, var(--bg));
    border: 1px solid color-mix(in srgb, #ef4444 22%, transparent);
    border-radius: 4px;
  }

  .cta-hint {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-align: center;
  }

  /* ── Feature list ───────────────────────────────────────────────────────── */
  .feature-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .feature-list li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .feature-list svg { flex-shrink: 0; margin-top: 0.2rem; }

  /* ── Claimed state ──────────────────────────────────────────────────────── */
  .claimed-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .claimed-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: color-mix(in srgb, #22c55e 8%, var(--bg));
    border: 1px solid color-mix(in srgb, #22c55e 25%, transparent);
    border-radius: 50%;
    flex-shrink: 0;
  }

  .claimed-title {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .claimed-headline {
    font-size: 1rem;
    font-weight: 800;
    color: var(--text);
    font-family: monospace;
    letter-spacing: -0.01em;
  }

  .claimed-sub {
    font-size: 0.875rem;
    color: #22c55e;
    font-weight: 600;
  }

  .claimed-url-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .claimed-url {
    font-size: 0.8125rem;
    font-family: monospace;
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 4px;
    transition: background 120ms;
    white-space: nowrap;
    text-decoration: none;
  }

  .action-btn--copy {
    background: transparent;
    border: 1px solid color-mix(in srgb, #22c55e 30%, var(--border));
    color: #22c55e;
  }
  .action-btn--copy:hover { background: color-mix(in srgb, #22c55e 10%, transparent); }

  /* Non-clickable pending state: the .woco.eth.limo web address activates once
     woco.eth's mainnet resolver points to the Arbitrum registry (the resolver
     cutover is parked post-buildathon — see SUB_ENS_ARBITRUM_PLAN.md). */
  .action-btn--soon {
    background: color-mix(in srgb, var(--text-muted) 8%, transparent);
    border: 1px dashed var(--border);
    color: var(--text-muted);
    cursor: default;
  }

  .claimed-note {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
</style>
