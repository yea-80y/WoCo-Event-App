/// <reference path="./webauthn-prf.d.ts" />

import { keccak256 } from "ethers";
import { Wallet } from "ethers";
import { StorageKeys, PASSKEY_PRF_SALT_INPUT } from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/** Credential metadata stored in IndexedDB (not secret) */
interface PasskeyCredentialMeta {
  credentialId: string; // base64url-encoded
  rpId: string;
}

/**
 * Get the RP ID for passkey operations.
 * Uses woco.eth.limo in production so all ENS subdomains share the same
 * passkey identity. Falls back to window.location.hostname for localhost dev.
 */
const PRODUCTION_RP_ID = "woco.eth.limo";

function getPasskeyRpId(): string {
  const hostname = window.location.hostname;
  // On any woco.eth.limo subdomain (or itself), use the shared RP ID
  if (hostname === PRODUCTION_RP_ID || hostname.endsWith(`.${PRODUCTION_RP_ID}`)) {
    return PRODUCTION_RP_ID;
  }
  // Dev / other environments: use hostname directly
  return hostname;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the PRF salt: SHA-256 of the fixed salt input string. */
async function getPrfSalt(): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(PASSKEY_PRF_SALT_INPUT));
  return new Uint8Array(hash);
}

/** Base64url encode a Uint8Array / ArrayBuffer. */
function toBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string to a Uint8Array. */
function fromBase64url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive a secp256k1 private key + Ethereum address from the PRF output. */
function deriveKey(prfOutput: ArrayBuffer): { address: string; privateKey: string } {
  const prfBytes = new Uint8Array(prfOutput);
  const privateKey = keccak256(prfBytes);
  const wallet = new Wallet(privateKey);
  return { address: wallet.address.toLowerCase(), privateKey };
}

/** Extract PRF result from a WebAuthn credential response. */
function extractPrfResult(
  extensions: AuthenticationExtensionsClientOutputs,
): ArrayBuffer {
  const prf = extensions.prf;
  if (!prf?.results?.first) {
    throw new Error("PRF extension did not return a result. Your browser or passkey may not support PRF.");
  }
  return prf.results.first;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** Check if this browser supports WebAuthn passkeys. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

// ---------------------------------------------------------------------------
// Authenticate (discoverable get → fall back to create)
// ---------------------------------------------------------------------------

/**
 * Authenticate with an existing passkey using discoverable credentials.
 * Always shows the passkey picker so the user can choose which one.
 * Falls back to creating a new passkey if none exist for this RP.
 *
 * This is the primary entry point — avoids relying on IDB for credential
 * tracking, so it works even if IDB is cleared.
 */
export async function authenticatePasskey(): Promise<{
  address: string;
  privateKey: string;
}> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  // Try discoverable get() first — shows passkey picker, no allowCredentials
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        // No allowCredentials = discoverable mode → user picks from all passkeys for this RP
        userVerification: "required",
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })) as PublicKeyCredential | null;

    if (credential) {
      const prfOutput = extractPrfResult(credential.getClientExtensionResults());

      // Update stored credential metadata so init() can restore kind on reload
      const meta: PasskeyCredentialMeta = {
        credentialId: toBase64url(credential.rawId),
        rpId,
      };
      await putKV(StorageKeys.PASSKEY_CREDENTIAL, meta);

      return deriveKey(prfOutput);
    }
    // credential is null — user cancelled, throw so caller handles it
    throw new Error("Passkey authentication was cancelled.");
  } catch (e) {
    // If the error is "no credentials available" (NotAllowedError with no passkeys),
    // fall through to create. Otherwise re-throw (user cancelled, PRF unsupported, etc).
    const isNoCredentials =
      e instanceof DOMException && e.name === "NotAllowedError";

    if (!isNoCredentials) {
      throw e;
    }
  }

  // No discoverable credentials found for this RP — create a new passkey
  return createPasskeyAccount();
}

// ---------------------------------------------------------------------------
// Create (only called when no existing passkey for this RP)
// ---------------------------------------------------------------------------

/**
 * Create a new passkey and derive a secp256k1 key via PRF.
 * Stores credential metadata (ID + rpId) in IndexedDB.
 */
export async function createPasskeyAccount(): Promise<{
  address: string;
  privateKey: string;
}> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "WoCo", id: rpId },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "WoCo Account",
        displayName: "WoCo Account",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },   // ES256
        { alg: -257, type: "public-key" },  // RS256
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: {
        prf: { eval: { first: salt } },
      },
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey creation was cancelled.");
  }

  const extensions = credential.getClientExtensionResults();

  // Some browsers return PRF.enabled on creation but not the actual result.
  // In that case, we need to do a get() call to obtain the PRF output.
  let prfOutput: ArrayBuffer;
  if (extensions.prf?.results?.first) {
    prfOutput = extensions.prf.results.first;
  } else if (extensions.prf?.enabled) {
    // PRF supported but result not returned during creation — authenticate to get it
    const credentialId = new Uint8Array(credential.rawId);
    const getResult = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ id: credentialId, type: "public-key" }],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })) as PublicKeyCredential | null;

    if (!getResult) {
      throw new Error("Passkey authentication was cancelled.");
    }
    prfOutput = extractPrfResult(getResult.getClientExtensionResults());
  } else {
    throw new Error(
      "Your passkey does not support the PRF extension. " +
      "Try a different authenticator (e.g. iCloud Keychain, Google Password Manager, or 1Password).",
    );
  }

  // Store credential metadata for later restore
  const meta: PasskeyCredentialMeta = {
    credentialId: toBase64url(credential.rawId),
    rpId,
  };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, meta);

  return deriveKey(prfOutput);
}

// ---------------------------------------------------------------------------
// Restore (used by init() to re-derive key silently when session exists)
// ---------------------------------------------------------------------------

/**
 * Authenticate with a stored passkey credential (pinned by ID).
 * Used for silent re-derivation on page reload when we know which credential to use.
 * Falls back to discoverable mode if stored credential is gone.
 */
export async function restorePasskeyAccount(): Promise<{
  address: string;
  privateKey: string;
}> {
  const meta = await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL);
  if (!meta) {
    // IDB cleared — fall back to discoverable picker
    return authenticatePasskey();
  }

  const salt = await getPrfSalt();
  const credentialId = fromBase64url(meta.credentialId);

  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: meta.rpId,
        allowCredentials: [{ id: credentialId, type: "public-key" }],
        userVerification: "required",
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new Error("Passkey authentication was cancelled.");
    }

    const prfOutput = extractPrfResult(credential.getClientExtensionResults());
    return deriveKey(prfOutput);
  } catch (e) {
    // If the stored credential no longer exists, fall back to discoverable
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      await delKV(StorageKeys.PASSKEY_CREDENTIAL);
      return authenticatePasskey();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Check if there's a stored passkey credential (for UI: "Create" vs "Sign in"). */
export async function hasStoredPasskeyCredential(): Promise<boolean> {
  const meta = await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL);
  return meta !== null;
}

/** Remove stored passkey credential metadata from IndexedDB. */
export async function clearPasskeyCredential(): Promise<void> {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
}
