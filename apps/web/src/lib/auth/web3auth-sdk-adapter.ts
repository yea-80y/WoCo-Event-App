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
};

/** The email/social login's connector name (`WALLET_CONNECTORS.AUTH`). */
export const AUTH_CONNECTOR = "auth";

function isKeyProvider(p: unknown): p is KeyProvider {
  return typeof p === "object" && p !== null && typeof (p as { request?: unknown }).request === "function";
}

export function adaptWeb3AuthSdk(sdk: Web3AuthV11Like): Web3AuthInstance {
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
    logout: (options) => sdk.logout(options),
    getUserInfo: () => sdk.getUserInfo(),
    on: (event, fn) => void sdk.on(event, fn),
    removeListener: (event, fn) => void sdk.removeListener(event, fn),
  };
}
