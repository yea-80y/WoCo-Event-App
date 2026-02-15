import { type AuthKind, StorageKeys, type SessionDelegation } from "@woco/shared";
import { getKV, putKV, clearAll } from "./storage/indexeddb.js";
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

// ---------------------------------------------------------------------------
// State (Svelte 5 runes)
// ---------------------------------------------------------------------------

let _kind = $state<AuthKind>("none");
let _parent = $state<string | null>(null);
let _sessionAddress = $state<string | null>(null);
let _podPublicKeyHex = $state<string | null>(null);
let _ready = $state(false);
let _busy = $state(false);

// Cleanup function for wallet event listeners
let _cleanupAccountListener: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

const hasSession = $derived(_sessionAddress !== null);
const hasPodIdentity = $derived(_podPublicKeyHex !== null);
const isAuthenticated = $derived(_kind !== "none" && hasSession);

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

        // Try to restore session key
        const session = await restoreSession();
        if (session) {
          _sessionAddress = session.sessionWallet.address;
        }

        // Try to restore POD seed (may not exist yet - that's fine)
        const seed = await restorePodSeed();
        if (seed) {
          const kp = await getPodKeypair();
          _podPublicKeyHex = kp?.publicKeyHex ?? null;
        }

        // Listen for account changes
        _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
      } else {
        // Wallet disconnected or switched - clear stale session
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
// Login
// ---------------------------------------------------------------------------

async function login(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    // 1. Connect wallet
    const address = await connectWallet();
    if (!address) return false;

    // 2. Store auth kind + parent
    await putKV(StorageKeys.AUTH_KIND, "web3" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "web3";
    _parent = address;

    // 3. Request session delegation (EIP-712 popup)
    const { sessionAddress } = await requestSessionDelegation(address);
    _sessionAddress = sessionAddress;

    // 4. Check if POD seed already cached on this device
    const existingSeed = await restorePodSeed();
    if (existingSeed) {
      const kp = await getPodKeypair();
      _podPublicKeyHex = kp?.publicKeyHex ?? null;
    }
    // If no cached seed, POD identity will be requested on first use (lazy)

    // 5. Listen for account changes
    _cleanupAccountListener?.();
    _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);

    return true;
  } catch (e) {
    console.error("[auth] login failed:", e);
    // If session delegation was rejected, clean up partial state
    await clearAllAuth();
    return false;
  } finally {
    _busy = false;
  }
}

// ---------------------------------------------------------------------------
// POD identity (lazy - called on first POD action)
// ---------------------------------------------------------------------------

async function ensurePodIdentity(): Promise<string | null> {
  if (_podPublicKeyHex) return _podPublicKeyHex;
  if (_kind !== "web3" || !_parent) return null;

  _busy = true;
  try {
    const { podPublicKeyHex } = await requestPodIdentity(_parent);
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
  const result = await signWithSession(payload);
  if (!result) return null;

  const delegation = await getSessionDelegation();
  if (!delegation) return null;

  return { ...result, delegation };
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

async function logout(): Promise<void> {
  _cleanupAccountListener?.();
  _cleanupAccountListener = null;
  await clearAllAuth();
}

async function clearAllAuth(): Promise<void> {
  await clearSession();
  await clearPodIdentity();
  await clearAll();
  _kind = "none";
  _parent = null;
  _sessionAddress = null;
  _podPublicKeyHex = null;
}

// ---------------------------------------------------------------------------
// Account change handler
// ---------------------------------------------------------------------------

function handleAccountsChanged(accounts: string[]): void {
  if (accounts.length === 0 || accounts[0]?.toLowerCase() !== _parent) {
    // Wallet disconnected or switched to different account - log out
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
  get isAuthenticated() { return isAuthenticated; },

  init,
  login,
  logout,
  ensurePodIdentity,
  signRequest,
  getPodKeypair,
};
