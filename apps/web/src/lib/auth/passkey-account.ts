/// <reference path="./webauthn-prf.d.ts" />

import { StorageKeys, PASSKEY_PRF_SALT_INPUT, resolvePasskeyRpId } from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/** Credential metadata stored in IndexedDB (not secret) */
interface PasskeyCredentialMeta {
  credentialId: string; // base64url-encoded
  rpId: string;
}

// RP-ID policy lives in @woco/shared (resolvePasskeyRpId) — identity-critical,
// and the embed resolves it too, so a local copy is how #175 shipped.
function getPasskeyRpId(): string {
  return resolvePasskeyRpId(window.location.hostname);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the PRF salt: SHA-256 of the fixed salt input string. */
async function getPrfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(PASSKEY_PRF_SALT_INPUT));
  return new Uint8Array(hash);
}

/**
 * Coerce a WebAuthn `BufferSource` to a plain `ArrayBuffer`. TS 5.7's lib.dom
 * widened the PRF result types to `BufferSource`; deriveKey() needs an
 * `ArrayBuffer`, so normalise (copying out of any view).
 */
function toArrayBuffer(src: BufferSource): ArrayBuffer {
  if (src instanceof ArrayBuffer) return src;
  return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
}

/** Base64url encode a Uint8Array / ArrayBuffer. */
function toBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string to a Uint8Array. */
function fromBase64url(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive a secp256k1 private key + Ethereum address from the PRF output.
 *  ethers is imported lazily — this module is in the login modal's boot graph. */
async function deriveKey(prfOutput: ArrayBuffer): Promise<{ address: string; privateKey: `0x${string}` }> {
  const { keccak256, Wallet } = await import("ethers");
  const prfBytes = new Uint8Array(prfOutput);
  const privateKey = keccak256(prfBytes) as `0x${string}`;
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
  return toArrayBuffer(prf.results.first);
}

// ---------------------------------------------------------------------------
// Ceremony lock
// ---------------------------------------------------------------------------

/**
 * WebAuthn allows only ONE outstanding ceremony per page: a second
 * `navigator.credentials.get/create` while one is pending makes the browser
 * reject a request with `NotAllowedError` — indistinguishable from a user
 * cancel. That used to cascade: `restorePasskeyAccount` read the rejection as
 * "credential gone", wiped its metadata and fell through to a path that could
 * MINT A NEW ACCOUNT. Two callers really can race (`_getSigner` and
 * `_getPodSigner` both await `_ensurePasskeyKey`), and mobile's slower
 * biometric sheet holds the window open for far longer.
 *
 * Every exported ceremony therefore runs through this serial queue. The
 * `_impl` split below is not stylistic: taking the lock inside a function that
 * another locked function calls would self-deadlock, so the lock is held ONLY
 * at the exported boundary and internals stay lock-free.
 */
let _ceremonyQueue: Promise<unknown> = Promise.resolve();

function withCeremonyLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on settle, not on success — one failed ceremony must not wedge the queue.
  const run = _ceremonyQueue.then(fn, fn);
  _ceremonyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A sign-in ceremony produced no assertion. WebAuthn deliberately collapses
 * "user cancelled", "ceremony timed out", "another request was pending" and
 * "no credential exists for this RP" into one opaque `NotAllowedError` so a
 * site cannot probe for credentials. We therefore CANNOT tell them apart —
 * which is exactly why this must never auto-create an account. The caller
 * surfaces it and lets the user decide.
 */
export class PasskeyAssertionUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(
      "No passkey was used. You may have cancelled, or there may be no WoCo passkey on this device.",
    );
    this.name = "PasskeyAssertionUnavailableError";
    this.cause = cause;
  }
}

/**
 * A ceremony was cancelled or refused by the platform. Browsers reject a
 * cancelled `credentials.create()` with `NotAllowedError` (they do NOT resolve
 * null), and Chrome's message is raw spec prose ending in a w3.org URL — which
 * the login modal renders verbatim. Wrap it so a plain cancel reads as one.
 */
export class PasskeyCeremonyCancelledError extends Error {
  readonly cause?: unknown;
  constructor(action: "creation" | "authentication", cause?: unknown) {
    super(`Passkey ${action} was cancelled or not permitted by your device.`);
    this.name = "PasskeyCeremonyCancelledError";
    this.cause = cause;
  }
}

/**
 * Run a ceremony under the lock, translating a raw NotAllowedError into readable
 * copy. Applied at the exported boundary so it covers BOTH the outer ceremony
 * and any inner one (the create paths do a second get() when the authenticator
 * returns `prf.enabled` without a result) without restructuring either.
 * Non-NotAllowedError faults — unsupported PRF, RP-ID SecurityError — pass
 * through untouched; they are actionable and must stay legible.
 */
function ceremony<T>(action: "creation" | "authentication", fn: () => Promise<T>): Promise<T> {
  return withCeremonyLock(() =>
    fn().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        throw new PasskeyCeremonyCancelledError(action, e);
      }
      throw e;
    }),
  );
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
 * Sign in with an EXISTING passkey using discoverable credentials. Always shows
 * the passkey picker so the user can choose which one; does not rely on IDB, so
 * it works on a fresh device or after IDB is cleared.
 *
 * NEVER creates. An assertion failure raises PasskeyAssertionUnavailableError
 * and the caller must ask the user before minting anything — see that class for
 * why the browser cannot tell us "no credential" apart from "cancelled". The
 * previous behaviour (fall through to create on NotAllowedError) turned every
 * cancelled, timed-out or concurrently-rejected ceremony into a brand-new
 * account at a brand-new address, silently forking the user's identity.
 */
export async function authenticatePasskey(): Promise<{
  address: string;
  privateKey: string;
}> {
  return withCeremonyLock(_authenticatePasskeyImpl);
}

async function _authenticatePasskeyImpl(): Promise<{
  address: string;
  privateKey: string;
}> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  let credential: PublicKeyCredential | null;
  try {
    // Discoverable mode (no allowCredentials) → user picks from all passkeys for this RP
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        userVerification: "required",
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    // NotAllowedError is the opaque catch-all; anything else (PRF unsupported,
    // SecurityError from an RP-ID mismatch) is a real, actionable fault.
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      throw new PasskeyAssertionUnavailableError(e);
    }
    throw e;
  }

  if (!credential) throw new PasskeyAssertionUnavailableError();

  const prfOutput = extractPrfResult(credential.getClientExtensionResults());

  // Update stored credential metadata so init() can restore kind on reload
  const meta: PasskeyCredentialMeta = {
    credentialId: toBase64url(credential.rawId),
    rpId,
  };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, meta);

  return deriveKey(prfOutput);
}

// ---------------------------------------------------------------------------
// Create (only called when no existing passkey for this RP)
// ---------------------------------------------------------------------------

/**
 * Create a new passkey and derive a secp256k1 key via PRF.
 * Stores credential metadata (ID + rpId) in IndexedDB.
 *
 * ONLY call this behind an explicit user decision to create a NEW account. It
 * is never reached by a failed sign-in: minting here forks identity (new PRF-EOA
 * → new Kernel → new address), stranding the user's tickets, feeds and funds on
 * the account they meant to sign in to.
 */
export async function createPasskeyAccount(): Promise<{
  address: string;
  privateKey: `0x${string}`;
}> {
  return ceremony("creation", _createPasskeyAccountImpl);
}

async function _createPasskeyAccountImpl(): Promise<{
  address: string;
  privateKey: `0x${string}`;
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
    prfOutput = toArrayBuffer(extensions.prf.results.first);
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
// Backup passkey (account-recovery guardian)
// ---------------------------------------------------------------------------

/**
 * Derive a secp256k1 key from a DEDICATED backup passkey, for use as a recovery
 * guardian. Two hard differences from the primary-login helpers above:
 *   1. NEVER writes StorageKeys.PASSKEY_CREDENTIAL. That slot belongs to the
 *      primary login; clobbering it would break the logged-in session's silent
 *      restore on reload. The backup credential is located at recovery via a
 *      discoverable picker, so it needs no local metadata.
 *   2. Labels the credential "WoCo Backup" so the user can tell it apart from
 *      their login passkey in the authenticator picker during recovery.
 *
 * The key is keccak256(PRF(fixed-salt)) — identical construction to the primary,
 * so getPasskeyBackupKey() re-derives the SAME key at recovery from the SAME
 * credential. A wrong pick fails SAFE: the derived guardian address won't match
 * the escrow, so recovery is refused rather than mis-applied. Independence from
 * the primary is guaranteed by the caller's own-key block (the derived address
 * can never equal auth.parent / auth.podAddress).
 */
export async function createPasskeyBackupKey(): Promise<{ address: string; privateKey: string }> {
  return ceremony("creation", _createPasskeyBackupKeyImpl);
}

async function _createPasskeyBackupKeyImpl(): Promise<{ address: string; privateKey: string }> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "WoCo", id: rpId },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "WoCo Backup",
        displayName: "WoCo Backup",
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

  // Some browsers return PRF.enabled on creation but not the actual result; in
  // that case authenticate once to obtain the PRF output (same as the primary).
  let prfOutput: ArrayBuffer;
  if (extensions.prf?.results?.first) {
    prfOutput = toArrayBuffer(extensions.prf.results.first);
  } else if (extensions.prf?.enabled) {
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
      "Try a device with iCloud Keychain, Google Password Manager, or 1Password.",
    );
  }

  return deriveKey(prfOutput);
}

/**
 * Re-derive the backup passkey key at RECOVERY time. Discoverable get() shows the
 * authenticator picker so the user selects their "WoCo Backup" passkey; we never
 * touch StorageKeys.PASSKEY_CREDENTIAL — the recovering device may already hold a
 * different primary credential we must not disturb.
 */
export async function getPasskeyBackupKey(): Promise<{ address: string; privateKey: string }> {
  return ceremony("authentication", _getPasskeyBackupKeyImpl);
}

async function _getPasskeyBackupKeyImpl(): Promise<{ address: string; privateKey: string }> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
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
  return withCeremonyLock(_restorePasskeyAccountImpl);
}

async function _restorePasskeyAccountImpl(): Promise<{
  address: string;
  privateKey: string;
}> {
  const meta = await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL);
  if (!meta) {
    // IDB cleared — fall back to the discoverable picker (sign-in only, never creates)
    return _authenticatePasskeyImpl();
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

    if (!credential) throw new PasskeyAssertionUnavailableError();

    const prfOutput = extractPrfResult(credential.getClientExtensionResults());
    return deriveKey(prfOutput);
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      // Ambiguous: the credential may be gone, or the user just cancelled. Do
      // NOT delete the metadata on a guess — a cancel would permanently demote
      // this device to the discoverable path. The discoverable retry below
      // rewrites the metadata itself once a real assertion succeeds, so a
      // genuinely-stale entry is corrected by success rather than by deletion.
      return _authenticatePasskeyImpl();
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
