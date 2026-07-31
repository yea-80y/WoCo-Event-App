<!--
  The organiser's own Stripe account, embedded.

  Replaces the "Manage bank details" button that opened the Express Dashboard.
  Under Managed Risk with `stripe_dashboard.type = "none"` that dashboard does
  not exist, so these two components are the only way an organiser can see what
  Stripe still needs from them and change the bank account they get paid into.

  Two components, two jobs:
    notification-banner — what Stripe needs from you, if anything
    account-management  — bank details, business details, verification

  Both are Stripe-hosted iframes. We own the loading, the failure states and the
  frame around them; we do not own what is inside, and cannot style it with CSS
  (only Stripe's appearance variables — see connect-embed.ts).

  Note for anyone reading this expecting a seamless experience: account details
  sit behind a Stripe sign-in. `disable_stripe_user_authentication` is only
  accepted when `controller.requirement_collection` is "application"; ours is
  "stripe". That gate is Stripe's, not ours, and it cannot be turned off from
  here.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { getAccountSession } from "../../api/payouts.js";
  import {
    loadConnectScript,
    connectAppearance,
    connectFailure,
    type ConnectFailure,
    type ConnectInstance,
    type ConnectComponent,
  } from "./connect-embed.js";
  import AlertCircle from "lucide-svelte/icons/circle-alert";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";

  interface Props {
    /**
     * Bumped by the parent when the organiser's identity changes, so the panel
     * tears down rather than showing the previous account's details.
     */
    identity: string;
  }

  const { identity }: Props = $props();

  let bannerHost = $state<HTMLDivElement | null>(null);
  let managementHost = $state<HTMLDivElement | null>(null);

  let status = $state<"idle" | "loading" | "ready" | "failed">("idle");
  let failure = $state<ConnectFailure | null>(null);
  /** Stripe tells us how many things it needs; 0 means "nothing to do". */
  let actionRequired = $state(0);

  let instance: ConnectInstance | null = null;
  let mounted: ConnectComponent[] = [];
  /** Discards a slow mount whose identity has since been replaced. */
  let mountToken = 0;

  function teardown(): void {
    for (const el of mounted) el.remove();
    mounted = [];
    instance = null;
    actionRequired = 0;
  }

  async function mount(): Promise<void> {
    const token = ++mountToken;
    teardown();
    status = "loading";
    failure = null;

    try {
      await loadConnectScript();
      if (token !== mountToken) return;

      // Proven before anything is rendered: no point loading Stripe's UI to
      // then discover we cannot authorise it.
      const first = await getAccountSession();
      if (token !== mountToken) return;
      if (!first.ok) {
        failure = { kind: "session", message: first.error.message, detail: first.error.detail };
        status = "failed";
        return;
      }

      instance = window.StripeConnect!.init({
        publishableKey: first.session.publishableKey,
        // Called again by connect.js whenever the secret expires (~2 minutes),
        // so it must re-mint rather than replay the one we already used.
        // Returning undefined is Stripe's documented "I could not get one".
        fetchClientSecret: async () => {
          const next = await getAccountSession();
          if (next.ok) return next.session.clientSecret;
          console.warn("[stripe-connect] Could not refresh account session:", next.error.detail);
          return undefined;
        },
        appearance: { variables: connectAppearance() },
      });

      const banner = instance.create("notification-banner");
      banner.setOnNotificationsChange?.((e) => {
        if (token === mountToken) actionRequired = e.actionRequired;
      });
      banner.setOnLoadError?.((e) => {
        console.warn("[stripe-connect] notification-banner load error:", e.error?.message);
      });

      const management = instance.create("account-management");
      management.setOnLoadError?.((e) => {
        // The banner failing is cosmetic; account management failing means the
        // organiser cannot reach their bank details, which they must be told.
        if (token !== mountToken) return;
        failure = connectFailure("unknown", e.error?.message ?? "account-management failed to load");
        status = "failed";
      });

      // Only attach once both are built — a half-mounted panel reads as broken.
      bannerHost?.appendChild(banner);
      managementHost?.appendChild(management);
      mounted = [banner, management];
      status = "ready";
    } catch (err) {
      if (token !== mountToken) return;
      failure =
        err && typeof err === "object" && "kind" in err
          ? (err as ConnectFailure)
          : connectFailure("unknown", err instanceof Error ? err.message : String(err));
      status = "failed";
    }
  }

  // Remount on identity change, and only once the hosts exist.
  $effect(() => {
    const id = identity;
    if (!id || !bannerHost || !managementHost) return;
    void mount();
  });

  onDestroy(teardown);
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title mono">YOUR STRIPE ACCOUNT</h2>
    {#if status === "ready" && actionRequired > 0}
      <span class="pill pill--warn">
        {actionRequired} {actionRequired === 1 ? "action needed" : "actions needed"}
      </span>
    {/if}
  </header>

  <p class="panel-note">
    Stripe holds your bank details and verifies your business — WoCo never sees them.
    You'll be asked to sign in to Stripe to view or change them.
  </p>

  <!-- Kept in the DOM across states: Stripe mounts into these nodes, and
       recreating them on every status flip would detach a live iframe. -->
  <div class="embed" class:embed--hidden={status !== "ready"}>
    <div bind:this={bannerHost}></div>
    <div bind:this={managementHost}></div>
  </div>

  {#if status === "loading"}
    <p class="embed-state">Loading your Stripe account…</p>
  {/if}

  {#if status === "failed" && failure}
    <div class="notice notice--warn" role="alert">
      <AlertCircle size={15} strokeWidth={2.25} />
      <span>{failure.message}</span>
      <button class="link-quiet" onclick={() => void mount()}>
        <RefreshCw size={13} strokeWidth={2.25} />
        Try again
      </button>
    </div>
  {/if}
</section>

<style>
  .panel {
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-title {
    margin: 0;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .panel-note {
    margin: 0.5rem 0 1rem;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .pill {
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .pill--warn {
    background: var(--error-subtle);
    color: var(--error);
  }

  /* Hidden, not unmounted — see the comment on .embed above. */
  .embed--hidden {
    display: none;
  }

  .embed-state {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }

  .notice--warn {
    color: var(--text-secondary);
  }

  .notice--warn :global(svg) {
    color: var(--warning);
    flex-shrink: 0;
  }

  .link-quiet {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--accent-text);
    font: inherit;
    cursor: pointer;
  }

  .link-quiet:hover {
    text-decoration: underline;
  }
</style>
