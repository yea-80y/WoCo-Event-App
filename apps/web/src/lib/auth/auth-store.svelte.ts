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
import { createWeb3Signer, createLocalSigner } from "./signers/index.js";
import { signingRequest } from "./signing-request.svelte.js";

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

// Cleanup function for wallet event listeners
let _cleanupAccountListener: (() => void) | null = null;

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
function _getSigner(): EIP712Signer {
  if (_kind === "web3" && _parent) {
    return createWeb3Signer(_parent);
  }
  if (_kind === "local" && _localPrivateKey) {
    return createLocalSigner(_localPrivateKey, (info) =>
      signingRequest.request(info),
    );
  }
  throw new Error("No signer available for auth kind: " + _kind);
}

/**
 * Restore cached session + POD from IndexedDB (shared by all login methods).
 */
async function _restoreCachedAuth(): Promise<void> {
  const session = await restoreSession();
  if (session) {
    _sessionAddress = session.sessionWallet.address;
  }

  const seed = await restorePodSeed();
  if (seed) {
    const kp = await getPodKeypair();
    _podPublicKeyHex = kp?.publicKeyHex ?? null;
  }
}

// ---------------------------------------------------------------------------
// Initialisation (call once on app mount)
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (_ready) return;

  try {
    const kind = await getKV<AuthKind>(StorageKeys.AUTH_KIND);

    if (kind === "web3") {
      const walletAddr = await getConnectedAddress();
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);

      // Wallet still connected and matches stored parent
      if (walletAddr && storedParent && walletAddr === storedParent) {
        _kind = "web3";
        _parent = storedParent;
        await _restoreCachedAuth();
        _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
      } else {
        // Wallet disconnected or switched — clear stale session
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

    await putKV(StorageKeys.AUTH_KIND, "web3" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "web3";
    _parent = address;
    _localPrivateKey = null;

    // Restore any cached session/POD from a previous login
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
 * Dispatcher: login with specified method, or show method picker.
 */
async function login(method?: "web3" | "local"): Promise<boolean> {
  if (method === "web3") return loginWeb3();
  if (method === "local") return loginLocal();
  // No method specified — caller should show LoginModal
  return false;
}

// ---------------------------------------------------------------------------
// Deferred signing: ensureSession (lazy EIP-712 session delegation)
// ---------------------------------------------------------------------------

async function ensureSession(): Promise<boolean> {
  if (hasSession) return true;
  if (!isConnected || !_parent) return false;

  _busy = true;
  try {
    const signer = _getSigner();
    const { sessionAddress } = await requestSessionDelegation(_parent, signer);
    _sessionAddress = sessionAddress;
    return true;
  } catch (e) {
    console.error("[auth] session delegation failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

// ---------------------------------------------------------------------------
// POD identity (lazy — called on first POD action)
// ---------------------------------------------------------------------------

async function ensurePodIdentity(): Promise<string | null> {
  if (_podPublicKeyHex) return _podPublicKeyHex;
  if (!isConnected || !_parent) return null;

  _busy = true;
  try {
    const signer = _getSigner();
    const { podPublicKeyHex } = await requestPodIdentity(_parent, signer);
    _podPublicKeyHex = podPublicKeyHex;
    return podPublicKeyHex;
  } catch (e) {
    console.error("[auth] POD identity derivation failed:", e);
    return null;
  } finally {
    _busy = false;
  }
}

// ---------------------------------------------------------------------------
// API request signing
// ---------------------------------------------------------------------------

async function signRequest(
  payload: string,
): Promise<{
  signature: string;
  sessionAddress: string;
  delegation: SessionDelegation;
} | null> {
  // Lazy session establishment
  if (!hasSession) {
    const ok = await ensureSession();
    if (!ok) return null;
  }

  const result = await signWithSession(payload);
  if (!result) return null;

  const delegation = await getSessionDelegation();
  if (!delegation) return null;

  return { ...result, delegation };
}

// ---------------------------------------------------------------------------
// Logout / Forget Identity
// ---------------------------------------------------------------------------

async function logout(): Promise<void> {
  _cleanupAccountListener?.();
  _cleanupAccountListener = null;
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
  _kind = "none";
  _parent = null;
  _sessionAddress = null;
  _podPublicKeyHex = null;
  _localPrivateKey = null;
}

// ---------------------------------------------------------------------------
// Account change handler (web3 only)
// ---------------------------------------------------------------------------

function handleAccountsChanged(accounts: string[]): void {
  if (accounts.length === 0 || accounts[0]?.toLowerCase() !== _parent) {
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
  ensureSession,
  logout,
  ensurePodIdentity,
  signRequest,
  getPodKeypair,
};
