import { type AuthKind, type EIP712Signer, StorageKeys, type SessionDelegation } from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import {
  requestSessionDelegation,
  restoreSession,
  signWithSession,
  getSessionDelegation,
  clearSession,
} from "./session-delegation.js";
import {
  requestPodIdentity,
  restorePodSeed,
  getPodKeypair,
  clearPodIdentity,
} from "./pod-identity.js";
import {
  connectWallet,
  getConnectedAddress,
  onAccountsChanged,
} from "../wallet/connection.js";
import {
  createLocalAccount,
  restoreLocalAccount,
  clearLocalAccount,
} from "./local-account.js";
import {
  authenticatePasskey,
  restorePasskeyAccount,
  hasStoredPasskeyCredential,
} from "./passkey-account.js";
import { createWeb3Signer, createLocalSigner, createPasskeySigner } from "./signers/index.js";
import { signingRequest } from "./signing-request.svelte.js";
import { cacheClearByPrefix, USER_SCOPED_PREFIXES } from "../cache/cache.js";

// ---------------------------------------------------------------------------
// State (Svelte 5 runes)
// ---------------------------------------------------------------------------

let _kind = $state<AuthKind>("none");
let _parent = $state<string | null>(null);
let _sessionAddress = $state<string | null>(null);
let _podPublicKeyHex = $state<string | null>(null);
let _ready = $state(false);
let _busy = $state(false);

// In-memory only — never exposed reactively
let _localPrivateKey: string | null = null;
let _passkeyPrivateKey: string | null = null;

// Cleanup function for wallet event listeners
let _cleanupAccountListener: (() => void) | null = null;

// In-flight singletons — coalesce concurrent ensureSession/ensurePodIdentity
// calls so parallel authGets after login don't each trigger their own EIP-712
// prompt. First caller signs; the rest await the same promise.
let _sessionInFlight: Promise<boolean> | null = null;
let _podInFlight: Promise<string | null> | null = null;

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

const hasSession = $derived(_sessionAddress !== null);
const hasPodIdentity = $derived(_podPublicKeyHex !== null);
const isConnected = $derived(_kind !== "none" && _parent !== null);
const isAuthenticated = $derived(isConnected && hasSession);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Get the right EIP712Signer based on the current auth kind.
 */
async function _getSigner(): Promise<EIP712Signer> {
  if (_kind === "web3" && _parent) {
    return createWeb3Signer(_parent);
  }
  if (_kind === "local" && _localPrivateKey) {
    return createLocalSigner(_localPrivateKey, (info) =>
      signingRequest.request(info),
    );
  }
  if (_kind === "passkey" && _passkeyPrivateKey) {
    return createPasskeySigner(_passkeyPrivateKey, (info) =>
      signingRequest.request(info),
    );
  }
  if (_kind === "para") {
    const { createParaSigner } = await import("./signers/para-signer.js");
    return createParaSigner((info) => signingRequest.request(info));
  }
  if (_kind === "coinbase" && _parent) {
    const { createCoinbaseSigner } = await import("./signers/coinbase-signer.js");
    return createCoinbaseSigner(_parent);
  }
  throw new Error("No signer available for auth kind: " + _kind);
}

/**
 * Restore cached session + POD from IndexedDB (shared by all login methods).
 * Passes the current `_parent` as the expected parent so a stale delegation
 * from a different identity can never be silently re-attached.
 */
async function _restoreCachedAuth(): Promise<void> {
  if (!_parent) return;
  const session = await restoreSession(_parent);
  if (session) {
    _sessionAddress = session.sessionWallet.address;
  }

  const seed = await restorePodSeed(_parent);
  if (seed) {
    const kp = await getPodKeypair(_parent);
    _podPublicKeyHex = kp?.publicKeyHex ?? null;
  }
}

/**
 * If the prior `PARENT_ADDRESS` in storage differs from `address`, wipe the
 * cached session + POD identity before adopting the new account. Without
 * this, a session delegation signed by the previous wallet would be
 * misattributed to the newly-logged-in identity (cross-identity leak).
 */
async function _clearStaleAuthForSwitch(address: string): Promise<void> {
  const priorParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
  if (priorParent && priorParent.toLowerCase() !== address.toLowerCase()) {
    await clearSession();
    await clearPodIdentity();
  }
}

/**
 * Re-derive passkey private key via biometric prompt (if not already in memory).
 */
async function _ensurePasskeyKey(): Promise<void> {
  if (_passkeyPrivateKey) return;
  const result = await restorePasskeyAccount();
  _passkeyPrivateKey = result.privateKey;
}

// ---------------------------------------------------------------------------
// Initialisation (call once on app mount)
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (_ready) return;

  try {
    const kind = await getKV<AuthKind>(StorageKeys.AUTH_KIND);

    if (kind === "web3") {
      // getConnectedAddress() can hang if window.ethereum is injected but broken
      // (e.g. MetaMask inpage.js present but extension unavailable) — cap at 3 s.
      let walletAddr = await Promise.race([
        getConnectedAddress(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);

      // No injected wallet — try to silently restore a WalletConnect session.
      // EthereumProvider.init() can hang on network requests, so cap at 3 s.
      if (!walletAddr && typeof window !== "undefined" && !window.ethereum) {
        const { tryRestoreWalletConnectSession } = await import("../wallet/wc-provider.js");
        walletAddr = await Promise.race([
          tryRestoreWalletConnectSession(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
      }

      if (walletAddr && storedParent && walletAddr === storedParent) {
        // Wallet connected and matches stored parent — full restore
        _kind = "web3";
        _parent = storedParent;
        await _restoreCachedAuth();
        _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
      } else if (walletAddr && storedParent && walletAddr !== storedParent) {
        // Wallet switched to a different account — clear stale session
        await clearAllAuth();
      } else if (!walletAddr && storedParent) {
        // Wallet not accessible: extension locked, uninstalled, or WC
        // pairing lapsed. The 30-day session key alone MUST NOT grant
        // authenticated access — a locked wallet = logged-out UX.
        // Leave encrypted session + POD seed in IndexedDB untouched so the
        // user gets back in with a single wallet unlock (no EIP-712 re-sign)
        // via loginWeb3(), which restores the cached auth if addresses match.
        _kind = "none";
        _parent = null;
        // Background retry: MetaMask can be slow to inject in a fresh tab
        // (e.g. after Stripe onboarding redirect). Try once more via
        // eth_accounts only — never prompts the user.
        setTimeout(async () => {
          if (_kind !== "none") return; // already reconnected elsewhere
          const addr = await getConnectedAddress();
          if (addr && addr.toLowerCase() === storedParent.toLowerCase()) {
            _kind = "web3";
            _parent = storedParent;
            await _restoreCachedAuth();
            _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
          }
        }, 2000);
      } else {
        await clearAllAuth();
      }
    } else if (kind === "local") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const account = await restoreLocalAccount();

      if (account && storedParent && account.address === storedParent) {
        _kind = "local";
        _parent = storedParent;
        _localPrivateKey = account.privateKey;
        await _restoreCachedAuth();
      } else {
        await clearAllAuth();
      }
    } else if (kind === "passkey") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const hasCredential = await hasStoredPasskeyCredential();

      if (hasCredential && storedParent) {
        // Set connected state — private key stays null until needed
        // (biometric prompt is deferred to ensureSession / ensurePodIdentity)
        _kind = "passkey";
        _parent = storedParent;
        await _restoreCachedAuth();
      } else {
        await clearAllAuth();
      }
    } else if (kind === "para") {
      const { restoreParaSession } = await import("./para-account.js");
      const session = await restoreParaSession();
      if (session) {
        _kind = "para";
        _parent = session.address;
        await _restoreCachedAuth();
      } else {
        await clearAllAuth();
      }
    } else if (kind === "coinbase") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const { restoreCoinbaseSession } = await import("./coinbase-account.js");
      const session = await restoreCoinbaseSession();
      if (session && storedParent && session.address === storedParent) {
        _kind = "coinbase";
        _parent = storedParent;
        await _restoreCachedAuth();
      } else {
        await clearAllAuth();
      }
    }
  } catch (e) {
    console.error("[auth] init failed:", e);
  } finally {
    _ready = true;
  }
}

// ---------------------------------------------------------------------------
// Login — method-specific (connect/create only, NO EIP-712 popups)
// ---------------------------------------------------------------------------

async function loginWeb3(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    const address = await connectWallet();
    if (!address) return false;

    await _clearStaleAuthForSwitch(address);

    await putKV(StorageKeys.AUTH_KIND, "web3" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "web3";
    _parent = address;
    _localPrivateKey = null;

    // Restore any cached session/POD from a previous login with the same
    // parent. When unlocking MetaMask after init() skipped the session-only
    // path, this is the rehydration point — no EIP-712 re-prompt needed.
    await _restoreCachedAuth();

    // Listen for account changes
    _cleanupAccountListener?.();
    _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);

    return true;
  } catch (e) {
    console.error("[auth] web3 login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

async function loginLocal(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    // Try to restore existing local account, or create a new one
    let account = await restoreLocalAccount();
    if (!account) {
      account = await createLocalAccount();
    }

    await _clearStaleAuthForSwitch(account.address);

    await putKV(StorageKeys.AUTH_KIND, "local" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, account.address);
    _kind = "local";
    _parent = account.address;
    _localPrivateKey = account.privateKey;

    // Restore any cached session/POD from a previous login
    await _restoreCachedAuth();

    // No account change listener needed for local accounts
    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] local login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Called by ParaLogin.svelte after Para authentication completes.
 * Para handles wallet creation internally; we just receive the address.
 */
async function loginPara(address: string): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    await _clearStaleAuthForSwitch(address);

    await putKV(StorageKeys.AUTH_KIND, "para" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "para";
    _parent = address;
    _localPrivateKey = null;
    _passkeyPrivateKey = null;

    await _restoreCachedAuth();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] para login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Idle-prefetch the Coinbase SDK + signer modules so the actual login click
 * doesn't burn its user-gesture token on dynamic imports. Call from
 * CoinbaseLogin button mount / hover / focus — safe to call repeatedly.
 */
let _coinbasePrefetch: Promise<void> | null = null;
function prefetchCoinbaseSdk(): Promise<void> {
  if (!_coinbasePrefetch) {
    _coinbasePrefetch = Promise.all([
      import("./coinbase-account.js"),
      import("./signers/coinbase-signer.js"),
    ]).then(() => undefined);
  }
  return _coinbasePrefetch;
}

/**
 * Open the Coinbase Smart Wallet popup, claim the connected address as the
 * parent. ERC-6492/1271 signature shape is handled transparently at verify time.
 *
 * Two-step UX is intentional. CSW (`@coinbase/wallet-sdk` v4) spawns one
 * popup per RPC call: `eth_requestAccounts` for connect, `eth_signTypedData_v4`
 * for sign. The connect popup self-closes when the user approves, and the
 * SDK's `Communicator.disconnect()` runs in response to the `PopupUnload`
 * event — rejecting any in-flight sign listener with EIP-1193 4001. So we
 * MUST NOT call signTypedData inside the same click as connect. Caller
 * (CoinbaseLogin.svelte) drives the second click for the AuthorizeSession
 * sign explicitly via `ensureSession()`.
 */
async function loginCoinbase(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    await prefetchCoinbaseSdk();
    const { connectCoinbase } = await import("./coinbase-account.js");
    const { address } = await connectCoinbase();

    await _clearStaleAuthForSwitch(address);
    await putKV(StorageKeys.AUTH_KIND, "coinbase" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "coinbase";
    _parent = address;
    _localPrivateKey = null;
    _passkeyPrivateKey = null;

    await _restoreCachedAuth();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] coinbase login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

async function loginPasskey(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    // Always use discoverable get() → shows passkey picker → falls back to create
    const account = await authenticatePasskey();

    await _clearStaleAuthForSwitch(account.address);

    await putKV(StorageKeys.AUTH_KIND, "passkey" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, account.address);
    _kind = "passkey";
    _parent = account.address;
    _passkeyPrivateKey = account.privateKey;
    _localPrivateKey = null;

    await _restoreCachedAuth();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] passkey login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Dispatcher: login with specified method, or show method picker.
 */
async function login(method?: "web3" | "local" | "passkey"): Promise<boolean> {
  if (method === "web3") return loginWeb3();
  if (method === "local") return loginLocal();
  if (method === "passkey") return loginPasskey();
  // No method specified — caller should show LoginModal
  return false;
}
// Para login is initiated from ParaLogin.svelte which calls loginPara(address) directly

// ---------------------------------------------------------------------------
// Deferred signing: ensureSession (lazy EIP-712 session delegation)
// ---------------------------------------------------------------------------

async function ensureSession(): Promise<boolean> {
  if (hasSession) return true;
  if (!isConnected || !_parent) return false;
  // Coalesce concurrent callers (e.g. CreatorHome firing /events/mine,
  // /sites/mine and /stripe/account-status in parallel) so the wallet
  // only ever sees a single AuthorizeSession prompt.
  if (_sessionInFlight) return _sessionInFlight;

  _busy = true;
  const parent = _parent;
  _sessionInFlight = (async () => {
    try {
      if (_kind === "passkey") await _ensurePasskeyKey();
      const signer = await _getSigner();
      const { sessionAddress } = await requestSessionDelegation(parent, signer);
      _sessionAddress = sessionAddress;
      return true;
    } catch (e) {
      console.error("[auth] session delegation failed:", e);
      return false;
    } finally {
      _busy = false;
      _sessionInFlight = null;
    }
  })();
  return _sessionInFlight;
}

// ---------------------------------------------------------------------------
// POD identity (lazy — called on first POD action)
// ---------------------------------------------------------------------------

async function ensurePodIdentity(): Promise<string | null> {
  if (_podPublicKeyHex) return _podPublicKeyHex;
  if (!isConnected || !_parent) return null;
  if (_podInFlight) return _podInFlight;

  _busy = true;
  const parent = _parent;
  _podInFlight = (async () => {
    try {
      if (_kind === "passkey") await _ensurePasskeyKey();
      const signer = await _getSigner();
      const { podPublicKeyHex } = await requestPodIdentity(parent, signer);
      _podPublicKeyHex = podPublicKeyHex;
      return podPublicKeyHex;
    } catch (e) {
      console.error("[auth] POD identity derivation failed:", e);
      return null;
    } finally {
      _busy = false;
      _podInFlight = null;
    }
  })();
  return _podInFlight;
}

// ---------------------------------------------------------------------------
// API request signing
// ---------------------------------------------------------------------------

/**
 * Sign an authenticated request.
 *
 * Produces an EIP-191 signature over a canonical challenge string:
 *   "woco-session-v1\n{method}\n{path}\n{timestamp}\n{nonce}\n{sha256(body)}"
 *
 * The challenge binds the signature to a specific method + path + body + time,
 * so the delegation bundle alone can't be replayed against other endpoints.
 *
 * Callers pass the raw body string (the exact bytes the fetch() body will be),
 * so there's no JSON.stringify canonicalization drift between client and server.
 */
async function signRequest(
  method: string,
  path: string,
  body: string,
): Promise<{
  signature: string;
  nonce: string;
  timestamp: string;
  sessionAddress: string;
  delegation: SessionDelegation;
} | null> {
  // Lazy session establishment
  if (!hasSession) {
    const ok = await ensureSession();
    if (!ok) return null;
  }
  if (!_parent) return null;

  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const bodyHash = await sha256Hex(body);
  const challenge = [
    "woco-session-v1",
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");

  // `hasSession` can be true (derived from in-memory _sessionAddress) while the
  // underlying IndexedDB blob is gone (expired, host changed, parent-mismatch,
  // or storage was cleared). `signWithSession` silently returns null in that
  // case, which the caller would see as a missing auth header. Detect and
  // re-establish — and bind to the active `_parent` so a stale delegation
  // belonging to a previous identity can never be sent.
  let result = await signWithSession(challenge, _parent);
  if (!result) {
    _sessionAddress = null;
    const ok = await ensureSession();
    if (!ok) return null;
    result = await signWithSession(challenge, _parent);
    if (!result) return null;
  }

  const delegation = await getSessionDelegation(_parent);
  if (!delegation) return null;

  return {
    signature: result.signature,
    sessionAddress: result.sessionAddress,
    nonce,
    timestamp,
    delegation,
  };
}

/** SHA-256 hex of a UTF-8 string (for request body binding). */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

// ---------------------------------------------------------------------------
// Logout / Forget Identity
// ---------------------------------------------------------------------------

async function logout(): Promise<void> {
  _cleanupAccountListener?.();
  _cleanupAccountListener = null;
  // Disconnect WalletConnect if it was used (no injected wallet present)
  if (_kind === "web3" && typeof window !== "undefined" && !window.ethereum) {
    const { disconnectWalletConnect } = await import("../wallet/wc-provider.js");
    await disconnectWalletConnect();
  }
  if (_kind === "para") {
    const { logoutPara } = await import("./para-account.js");
    await logoutPara();
  }
  if (_kind === "coinbase") {
    const { logoutCoinbase } = await import("./coinbase-account.js");
    await logoutCoinbase();
  }
  await clearAllAuth();
}

async function clearAllAuth(): Promise<void> {
  await clearSession();
  await clearPodIdentity();
  // NOTE: we intentionally do NOT clear the local account private key.
  // This lets the user re-login with the same local account later.
  // The key stays in IndexedDB; only the session state is wiped.
  await delKV(StorageKeys.AUTH_KIND);
  await delKV(StorageKeys.PARENT_ADDRESS);
  // Shared-device safety: drop all user-scoped caches (creator lists, orders, collection, claim status).
  cacheClearByPrefix(USER_SCOPED_PREFIXES);
  _kind = "none";
  _parent = null;
  _sessionAddress = null;
  _podPublicKeyHex = null;
  _localPrivateKey = null;
  _passkeyPrivateKey = null;
  _sessionInFlight = null;
  _podInFlight = null;
}

// ---------------------------------------------------------------------------
// Account change handler (web3 only)
// ---------------------------------------------------------------------------

// WalletConnect emits accountsChanged([]) transiently during chain switches.
// Debounce empty-accounts to avoid logging out mid-chain-switch.
let _emptyAccountsTimer: ReturnType<typeof setTimeout> | null = null;

function handleAccountsChanged(accounts: string[]): void {
  if (_emptyAccountsTimer) {
    clearTimeout(_emptyAccountsTimer);
    _emptyAccountsTimer = null;
  }
  if (accounts.length === 0) {
    // Delay logout — WalletConnect emits empty accounts transiently during chain switching.
    // If accounts repopulate within 3s (chain switch), the logout is cancelled.
    _emptyAccountsTimer = setTimeout(() => {
      _emptyAccountsTimer = null;
      logout();
    }, 3000);
  } else if (accounts[0]?.toLowerCase() !== _parent) {
    logout();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const auth = {
  get kind() { return _kind; },
  get parent() { return _parent; },
  get sessionAddress() { return _sessionAddress; },
  get podPublicKeyHex() { return _podPublicKeyHex; },
  get ready() { return _ready; },
  get busy() { return _busy; },
  get hasSession() { return hasSession; },
  get hasPodIdentity() { return hasPodIdentity; },
  get isConnected() { return isConnected; },
  get isAuthenticated() { return isAuthenticated; },

  init,
  login,
  loginWeb3,
  loginLocal,
  loginPasskey,
  loginPara,
  loginCoinbase,
  prefetchCoinbaseSdk,
  ensureSession,
  logout,
  ensurePodIdentity,
  signRequest,
  // Bind to the active parent so callers don't need to pass it (and can't
  // pass the wrong one). Returns null when not logged in.
  getPodKeypair: () => (_parent ? getPodKeypair(_parent) : Promise.resolve(null)),
};
