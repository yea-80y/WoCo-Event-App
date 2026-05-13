<script lang="ts">
  import { onMount } from "svelte";
  import {
    connectStripe,
    getOnboardingLink,
    getStripeAccountStatus,
    type StripeAccountStatus,
    type RequirementCategory,
  } from "../../api/stripe.js";

  let status = $state<StripeAccountStatus | null>(null);
  let loading = $state(true);
  let actionLoading = $state(false);
  let error = $state<string | null>(null);
  let mounted = $state(false);

  onMount(async () => {
    mounted = true;
    try {
      const resp = await getStripeAccountStatus();
      if (resp.ok) status = resp;
    } catch {
      // Not authenticated or server down
    } finally {
      loading = false;
    }
  });

  async function handleConnect() {
    actionLoading = true;
    error = null;
    try {
      await connectStripe();
      const link = await getOnboardingLink();
      if (link.alreadyComplete) {
        const resp = await getStripeAccountStatus();
        if (resp.ok) status = resp;
        return;
      }
      if (link.url) window.location.href = link.url;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to connect Stripe";
    } finally {
      actionLoading = false;
    }
  }

  async function handleContinueOnboarding() {
    actionLoading = true;
    error = null;
    try {
      const link = await getOnboardingLink();
      if (link.alreadyComplete) {
        const resp = await getStripeAccountStatus();
        if (resp.ok) status = resp;
        return;
      }
      if (link.url) window.location.href = link.url;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to get onboarding link";
    } finally {
      actionLoading = false;
    }
  }

  const doneCount = $derived(
    status?.requirements?.categories?.filter((c) => c.status === "done").length ?? 0
  );
  const totalCount = $derived(
    status?.requirements?.categories?.length ?? 0
  );
</script>

<div class="stripe-panel" class:stripe-panel--mounted={mounted}>

  <!-- Header strip -->
  <div class="stripe-header">
    <div class="stripe-logo">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="#635bff"/>
        <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.918 3.757 7.11c0 4.46 2.72 6.326 7.007 7.945 2.55.963 3.44 1.607 3.44 2.686 0 .942-.79 1.524-2.269 1.524-1.95 0-4.733-.87-6.739-2.135L4.283 22.63C5.772 23.575 8.79 24 11.58 24c2.633 0 4.787-.642 6.29-1.818 1.635-1.275 2.46-3.152 2.46-5.58 0-4.603-2.771-6.41-6.354-7.452z" fill="white" transform="translate(2, 0) scale(0.83)"/>
      </svg>
      <span class="stripe-wordmark">Stripe Payments</span>
    </div>
    {#if status?.onboardingComplete}
      <span class="stripe-status-pill stripe-status-pill--active">
        <span class="status-dot status-dot--active"></span>
        Active
      </span>
    {:else if status?.connected}
      <span class="stripe-status-pill stripe-status-pill--incomplete">
        <span class="status-dot status-dot--incomplete"></span>
        Setup required
      </span>
    {/if}
  </div>

  <!-- Body -->
  <div class="stripe-body">

    {#if loading}
      <div class="stripe-loading">
        <div class="stripe-spinner"></div>
        <span>Checking Stripe status...</span>
      </div>

    {:else if status?.onboardingComplete}
      <!-- ✓ Fully connected -->
      <div class="stripe-connected">
        <div class="connected-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="15" stroke="var(--success)" stroke-width="2" fill="none" opacity="0.2"/>
            <circle cx="16" cy="16" r="15" stroke="var(--success)" stroke-width="2" fill="none" stroke-dasharray="94.2" stroke-dashoffset="0" class="check-circle"/>
            <path d="M10 16.5L14 20.5L22 12.5" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="check-path"/>
          </svg>
        </div>
        <div class="connected-text">
          <p class="connected-title">Ready to accept payments</p>
          <p class="connected-sub">Card payments from attendees will be deposited to your Stripe account.</p>
        </div>
        <div class="connected-details">
          <div class="detail-row">
            <span class="detail-label">Account</span>
            <span class="detail-value">{status.stripeAccountId}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Charges</span>
            <span class="detail-value detail-value--ok">Enabled</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payouts</span>
            <span class="detail-value detail-value--ok">Enabled</span>
          </div>
        </div>
      </div>

    {:else if status?.connected}
      <!-- Partially onboarded — show checklist -->
      <div class="stripe-incomplete">
        <p class="incomplete-intro">
          Complete the following steps to start accepting card payments. Stripe handles all verification securely.
        </p>

        <div class="progress-bar-wrap">
          <div class="progress-bar">
            <div
              class="progress-fill"
              style="width: {totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%"
            ></div>
          </div>
          <span class="progress-label">{doneCount} of {totalCount} complete</span>
        </div>

        {#if status.requirements?.categories}
          <ul class="checklist">
            {#each status.requirements.categories as cat}
              <li class="check-item" class:check-item--done={cat.status === "done"} class:check-item--pending={cat.status === "pending"}>
                <span class="check-icon">
                  {#if cat.status === "done"}
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <circle cx="9" cy="9" r="8" fill="var(--success)" opacity="0.15"/>
                      <path d="M5.5 9.5L7.5 11.5L12.5 6.5" stroke="var(--success)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {:else if cat.status === "pending"}
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="spin-icon">
                      <circle cx="9" cy="9" r="7.5" stroke="#f59e0b" stroke-width="1.5" fill="none" opacity="0.2"/>
                      <path d="M9 1.5A7.5 7.5 0 0 1 16.5 9" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" fill="none"/>
                    </svg>
                  {:else}
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <circle cx="9" cy="9" r="8" stroke="var(--text-muted)" stroke-width="1.2" fill="none" opacity="0.4"/>
                    </svg>
                  {/if}
                </span>
                <span class="check-label">{cat.label}</span>
                <span class="check-status">
                  {#if cat.status === "done"}
                    Done
                  {:else if cat.status === "pending"}
                    Verifying...
                  {:else}
                    Required
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        <button
          class="stripe-cta"
          onclick={handleContinueOnboarding}
          disabled={actionLoading}
        >
          {#if actionLoading}
            <span class="btn-spinner"></span>
            Opening Stripe...
          {:else}
            Complete verification
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="margin-left: 4px;">
              <path d="M5 2.5L9.5 7L5 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {/if}
        </button>
      </div>

    {:else}
      <!-- Not connected — initial state -->
      <div class="stripe-initial">
        <div class="initial-icon">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <rect x="2" y="8" width="36" height="24" rx="4" stroke="var(--text-muted)" stroke-width="1.5" fill="none" opacity="0.3"/>
            <rect x="2" y="13" width="36" height="5" fill="var(--text-muted)" opacity="0.1"/>
            <rect x="6" y="23" width="12" height="3" rx="1.5" fill="var(--text-muted)" opacity="0.2"/>
            <rect x="6" y="28" width="8" height="2" rx="1" fill="var(--text-muted)" opacity="0.15"/>
          </svg>
        </div>
        <p class="initial-title">Accept Payments</p>
        <p class="initial-desc">
          Your account is not yet set up to accept payments.
        </p>
        <p class="initial-desc" style="margin-top: 0.125rem;">
          We use <strong style="color: var(--text);">Stripe</strong> to process payments.
          Connect or create a Stripe account to start accepting payments.
          It usually takes less than 5 minutes.
        </p>

        <button
          class="stripe-cta"
          onclick={handleConnect}
          disabled={actionLoading}
        >
          {#if actionLoading}
            <span class="btn-spinner"></span>
            Setting up...
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="margin-right: 6px;">
              <rect width="24" height="24" rx="4" fill="#635bff"/>
              <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.918 3.757 7.11c0 4.46 2.72 6.326 7.007 7.945 2.55.963 3.44 1.607 3.44 2.686 0 .942-.79 1.524-2.269 1.524-1.95 0-4.733-.87-6.739-2.135L4.283 22.63C5.772 23.575 8.79 24 11.58 24c2.633 0 4.787-.642 6.29-1.818 1.635-1.275 2.46-3.152 2.46-5.58 0-4.603-2.771-6.41-6.354-7.452z" fill="white" transform="translate(2, 0) scale(0.83)"/>
            </svg>
            Connect Stripe
          {/if}
        </button>
      </div>
    {/if}

    {#if error}
      <div class="stripe-error">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="var(--error)" stroke-width="1.2" fill="none"/>
          <path d="M7 4V7.5M7 9.5V10" stroke="var(--error)" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        {error}
      </div>
    {/if}

  </div>
</div>

<style>
  .stripe-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  }

  .stripe-panel--mounted {
    opacity: 1;
    transform: translateY(0);
  }

  /* Header */
  .stripe-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(99, 91, 255, 0.04), transparent);
  }

  .stripe-logo {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .stripe-wordmark {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .stripe-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    letter-spacing: 0.01em;
  }

  .stripe-status-pill--active {
    background: color-mix(in srgb, var(--success) 10%, transparent);
    color: var(--success);
  }

  .stripe-status-pill--incomplete {
    background: color-mix(in srgb, #f59e0b 10%, transparent);
    color: #f59e0b;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .status-dot--active {
    background: var(--success);
    box-shadow: 0 0 6px color-mix(in srgb, var(--success) 50%, transparent);
  }

  .status-dot--incomplete {
    background: #f59e0b;
    box-shadow: 0 0 6px color-mix(in srgb, #f59e0b 50%, transparent);
  }

  /* Body */
  .stripe-body {
    padding: 1.5rem 1.25rem;
  }

  /* Loading */
  .stripe-loading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
    padding: 1rem 0;
  }

  .stripe-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  /* ── Connected state ─────────────────────────── */
  .stripe-connected {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .connected-icon {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .check-circle {
    animation: draw-circle 0.6s ease 0.2s both;
  }

  .check-path {
    stroke-dasharray: 20;
    stroke-dashoffset: 20;
    animation: draw-check 0.4s ease 0.7s both;
  }

  @keyframes draw-circle {
    from { stroke-dashoffset: 94.2; }
    to { stroke-dashoffset: 0; }
  }

  @keyframes draw-check {
    from { stroke-dashoffset: 20; }
    to { stroke-dashoffset: 0; }
  }

  .connected-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .connected-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .connected-sub {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .connected-details {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
  }

  .detail-label {
    color: var(--text-muted);
  }

  .detail-value {
    color: var(--text-secondary);
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.6875rem;
  }

  .detail-value--ok {
    color: var(--success);
    font-family: inherit;
  }

  /* ── Incomplete / checklist state ────────────── */
  .stripe-incomplete {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .incomplete-intro {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .progress-bar-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .progress-bar {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #635bff, var(--accent));
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .progress-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .checklist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-sm);
    background: var(--bg);
    border: 1px solid var(--border);
    transition: border-color 0.2s ease, opacity 0.2s ease;
  }

  .check-item--done {
    opacity: 0.6;
    border-color: transparent;
  }

  .check-item--pending {
    border-color: color-mix(in srgb, #f59e0b 25%, var(--border));
  }

  .check-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .check-label {
    flex: 1;
    font-size: 0.8125rem;
    color: var(--text);
  }

  .check-status {
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .check-item--done .check-status {
    color: var(--success);
  }

  .check-item--pending .check-status {
    color: #f59e0b;
  }

  .spin-icon {
    animation: spin 1s linear infinite;
  }

  /* ── Initial / not connected ─────────────────── */
  .stripe-initial {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }

  .initial-icon {
    margin-bottom: 0.25rem;
    opacity: 0.6;
  }

  .initial-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .initial-desc {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 360px;
  }

  .features {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0.5rem 0;
    width: 100%;
    max-width: 280px;
  }

  .feature {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  /* ── CTA button ──────────────────────────────── */
  .stripe-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.625rem 1.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: #635bff;
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
    white-space: nowrap;
    min-width: 180px;
    box-shadow: 0 1px 3px rgba(99, 91, 255, 0.2);
  }

  .stripe-cta:hover:not(:disabled) {
    background: #5147e5;
    box-shadow: 0 2px 8px rgba(99, 91, 255, 0.3);
    transform: translateY(-1px);
  }

  .stripe-cta:active:not(:disabled) {
    transform: translateY(0);
  }

  .stripe-cta:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 4px;
  }

  /* ── Error ───────────────────────────────────── */
  .stripe-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    padding: 0.625rem 0.75rem;
    background: color-mix(in srgb, var(--error) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 20%, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--error);
    line-height: 1.4;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
