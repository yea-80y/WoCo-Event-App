<script lang="ts">
  import {
    connectStripe,
    getOnboardingLink,
    getStripeAccountStatus,
    type StripeAccountStatus,
  } from "../../api/stripe.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  interface Props {
    open?: boolean;
    onclose?: () => void;
    /** Called when Stripe is fully connected — parent can enable the toggle */
    onconnected?: () => void;
  }

  let { open = $bindable(false), onclose, onconnected }: Props = $props();

  let status = $state<StripeAccountStatus | null>(null);
  let loading = $state(true);
  let actionLoading = $state(false);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let needsLogin = $state(false);
  /** True after we open Stripe in a new tab — shows "waiting" UI */
  let waitingForStripe = $state(false);

  const doneCount = $derived(
    status?.requirements?.categories?.filter((c) => c.status === "done").length ?? 0
  );
  const totalCount = $derived(status?.requirements?.categories?.length ?? 0);

  // Fetch status when modal opens
  $effect(() => {
    if (open) {
      loading = true;
      error = null;
      needsLogin = false;
      waitingForStripe = false;

      if (!auth.isConnected) {
        needsLogin = true;
        loading = false;
        return;
      }

      getStripeAccountStatus()
        .then((resp) => {
          if (resp.ok) {
            status = resp;
            if (resp.onboardingComplete) {
              onconnected?.();
            }
          }
        })
        .catch(() => {})
        .finally(() => { loading = false; });
    }
  });

  function close() {
    open = false;
    onclose?.();
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) close();
  }

  async function handleLogin() {
    close();
    const loggedIn = await loginRequest.request();
    if (loggedIn) {
      open = true;
    }
  }

  async function handleConnect() {
    actionLoading = true;
    error = null;
    try {
      await connectStripe();
      const link = await getOnboardingLink();
      if (link.alreadyComplete) {
        const resp = await getStripeAccountStatus();
        if (resp.ok) {
          status = resp;
          onconnected?.();
        }
        return;
      }
      if (link.url) {
        // Open in new tab so the event creation form is preserved
        window.open(link.url, "_blank");
        waitingForStripe = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to connect Stripe";
    } finally {
      actionLoading = false;
    }
  }

  async function handleContinue() {
    actionLoading = true;
    error = null;
    try {
      const link = await getOnboardingLink();
      if (link.alreadyComplete) {
        const resp = await getStripeAccountStatus();
        if (resp.ok) {
          status = resp;
          onconnected?.();
        }
        return;
      }
      if (link.url) {
        window.open(link.url, "_blank");
        waitingForStripe = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to get onboarding link";
    } finally {
      actionLoading = false;
    }
  }

  async function handleRefreshStatus() {
    refreshing = true;
    error = null;
    try {
      const resp = await getStripeAccountStatus();
      if (resp.ok) {
        status = resp;
        if (resp.onboardingComplete) {
          waitingForStripe = false;
          onconnected?.();
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to check status";
    } finally {
      refreshing = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" role="presentation" onclick={handleBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Stripe Connect">

      <!-- Header -->
      <div class="modal-header">
        <div class="modal-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="4" fill="#635bff"/>
            <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.918 3.757 7.11c0 4.46 2.72 6.326 7.007 7.945 2.55.963 3.44 1.607 3.44 2.686 0 .942-.79 1.524-2.269 1.524-1.95 0-4.733-.87-6.739-2.135L4.283 22.63C5.772 23.575 8.79 24 11.58 24c2.633 0 4.787-.642 6.29-1.818 1.635-1.275 2.46-3.152 2.46-5.58 0-4.603-2.771-6.41-6.354-7.452z" fill="white" transform="translate(2, 0) scale(0.83)"/>
          </svg>
          <span class="modal-title">Card Payments</span>
        </div>
        <button class="close-btn" onclick={close} aria-label="Close">&times;</button>
      </div>

      <!-- Content -->
      <div class="modal-content">

        {#if loading}
          <div class="modal-loading">
            <div class="modal-spinner"></div>
            <span>Checking your Stripe account...</span>
          </div>

        {:else if needsLogin}
          <div class="modal-state">
            <p class="state-title">Sign in to continue</p>
            <p class="state-desc">
              You need to sign in to your WoCo account before setting up Stripe payments.
            </p>
            <button class="modal-cta modal-cta--login" onclick={handleLogin}>
              Sign in
            </button>
          </div>

        {:else if waitingForStripe}
          <!-- Stripe opened in new tab — waiting for user to come back -->
          <div class="modal-state">
            <div class="waiting-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="14" stroke="#635bff" stroke-width="1.5" fill="none" opacity="0.2"/>
                <path d="M16 2A14 14 0 0 1 30 16" stroke="#635bff" stroke-width="2" stroke-linecap="round" fill="none" class="waiting-arc"/>
              </svg>
            </div>
            <p class="state-title">Complete setup on Stripe</p>
            <p class="state-desc">
              We've opened Stripe in a new tab. Complete your account setup there, then come back here.
            </p>
            <button class="modal-cta" onclick={handleRefreshStatus} disabled={refreshing}>
              {#if refreshing}
                <span class="cta-spinner"></span>
                Checking...
              {:else}
                I've finished setup
              {/if}
            </button>
            <p class="waiting-hint">
              Didn't see the tab? <button class="link-btn" onclick={handleConnect} disabled={actionLoading}>Open Stripe again</button>
            </p>
          </div>

        {:else if status?.onboardingComplete}
          <div class="modal-state modal-state--success">
            <div class="state-icon state-icon--success">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <circle cx="14" cy="14" r="13" stroke="var(--success)" stroke-width="2" fill="color-mix(in srgb, var(--success) 10%, transparent)"/>
                <path d="M8.5 14.5L12 18L19.5 10.5" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <p class="state-title">Stripe is connected</p>
            <p class="state-desc">You're all set to accept card payments from attendees.</p>
            <button class="modal-cta modal-cta--done" onclick={close}>Done</button>
          </div>

        {:else if status?.connected}
          <!-- Incomplete onboarding -->
          <div class="modal-state">
            <p class="state-subtitle">Your Stripe account is connected but needs a few more details before you can accept payments.</p>

            <div class="modal-progress">
              <div class="modal-progress-bar">
                <div class="modal-progress-fill" style="width: {totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%"></div>
              </div>
              <span class="modal-progress-label">{doneCount}/{totalCount}</span>
            </div>

            {#if status.requirements?.categories}
              <ul class="modal-checklist">
                {#each status.requirements.categories as cat}
                  <li class="modal-check" class:modal-check--done={cat.status === "done"} class:modal-check--pending={cat.status === "pending"}>
                    <span class="modal-check-icon">
                      {#if cat.status === "done"}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="7" fill="var(--success)" opacity="0.15"/>
                          <path d="M5 8.5L7 10.5L11 6" stroke="var(--success)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      {:else if cat.status === "pending"}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="modal-spin">
                          <circle cx="8" cy="8" r="6.5" stroke="#f59e0b" stroke-width="1.3" fill="none" opacity="0.2"/>
                          <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round" fill="none"/>
                        </svg>
                      {:else}
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <circle cx="8" cy="8" r="7" stroke="var(--text-muted)" stroke-width="1.2" fill="none" opacity="0.35"/>
                        </svg>
                      {/if}
                    </span>
                    <span class="modal-check-label">{cat.label}</span>
                    {#if cat.status === "pending"}
                      <span class="modal-check-tag modal-check-tag--pending">Verifying</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}

            <button class="modal-cta" onclick={handleContinue} disabled={actionLoading}>
              {#if actionLoading}
                <span class="cta-spinner"></span>
                Opening Stripe...
              {:else}
                Complete verification
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="margin-left: 2px;">
                  <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {/if}
            </button>
          </div>

        {:else}
          <!-- Not connected at all -->
          <div class="modal-state">
            <p class="state-title">Accept Payments</p>
            <p class="state-desc">
              This event is not yet set up to accept payments.
            </p>
            <p class="state-desc" style="margin-top: 0.125rem;">
              We use <strong style="color: var(--text);">Stripe</strong> to process payments. Connect or create a Stripe account to start accepting payments. It usually takes less than 5 minutes.
            </p>

            <button class="modal-cta" onclick={handleConnect} disabled={actionLoading}>
              {#if actionLoading}
                <span class="cta-spinner"></span>
                Setting up...
              {:else}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right: 4px;">
                  <rect width="24" height="24" rx="4" fill="#635bff"/>
                  <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.918 3.757 7.11c0 4.46 2.72 6.326 7.007 7.945 2.55.963 3.44 1.607 3.44 2.686 0 .942-.79 1.524-2.269 1.524-1.95 0-4.733-.87-6.739-2.135L4.283 22.63C5.772 23.575 8.79 24 11.58 24c2.633 0 4.787-.642 6.29-1.818 1.635-1.275 2.46-3.152 2.46-5.58 0-4.603-2.771-6.41-6.354-7.452z" fill="white" transform="translate(2, 0) scale(0.83)"/>
                </svg>
                Connect Stripe
              {/if}
            </button>
          </div>
        {/if}

        {#if error}
          <div class="modal-error">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="var(--error)" stroke-width="1.2" fill="none"/>
              <path d="M7 4V7.5M7 9.5V10" stroke="var(--error)" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
            {error}
          </div>
        {/if}

      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fade-in 0.15s ease;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 90vw;
    max-width: 400px;
    overflow: hidden;
    animation: modal-in 0.2s ease;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .modal-logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .modal-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .close-btn {
    color: var(--text-muted);
    font-size: 1.375rem;
    line-height: 1;
    transition: color var(--transition);
    padding: 0 0.125rem;
  }

  .close-btn:hover {
    color: var(--text);
  }

  .modal-content {
    padding: 1.5rem 1.25rem;
  }

  /* Loading */
  .modal-loading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: 0.8125rem;
    padding: 1.5rem 0;
    justify-content: center;
  }

  .modal-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  /* State containers */
  .modal-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.625rem;
  }

  .modal-state--success {
    padding: 1rem 0 0.5rem;
  }

  .state-icon {
    margin-bottom: 0.25rem;
  }

  .state-icon--success {
    animation: pop-in 0.3s ease;
  }

  @keyframes pop-in {
    0% { transform: scale(0.5); opacity: 0; }
    70% { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }

  .state-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .state-subtitle {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    text-align: left;
    width: 100%;
  }

  .state-desc {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.55;
    max-width: 340px;
  }

  /* Waiting for Stripe (new tab) */
  .waiting-icon {
    margin-bottom: 0.25rem;
  }

  .waiting-arc {
    animation: spin 1.2s linear infinite;
    transform-origin: 16px 16px;
  }

  .waiting-hint {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .link-btn {
    color: #635bff;
    font-size: inherit;
    font-weight: 500;
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    transition: color 0.15s ease;
  }

  .link-btn:hover {
    color: #5147e5;
  }

  .link-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Progress */
  .modal-progress {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    margin: 0.25rem 0;
  }

  .modal-progress-bar {
    flex: 1;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .modal-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #635bff, var(--accent));
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .modal-progress-label {
    font-size: 0.625rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  /* Checklist */
  .modal-checklist {
    list-style: none;
    margin: 0.25rem 0;
    padding: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .modal-check {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-sm);
    background: var(--bg);
    transition: opacity 0.2s ease;
  }

  .modal-check--done {
    opacity: 0.5;
  }

  .modal-check-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .modal-check-label {
    flex: 1;
    font-size: 0.8125rem;
    color: var(--text);
    text-align: left;
  }

  .modal-check-tag {
    font-size: 0.5625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.125rem 0.375rem;
    border-radius: 9999px;
  }

  .modal-check-tag--pending {
    background: color-mix(in srgb, #f59e0b 12%, transparent);
    color: #f59e0b;
  }

  .modal-spin {
    animation: spin 1s linear infinite;
  }

  /* CTA */
  .modal-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    width: 100%;
    padding: 0.625rem 1rem;
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: #635bff;
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
    box-shadow: 0 1px 3px rgba(99, 91, 255, 0.15);
  }

  .modal-cta:hover:not(:disabled) {
    background: #5147e5;
    box-shadow: 0 2px 8px rgba(99, 91, 255, 0.25);
    transform: translateY(-1px);
  }

  .modal-cta:active:not(:disabled) {
    transform: translateY(0);
  }

  .modal-cta:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .modal-cta--done {
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: none;
  }

  .modal-cta--done:hover:not(:disabled) {
    background: var(--bg-surface-hover);
    box-shadow: none;
  }

  .modal-cta--login {
    background: var(--accent);
    box-shadow: 0 1px 3px rgba(124, 108, 240, 0.15);
  }

  .modal-cta--login:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 2px 8px rgba(124, 108, 240, 0.25);
  }

  .cta-spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 4px;
  }

  /* Error */
  .modal-error {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
    padding: 0.5rem 0.625rem;
    background: color-mix(in srgb, var(--error) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 15%, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--error);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
