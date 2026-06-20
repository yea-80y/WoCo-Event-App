/**
 * Web3Auth PnP primary-login helpers — the replacement for para-account.ts.
 * Web3Auth reconstructs a standard secp256k1 key client-side (device + network
 * shares) and exposes it via `eth_private_key`. We hold it in memory for the
 * session; Web3Auth's own localStorage keeps the session alive across page loads.
 *
 * A module-level singleton is kept so `restoreWeb3AuthSession` (called during
 * init) reuses the already-initialised instance without a second network round.
 */

type MinimalProvider = { request: (args: { method: string }) => Promise<unknown> };

let _instance: { connected: boolean; provider: MinimalProvider | null; init(): Promise<void>; connect(): Promise<MinimalProvider | null>; logout(): Promise<void> } | null = null;

async function _getInstance() {
  const clientId = import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined;
  if (!clientId) return null;

  if (_instance) return _instance;

  const { Web3Auth, WEB3AUTH_NETWORK } = await import("@web3auth/modal");
  const networkEnv = (import.meta.env.VITE_WEB3AUTH_NETWORK as string | undefined) ?? "sapphire_devnet";
  const web3AuthNetwork =
    networkEnv === "sapphire_mainnet" ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;

  const w = new Web3Auth({ clientId, web3AuthNetwork, multiInjectedProviderDiscovery: false });
  await w.init();
  _instance = w as typeof _instance;
  return _instance;
}

async function _extractKeyAndAddress(provider: MinimalProvider): Promise<{ address: string; privateKey: `0x${string}` }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const raw = (await provider.request({ method: "eth_private_key" })) as string | undefined;
  if (!raw) throw new Error("Couldn't read the Web3Auth wallet key — try again.");
  const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  return { address: account.address.toLowerCase(), privateKey: pk };
}

/**
 * Open the Web3Auth PnP modal (email / social). Returns the address and raw
 * private key on success. Does NOT log out — the session stays active for
 * `restoreWeb3AuthSession` to pick up on the next page load.
 */
export async function loginWithWeb3Auth(): Promise<{ address: string; privateKey: `0x${string}` }> {
  const w = await _getInstance();
  if (!w) throw new Error("Email login isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).");

  const provider = w.connected ? w.provider : await w.connect();
  if (!provider) throw new Error("Email sign-in was cancelled.");
  return _extractKeyAndAddress(provider);
}

/**
 * Silent restore — returns the key if Web3Auth's stored session is still active,
 * null if expired / not configured. Called during auth init(); never shows UI.
 */
export async function restoreWeb3AuthSession(): Promise<{ address: string; privateKey: `0x${string}` } | null> {
  try {
    const w = await _getInstance();
    if (!w || !w.connected || !w.provider) return null;
    return await _extractKeyAndAddress(w.provider);
  } catch {
    return null;
  }
}

/** Best-effort logout — clears Web3Auth's stored session. */
export async function logoutWeb3Auth(): Promise<void> {
  try {
    if (_instance?.connected) await _instance.logout();
  } catch {
    // best effort
  } finally {
    _instance = null;
  }
}
