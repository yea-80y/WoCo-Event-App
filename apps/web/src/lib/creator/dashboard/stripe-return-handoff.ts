/**
 * Handing "Stripe onboarding came back" from the RETURN tab to the tab that
 * started it (#508).
 *
 * `StripeConnectModal` opens onboarding with `window.open` so the half-filled
 * event or site form in the original tab survives. The cost is that Stripe's
 * redirect lands in the SECOND tab, which is where the app then said "connected"
 * and offered "Back to dashboard" — a second copy of the app in a throwaway tab
 * — while the original tab sat waiting on a manual button, told nothing. This
 * module is the wire between the two: same-origin, no server, no shared storage.
 *
 * The message is a NUDGE, never the answer. Anything a same-origin tab can post
 * is unauthenticated by construction, so the waiting modal re-reads the account
 * status from the server for EVERY message and only that read may end the wait
 * (`shouldStopWaiting`) — which is also what fires `onconnected`.
 */

/** Same-origin channel name. One constant so the two tabs cannot drift apart. */
export const STRIPE_HANDOFF_CHANNEL = "woco-stripe";

export interface StripeReturnMessage {
  type: "stripe-onboarding-returned";
  /** What the return tab's own status read saw. Advisory — see the module note. */
  onboardingComplete: boolean;
}

export function stripeReturnMessage(onboardingComplete: boolean): StripeReturnMessage {
  return { type: "stripe-onboarding-returned", onboardingComplete };
}

export function isStripeReturnMessage(data: unknown): data is StripeReturnMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Partial<StripeReturnMessage>;
  return m.type === "stripe-onboarding-returned" && typeof m.onboardingComplete === "boolean";
}

/** The slice of BroadcastChannel used here, so both paths are testable without a DOM. */
export type StripeHandoffChannel = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};
export type StripeHandoffChannelFactory = (name: string) => StripeHandoffChannel;

/** Null where the browser has no BroadcastChannel — callers degrade, never throw. */
export function defaultHandoffChannelFactory(): StripeHandoffChannelFactory | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return (name) => new BroadcastChannel(name) as unknown as StripeHandoffChannel;
}

/** Announce the return. Returns whether it went out, for the caller's own logging. */
export function postStripeReturn(
  onboardingComplete: boolean,
  makeChannel: StripeHandoffChannelFactory | null = defaultHandoffChannelFactory(),
): boolean {
  if (!makeChannel) return false;
  try {
    const ch = makeChannel(STRIPE_HANDOFF_CHANNEL);
    ch.postMessage(stripeReturnMessage(onboardingComplete));
    ch.close();
    return true;
  } catch {
    // A dead channel just means the waiting tab falls back to visibilitychange
    // or its manual button; it must never break the return page's own render.
    return false;
  }
}

/** Listen while a tab is waiting. Returns the unsubscribe the caller MUST run. */
export function subscribeStripeReturn(
  onReturn: (message: StripeReturnMessage) => void,
  makeChannel: StripeHandoffChannelFactory | null = defaultHandoffChannelFactory(),
): () => void {
  if (!makeChannel) return () => {};
  let ch: StripeHandoffChannel;
  try {
    ch = makeChannel(STRIPE_HANDOFF_CHANNEL);
  } catch {
    return () => {};
  }
  ch.onmessage = (ev) => {
    if (isStripeReturnMessage(ev.data)) onReturn(ev.data);
  };
  return () => {
    try {
      ch.onmessage = null;
      ch.close();
    } catch {
      /* already closed */
    }
  };
}

/**
 * May the waiting modal stop waiting? Only a status read that SUCCEEDED and says
 * onboarding is complete — never the message's own `onboardingComplete`, and
 * never an error envelope, which is truthy and would otherwise read as "done".
 */
export function shouldStopWaiting(
  status: { ok: boolean; onboardingComplete?: boolean } | null | undefined,
): boolean {
  return status?.ok === true && status.onboardingComplete === true;
}
