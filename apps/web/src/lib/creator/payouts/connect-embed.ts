/**
 * Loading Stripe's Connect embedded components.
 *
 * These components ARE the organiser's account UI now — under Managed Risk with
 * `stripe_dashboard.type = "none"` there is no Express Dashboard to fall back
 * to, so a failure here is not a degraded view, it is an organiser who cannot
 * reach their own bank details. Everything below exists to make that failure
 * legible rather than silent.
 *
 * connect.js is loaded from Stripe's CDN rather than bundled: it is ~880KB and
 * Stripe versions it themselves. No npm dependency — the CDN script exposes
 * `window.StripeConnect.init`, which is all we need, so the types below are the
 * small slice of the surface we actually use.
 *
 * Verified on gateway.woco-net.com and woco.eth.limo, 2026-07-31: neither
 * origin sets a CSP or COOP that blocks it, and no rule in EasyList,
 * EasyPrivacy or the uBlock Origin lists targets connect-js.stripe.com.
 */

const CONNECT_JS_URL = "https://connect-js.stripe.com/v1.0/connect.js";

/** Ad blockers sometimes stall a request rather than failing it outright. */
const LOAD_TIMEOUT_MS = 15_000;

export type ConnectFailureKind = "blocked" | "session" | "unknown";

export interface ConnectFailure {
  kind: ConnectFailureKind;
  /** Shown to the organiser, so it names a next action. */
  message: string;
  /** For the console, never for the screen. */
  detail: string;
}

export function connectFailure(kind: ConnectFailureKind, detail: string): ConnectFailure {
  const message =
    kind === "blocked"
      ? "Couldn't load Stripe. An ad blocker or privacy extension may be blocking it — allow stripe.com and try again."
      : kind === "session"
        ? "Couldn't open your Stripe account details. Try again in a moment."
        : "Something went wrong loading your Stripe account details.";
  return { kind, message, detail };
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

/** Minimal shape of the components we mount. Stripe returns HTMLElements. */
export interface ConnectComponent extends HTMLElement {
  setOnLoadError?(handler: (event: { error?: { type?: string; message?: string } }) => void): void;
  setOnNotificationsChange?(handler: (event: { total: number; actionRequired: number }) => void): void;
}

export interface ConnectInstance {
  create(component: "notification-banner" | "account-management"): ConnectComponent;
  logout?(): Promise<void>;
}

interface StripeConnectGlobal {
  init(options: {
    publishableKey: string;
    fetchClientSecret: () => Promise<string | undefined>;
    appearance?: { variables?: Record<string, string> };
  }): ConnectInstance;
}

declare global {
  interface Window {
    StripeConnect?: StripeConnectGlobal;
  }
}

/**
 * Injected once per page, not once per mount — the script is ~880KB and the
 * payouts screen can mount and unmount as the organiser navigates.
 *
 * A FAILED load is deliberately not memoised: a blocked or flaky first attempt
 * would otherwise poison every retry for the life of the tab, and "try again"
 * has to mean something.
 */
let scriptLoad: Promise<void> | null = null;

export function loadConnectScript(): Promise<void> {
  if (window.StripeConnect?.init) return Promise.resolve();
  if (scriptLoad) return scriptLoad;

  scriptLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CONNECT_JS_URL}"]`);
    const script = existing ?? document.createElement("script");
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(connectFailure("blocked", `connect.js did not load within ${LOAD_TIMEOUT_MS}ms`));
    }, LOAD_TIMEOUT_MS);

    const done = (err?: ConnectFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      // The script can fire load before defining the global on a partial fetch.
      else if (!window.StripeConnect?.init) {
        reject(connectFailure("blocked", "connect.js loaded but StripeConnect.init is missing"));
      } else resolve();
    };

    script.addEventListener("load", () => done());
    script.addEventListener("error", () =>
      // A cross-origin script error is opaque by design; on an origin we have
      // already proven serves it, a blocker is far and away the likeliest cause.
      done(connectFailure("blocked", "connect.js failed to load")),
    );

    if (!existing) {
      script.src = CONNECT_JS_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return scriptLoad.catch((err) => {
    scriptLoad = null;
    throw err;
  });
}

/** Test seam — resets the module-level memo between cases. */
export function __resetConnectScriptForTests(): void {
  scriptLoad = null;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/**
 * Dress Stripe's iframes in WoCo's tokens.
 *
 * Read from the live stylesheet rather than hardcoded, so the components follow
 * the theme instead of drifting from it the first time a token changes. Any
 * token that cannot be read is simply omitted — Stripe's own default is a far
 * better outcome than an empty string, which it rejects.
 */
/** Stripe appearance variable ← WoCo design token. */
const APPEARANCE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["colorPrimary", "--accent"],
  ["colorBackground", "--bg-surface"],
  ["colorText", "--text"],
  ["colorSecondaryText", "--text-secondary"],
  ["colorBorder", "--border"],
  ["colorDanger", "--error"],
  ["buttonPrimaryColorBackground", "--accent"],
  ["buttonPrimaryColorBorder", "--accent"],
  ["buttonPrimaryColorText", "--accent-ink"],
];

/**
 * Pure half of the mapping, so the omit-on-missing rule is testable without a
 * DOM. Stripe accepts hex, rgb() and hsl() — which is what these tokens are.
 */
export function buildConnectAppearance(read: (cssVar: string) => string | null): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [stripeVar, cssVar] of APPEARANCE_TOKENS) {
    const value = read(cssVar);
    if (value) variables[stripeVar] = value;
  }
  return variables;
}

export function connectAppearance(root: HTMLElement = document.documentElement): Record<string, string> {
  const styles = getComputedStyle(root);
  return buildConnectAppearance((name) => {
    const value = styles.getPropertyValue(name).trim();
    return value === "" ? null : value;
  });
}
