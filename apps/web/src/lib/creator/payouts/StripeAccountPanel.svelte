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
  frame around them; we do not own what is inside, and cannot style it with CSS —
  only Stripe's appearance variables, which connect-embed.ts feeds from the same
  design tokens as this file, so the iframe renders dark rather than as a white
  card dropped into a dark screen (verified 2026-07-31).

  The left edge carries state, matching the sales groups on this screen: acid
  while Stripe is waiting on the organiser, quiet once there is nothing to do.

  Note for anyone expecting a seamless experience: account details sit behind a
  Stripe sign-in. `disable_stripe_user_authentication` is only accepted when
  `controller.requirement_collection` is "application"; ours is "stripe". That
  gate is Stripe's, not ours, and it cannot be turned off from here.
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
     * Changes when the organiser does, so the panel tears down rather than
     * showing the previous account's details.
     */
    identity: string;
  }

  const { identity }: Props = $props();

  let bannerHost = $state<HTMLDivElement | null>(null);
  let managementHost = $state<HTMLDivElement | null>(null);

  let status = $state<"idle" | "loading" | "ready" | "failed">("idle");
  let failure = $state<ConnectFailure | null>(null);
  /** What Stripe is waiting on. 0 total means the banner renders nothing at all. */
  let notifications = $state({ total: 0, actionRequired: 0 });

  let instance: ConnectInstance | null = null;
  let mounted: ConnectComponent[] = [];
  /** Discards a slow mount whose identity has since been replaced. */
  let mountToken = 0;

  function teardown(): void {
    for (const el of mounted) el.remove();
    mounted = [];
    instance = null;
    notifications = { total: 0, actionRequired: 0 };
  }

  async function mount(): Promise<void> {
    const token = ++mountToken;
    teardown();
    status = "loading";
    failure = null;

    try {
      await loadConnectScript();
      if (token !== mountToken) return;

      // Proven before anything renders: no point loading Stripe's UI to then
      // discover we cannot authorise it.
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
        // so it must re-mint rather than replay the one already used.
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
        if (token === mountToken) notifications = { total: e.total, actionRequired: e.actionRequired };
      });
      banner.setOnLoadError?.((e) => {
        // Cosmetic next to account-management: the organiser can still reach
        // their details, they just lose the shortcut to the thing that needs doing.
        console.warn("[stripe-connect] notification-banner load error:", e.error?.message);
      });

      const management = instance.create("account-management");
      management.setOnLoadError?.((e) => {
        if (token !== mountToken) return;
        failure = connectFailure("unknown", e.error?.message ?? "account-management failed to load");
        status = "failed";
      });

      // Attach only once both exist — a half-mounted panel reads as broken.
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

  // Remount on identity change, once the hosts exist.
  $effect(() => {
    const id = identity;
    if (!id || !bannerHost || !managementHost) return;
    void mount();
  });

  onDestroy(teardown);
</script>

<section
  class="account"
  class:account--waiting={status === "ready" && notifications.actionRequired > 0}
>
  <header class="head">
    <h2 class="label mono">YOUR STRIPE ACCOUNT</h2>
    <!-- Only ever an assertion we can stand behind. Stripe reports zero
         notifications for a signed-out organiser too, so "nothing to do" would
         claim a clean bill of health we have not actually been told — on the
         screen where that claim costs the most. -->
    {#if status === "ready" && notifications.actionRequired > 0}
      <span class="status">{notifications.actionRequired} to do</span>
    {/if}
  </header>

  <p class="blurb">
    Stripe holds your bank details and verifies your business — WoCo never sees them.
    Stripe asks you to sign in before showing or changing them.
  </p>

  <!-- Both hosts stay in the DOM across every state: Stripe mounts live iframes
       into these nodes, and removing them would tear the iframe out. Collapsed
       with a class instead — including the banner, which renders nothing at all
       when Stripe is waiting on nothing. -->
  <div class="embed" class:embed--hidden={status !== "ready"}>
    <div class="banner" class:banner--empty={notifications.total === 0} bind:this={bannerHost}></div>
    <div bind:this={managementHost}></div>
  </div>

  {#if status === "loading"}
    <p class="loading mono" aria-live="polite">LOADING YOUR STRIPE ACCOUNT…</p>
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
  /* Same object language as the sales groups: flat surface, hairline border,
     2px left edge carrying state. */
  .account {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: 2px solid var(--border-hover);
    border-radius: var(--radius-md);
    padding: 1.125rem 1.25rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: border-color var(--transition);
  }

  /* Acid only when Stripe is actually waiting on the organiser — the one place
     on this screen where the accent means "you need to act". */
  .account--waiting {
    border-left-color: var(--accent);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .label {
    margin: 0;
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    color: var(--text-muted);
  }

  /* Only rendered when Stripe is waiting on something, so it is always the
     accent — this is the one place on the screen where acid means "act". */
  .status {
    font-size: 0.6875rem;
    color: var(--accent);
    white-space: nowrap;
  }

  .blurb {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--text-muted);
    max-width: 60ch;
  }

  .embed {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .embed--hidden,
  /* Stripe renders an empty element when there is nothing to notify about;
     without this the panel shows a gap where a banner never appears. */
  .banner--empty {
    display: none;
  }

  .loading {
    margin: 0;
    font-size: 0.625rem;
    letter-spacing: 0.14em;
    color: var(--text-dim);
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .notice--warn {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, var(--border));
  }

  .notice--warn span {
    flex: 1;
    min-width: 0;
  }

  .link-quiet {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0;
    background: none;
    border: none;
    font: inherit;
    font-size: 0.75rem;
    color: var(--warning);
    text-decoration: underline;
    cursor: pointer;
    white-space: nowrap;
  }

  .link-quiet:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
