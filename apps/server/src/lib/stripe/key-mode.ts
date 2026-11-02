/**
 * Which Stripe mode the server's secret key runs in (#1000), read from its
 * prefix: a secret (`sk_`) or restricted (`rk_`) key, then `live_` or `test_`.
 *
 * Anything else is "unknown", and every caller treats unknown as "cannot
 * judge", never as either mode. A rule that misread a valid live key - a
 * restricted `rk_live_` key is the planned replacement for the full secret key -
 * would refuse every production webhook and stop all ticket fulfilment.
 */

export type StripeKeyMode = "live" | "test" | "unknown";

export function stripeKeyMode(key: string | undefined): StripeKeyMode {
  const m = /^(?:sk|rk)_(live|test)_/.exec(key ?? "");
  return m ? (m[1] as "live" | "test") : "unknown";
}

/**
 * The webhook signing secrets a server is missing, or [] when none are owed.
 * Owed whenever Stripe is configured AND the server is in production OR holds
 * a live key: a live key without its secrets must not boot even if NODE_ENV
 * was lost, because the route would then refuse every real webhook.
 */
export function missingWebhookSecrets(env: Record<string, string | undefined>): string[] {
  if (!env.STRIPE_SECRET_KEY) return [];
  if (env.NODE_ENV !== "production" && stripeKeyMode(env.STRIPE_SECRET_KEY) !== "live") return [];
  return ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_PLATFORM"].filter((name) => !env[name]);
}
