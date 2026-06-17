<script lang="ts">
  /**
   * Up-front Stripe verification prompt for the event-creation flow. Card
   * payments settle through Stripe, so an organiser needs a connected + verified
   * (`charges_enabled`) account to publish an event that has card payments on.
   * The host renders this ONLY when a tier has card payments enabled — crypto-only
   * events are NOT gated on Stripe (anti-abuse for those is a separate future gate:
   * stake / proof-of-humanity — see docs/EVENT_CREATION_ANTI_ABUSE.md).
   *
   * Rendered at the TOP of the create flow so the organiser is prompted before
   * filling the form, not told via a disabled button afterwards. Binds `verified`
   * back to the host, which gates Publish on it. Renders nothing once verified.
   */
  import { onMount } from "svelte";
  import { getStripeAccountStatus } from "../../api/stripe.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";

  interface Props {
    /** null = still checking · false = not verified · true = charges_enabled. */
    verified?: boolean | null;
  }
  let { verified = $bindable(null) }: Props = $props();

  let modalOpen = $state(false);

  onMount(refresh);

  async function refresh() {
    if (!auth.isConnected) { verified = false; return; }
    try {
      const s = await getStripeAccountStatus();
      verified = !!(s.ok && s.onboardingComplete);
    } catch {
      // Non-fatal: the server's live charges_enabled check still gates publish.
      verified = false;
    }
  }

  function openSetup() {
    if (!auth.isConnected) {
      loginRequest.request().then((ok) => { if (ok) modalOpen = true; });
      return;
    }
    modalOpen = true;
  }

  function onConnected() {
    modalOpen = false;
    refresh();
  }
</script>

{#if verified !== true}
  <div class="gate" class:gate--checking={verified === null}>
    {#if verified === null}
      <span class="spinner" aria-label="Checking…"></span>
      <span class="checking-text">Checking your Stripe account…</span>
    {:else}
      <span class="lock-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="4" y="8" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M6 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <circle cx="9" cy="12" r="1.2" fill="currentColor"/>
        </svg>
      </span>
      <div class="gate-text">
        <p class="gate-title">Verify Stripe to accept card payments</p>
        <p class="gate-sub">
          {#if !auth.isConnected}
            Sign in, then connect Stripe — card payments run through it.
          {:else}
            Card payments settle through Stripe, so you need a connected, verified
            account to publish an event with card payments on. In test mode it
            takes ~2 minutes (use Stripe's “Use test data” / “Skip” buttons — no
            real business details needed). Crypto-only? Turn off card payments on
            the tier and publish without Stripe.
          {/if}
        </p>
      </div>
      <button class="setup-btn" onclick={openSetup}>
        {#if !auth.isConnected}Sign in →{:else}Set up Stripe →{/if}
      </button>
    {/if}
  </div>

  {#if modalOpen}
    <StripeConnectModal bind:open={modalOpen} onconnected={onConnected} />
  {/if}
{/if}

<style>
  .gate {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 35%, var(--border));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warning, #f59e0b) 7%, var(--bg-surface));
  }

  .gate--checking {
    border-color: var(--border);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .lock-icon {
    flex-shrink: 0;
    color: var(--warning, #f59e0b);
    display: inline-flex;
  }

  .gate-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .gate-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
  }

  .gate-sub {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text-secondary);
  }

  .setup-btn {
    flex-shrink: 0;
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background var(--transition);
  }

  .setup-btn:hover { background: var(--accent-hover); }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--text-muted);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  .checking-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
