/**
 * The Web3Auth SDK as WoCo's sign-in code uses it, over `@web3auth/modal` v11.
 *
 * v11 (the 2026-10-10 upgrade: two iPhones in Safari failed inside v10's
 * `auth.web3auth.io/v10` sign-in frame) changed two things this code depends on:
 *  - there is no `web3auth.provider` any more (connections live in a map, and
 *    `connection.ethereumProvider` may be a signing proxy);
 *  - `connect()` resolves with a CONNECTION, not a provider.
 * The key itself still comes from the auth connector's own provider: under
 * `CHAIN_NAMESPACES.OTHER` that is a `CommonPrivateKeyProvider` serving
 * `private_key`, exactly as in v10 (no-modal `authConnector.init` / `connectWithProvider`).
 *
 * So this presents v11 in the v10 shape the #182/#803/#836/#843 rules were built
 * and tested against - `provider` is the auth connector's provider (present from
 * init, serving the key once a session is bound, as v10's was), and `connect()`
 * resolves with that provider, or null when nothing connected. Everything else
 * passes straight through. Pure: no SDK import, so it runs under node:test.
 */

import type { LoginMethodConfig } from "./web3auth-direct.js";

export type KeyProvider = { request: (args: { method: string }) => Promise<unknown> };

/** The v11 instance, as far as this module reads it. */
export type Web3AuthV11Like = {
  readonly connected: boolean;
  readonly status: string;
  readonly cachedConnector: string | null;
  init(): Promise<void>;
  connect(): Promise<unknown>;
  logout(options?: { cleanup?: boolean }): Promise<void>;
  getConnector(name: string): { provider: unknown } | null;
  getUserInfo(): Promise<unknown>;
  /** Public: the modal's own email/Google buttons sign in through it (`onSocialLogin`). */
  connectTo?(connectorName: string, loginParams?: unknown, loginMode?: unknown): Promise<unknown>;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
};

/** The shape WoCo's sign-in code reads (v10's). */
export type Web3AuthInstance = {
  readonly connected: boolean;
  readonly status: string;
  readonly provider: KeyProvider | null;
  readonly cachedConnector: string | null;
  init(): Promise<void>;
  connect(): Promise<KeyProvider | null>;
  logout(options?: { cleanup?: boolean }): Promise<void>;
  on(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
  /** The signed-in user's profile (the email backup reads its login category). */
  getUserInfo(): Promise<unknown>;
  /** The SDK's modal (internal, guarded at every use): closed by hand (#803, #841). */
  readonly loginModal?: { closeModal?: () => void };
  /** One sign-in started without the chooser (web3auth-direct.ts); settles as connect() does. */
  connectTo?(connectorName: string, loginParams: Record<string, unknown>): Promise<KeyProvider | null>;
  /** The project's login methods as the modal holds them after init, or null. */
  loginMethods?(): Record<string, LoginMethodConfig> | null;
};

/** The email/social login's connector name (`WALLET_CONNECTORS.AUTH`). */
export const AUTH_CONNECTOR = "auth";

function isKeyProvider(p: unknown): p is KeyProvider {
  return typeof p === "object" && p !== null && typeof (p as { request?: unknown }).request === "function";
}

/** Web3Auth's email one-time-code login (`AUTH_CONNECTION.EMAIL_PASSWORDLESS`). */
export const EMAIL_PASSWORDLESS = "email_passwordless";

/**
 * The address an email sign-in is FOR, as Web3Auth's network identifies it:
 * trimmed and lower-cased.
 *
 * An iPhone, 2026-10-12, Show details: "Error occurred while verifying params
 * could not verify identity [email] [email]" - Web3Auth's documented error for a
 * user identifier that does not match the verified token's (troubleshooting/
 * jwt-errors; identifiers are case-SENSITIVE by default). The modal's email box
 * is a plain `type="text"` input with no `autocapitalize` (LoginPasswordLess.js),
 * so iOS capitalises the first letter, and its submit passes the address on as
 * typed (Login.js `handleFormSubmit`: a case-insensitive check, no lower-casing).
 * The code still arrives (mail ignores case) but the login identifier is
 * "Name@..." while the token Web3Auth issues carries the normalised address.
 * Every account that has ever signed in therefore has the normalised identifier,
 * so normalising here only lets a capitalised entry reach the SAME account.
 */
export function normalizeEmailLoginParams<T>(params: T): T {
  if (typeof params !== "object" || params === null) return params;
  const p = params as { authConnection?: unknown; loginHint?: unknown; extraLoginOptions?: unknown };
  if (p.authConnection !== EMAIL_PASSWORDLESS) return params;
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  if ("loginHint" in p) out.loginHint = norm(p.loginHint);
  const extra = p.extraLoginOptions;
  if (typeof extra === "object" && extra !== null && "login_hint" in extra) {
    out.extraLoginOptions = { ...extra, login_hint: norm((extra as { login_hint?: unknown }).login_hint) };
  }
  return out as T;
}

export function adaptWeb3AuthSdk(sdk: Web3AuthV11Like): Web3AuthInstance {
  // Every email sign-in on this instance - the modal's own button included, which
  // calls `this.connectTo(...)` - goes out with the normalised address.
  const connectTo = sdk.connectTo;
  if (typeof connectTo === "function") {
    sdk.connectTo = (connectorName, loginParams, loginMode) =>
      connectTo.call(sdk, connectorName, normalizeEmailLoginParams(loginParams), loginMode);
  }
  const keyProvider = (): KeyProvider | null => {
    const p = sdk.getConnector(AUTH_CONNECTOR)?.provider;
    return isKeyProvider(p) ? p : null;
  };
  return {
    get connected() {
      return sdk.connected;
    },
    get status() {
      return sdk.status;
    },
    get cachedConnector() {
      return sdk.cachedConnector;
    },
    get provider() {
      return keyProvider();
    },
    get loginModal() {
      return (sdk as unknown as { loginModal?: { closeModal?: () => void } }).loginModal;
    },
    init: () => sdk.init(),
    // v11 resolves with a connection (null when nothing connected); the key is the
    // auth connector's, read the same way as `provider`.
    connect: async () => ((await sdk.connect()) ? keyProvider() : null),
    // Through the normalising wrapper above. No loginMode: the SDK then labels it
    // "no-modal", which only tells its modal UI to stay out of the way (loginModal.js).
    connectTo: async (connectorName, loginParams) => ((await sdk.connectTo?.(connectorName, loginParams)) ? keyProvider() : null),
    // modalManager `filterConnectors` builds these from the dashboard's methods
    // during init(); internal, so read defensively.
    loginMethods: () =>
      (sdk as unknown as { modalConfig?: { connectors?: Record<string, { loginMethods?: Record<string, LoginMethodConfig> }> } })
        .modalConfig?.connectors?.[AUTH_CONNECTOR]?.loginMethods ?? null,
    logout: (options) => sdk.logout(options),
    getUserInfo: () => sdk.getUserInfo(),
    on: (event, fn) => void sdk.on(event, fn),
    removeListener: (event, fn) => void sdk.removeListener(event, fn),
  };
}
