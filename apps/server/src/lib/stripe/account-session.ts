/**
 * Account Sessions — the organiser's only door to their own Stripe account.
 *
 * Under Managed Risk with `controller.stripe_dashboard.type = "none"` there is
 * no Express Dashboard and `accounts.createLoginLink` hard-fails ("does not
 * have access to the Express Dashboard", verified against a live sandbox
 * account 2026-07-31). Connect embedded components ARE the replacement, and an
 * Account Session is what authorises them: the server mints a short-lived
 * client secret for ONE connected account, and connect.js exchanges it for the
 * component iframes.
 *
 * The components block lives here rather than inline in the route for the same
 * reason as account-params.ts: it decides what an organiser can reach and what
 * they cannot, so it is pinned by tests instead of being a literal someone can
 * quietly widen.
 */

import type Stripe from "stripe";

/**
 * What the payouts screen is allowed to mount.
 *
 * `external_account_collection` is the load-bearing one — it is what lets an
 * organiser add or change the bank account they get paid into, which is the
 * job the deleted "Manage bank details" button used to do. Set explicitly
 * rather than left to Stripe's default, because a default that changes would
 * silently strand every organiser's bank details behind a component that can no
 * longer edit them.
 *
 * `disable_stripe_user_authentication` is deliberately ABSENT. Stripe only
 * accepts it as `true` when `controller.requirement_collection = "application"`;
 * ours is `"stripe"`, so organisers must sign in to Stripe to view or change
 * sensitive details. Verified against the live API 2026-07-31 — the session
 * comes back with `disable_stripe_user_authentication: false` and account
 * management renders a Stripe sign-in gate. Setting it here would be rejected,
 * not honoured.
 */
export const ACCOUNT_SESSION_COMPONENTS = {
  notification_banner: {
    enabled: true,
    features: { external_account_collection: true },
  },
  account_management: {
    enabled: true,
    features: { external_account_collection: true },
  },
} as const satisfies Stripe.AccountSessionCreateParams.Components;

export function buildAccountSessionParams(stripeAccountId: string): Stripe.AccountSessionCreateParams {
  return {
    account: stripeAccountId,
    components: ACCOUNT_SESSION_COMPONENTS,
  };
}

export type PublishableKeyResolution =
  | { ok: true; publishableKey: string }
  | { ok: false; reason: string };

/**
 * The publishable key travels WITH the client secret rather than being built
 * into the frontend.
 *
 * The frontend and the server are deployed separately here (the frontend is a
 * Swarm feed the owner publishes; the server is a container we redeploy), so a
 * `VITE_STRIPE_PUBLISHABLE_KEY` baked in at build time can drift out of step
 * with the secret key the server is running. A test publishable key against a
 * live account session fails inside connect.js with an error the organiser
 * cannot act on and we never see. Shipping both from one place makes that
 * mismatch impossible to express.
 *
 * The mode check is the same argument one level down: `sk_live` with `pk_test`
 * is a deploy mistake, and it should stop here with a log we can read rather
 * than surface as a broken widget.
 */
export function resolvePublishableKey(
  secretKey: string | undefined,
  publishableKey: string | undefined,
): PublishableKeyResolution {
  if (!publishableKey) return { ok: false, reason: "STRIPE_PUBLISHABLE_KEY is not set" };
  if (!publishableKey.startsWith("pk_")) {
    return { ok: false, reason: "STRIPE_PUBLISHABLE_KEY is not a publishable key (expected pk_…)" };
  }

  const secretMode = secretKey?.startsWith("sk_live_") || secretKey?.startsWith("rk_live_")
    ? "live"
    : secretKey?.startsWith("sk_test_") || secretKey?.startsWith("rk_test_")
      ? "test"
      : null;
  const publishableMode = publishableKey.startsWith("pk_live_")
    ? "live"
    : publishableKey.startsWith("pk_test_")
      ? "test"
      : null;

  if (secretMode && publishableMode && secretMode !== publishableMode) {
    return {
      ok: false,
      reason: `Stripe key mode mismatch: secret key is ${secretMode}, publishable key is ${publishableMode}`,
    };
  }

  return { ok: true, publishableKey };
}

/** How the route should answer when Stripe refuses to mint a session. */
export interface AccountSessionFailure {
  /** HTTP status for OUR response — not Stripe's. */
  status: 400 | 502;
  /** Shown to the organiser verbatim, so it has to be actionable. */
  message: string;
  /** True when the local record points at an account Stripe no longer has. */
  dropRecord: boolean;
}

/**
 * Map a Stripe failure onto something an organiser can act on.
 *
 * Mirrors the login-link convention this endpoint replaces: a 4xx from Stripe
 * is a "finish setup" prompt and must not surface as our 500, while 429 is
 * Stripe throttling US — the organiser did nothing wrong and retrying later is
 * the correct advice.
 *
 * Kept pure (no Stripe SDK calls, no store writes) so every branch is unit
 * testable; the caller performs the record deletion that `dropRecord` asks for.
 */
export function classifyAccountSessionError(err: unknown): AccountSessionFailure {
  const e = err as { statusCode?: unknown; code?: unknown } | null | undefined;
  const statusCode = typeof e?.statusCode === "number" ? e.statusCode : undefined;

  // The account was deleted on Stripe's side. Same self-heal as /account-status:
  // drop the stale record so the UI offers "connect" rather than looping on an
  // account that cannot exist.
  if (statusCode === 404 || e?.code === "resource_missing") {
    return {
      status: 400,
      message: "Your Stripe account is no longer connected. Connect Stripe again.",
      dropRecord: true,
    };
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return {
      status: 400,
      message: "Stripe won't open your account details yet — finish verification first.",
      dropRecord: false,
    };
  }

  return {
    status: 502,
    message: "Stripe is unavailable right now. Try again shortly.",
    dropRecord: false,
  };
}
