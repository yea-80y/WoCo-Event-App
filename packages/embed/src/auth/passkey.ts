/// <reference path="./webauthn-prf.d.ts" />

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { PASSKEY_PRF_SALT_INPUT } from "@woco/shared";

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `Uint8Array<ArrayBuffer>`, not bare `Uint8Array`: WebAuthn's `BufferSource`
 *  excludes SharedArrayBuffer-backed views, and `subtle.digest` always returns a
 *  plain ArrayBuffer — so this is a tightening, not a cast. Mirrors the web app. */
async function getPrfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(PASSKEY_PRF_SALT_INPUT));
  return new Uint8Array(hash);
}

function toBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractPrfResult(extensions: AuthenticationExtensionsClientOutputs): ArrayBuffer {
  const prf = extensions.prf;
  if (!prf?.results?.first) {
    throw new Error("PRF extension did not return a result. Your browser or passkey may not support PRF.");
  }
  return prf.results.first;
}

// ---------------------------------------------------------------------------
// Key derivation (noble — no ethers)
// ---------------------------------------------------------------------------

function deriveKey(prfOutput: ArrayBuffer): { privateKey: Uint8Array; address: string } {
  const prfBytes = new Uint8Array(prfOutput);
  const privateKey = keccak_256(prfBytes);
  const address = getAddress(privateKey);
  return { privateKey, address };
}

/** Derive Ethereum address from a secp256k1 private key. */
export function getAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false); // uncompressed (65 bytes)
  const pubKeyHash = keccak_256(pubKey.slice(1)); // drop 0x04 prefix, hash 64 bytes
  const addrBytes = pubKeyHash.slice(12); // last 20 bytes
  return "0x" + toHex(addrBytes);
}

// ---------------------------------------------------------------------------
// Credential storage (localStorage — no IndexedDB dependency)
// ---------------------------------------------------------------------------

const CRED_KEY = "woco:embed:passkey-credential";

/**
 * Get the RP ID for passkey operations.
 * Uses woco.eth.limo in production so all ENS subdomains share the same
 * passkey identity. Falls back to window.location.hostname for other environments.
 */
const PRODUCTION_RP_ID = "woco.eth.limo";

function getPasskeyRpId(): string {
  const hostname = window.location.hostname;
  if (hostname === PRODUCTION_RP_ID || hostname.endsWith(`.${PRODUCTION_RP_ID}`)) {
    return PRODUCTION_RP_ID;
  }
  return hostname;
}

interface CredentialMeta {
  credentialId: string;
  rpId: string;
}

// ---------------------------------------------------------------------------
// Ceremony lock + errors
// ---------------------------------------------------------------------------

/**
 * WebAuthn permits ONE outstanding ceremony per page. `claiming` is per-series
 * state, so two ticket series on the same embed can each start a claim and race
 * — the browser rejects the second with an opaque NotAllowedError. Serialise
 * every ceremony so a race can never be mistaken for "no credential".
 *
 * The `_impl` split keeps the lock at the exported boundary only; taking it
 * inside a function another locked function calls would self-deadlock.
 */
let _ceremonyQueue: Promise<unknown> = Promise.resolve();

function withCeremonyLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on settle — a failed ceremony must not wedge the queue.
  const run = _ceremonyQueue.then(fn, fn);
  _ceremonyQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * No assertion came back. WebAuthn deliberately returns the same opaque
 * NotAllowedError for "user cancelled", "timed out", "another request was
 * pending" and "no credential exists" — so we cannot tell them apart, and must
 * never resolve the ambiguity by creating an account. A passkey IS the account
 * here (keccak256(PRF) is the claimer's key), so a wrong guess mints a new
 * identity and strands the claimer's existing tickets.
 */
export class PasskeyAssertionUnavailableError extends Error {
  constructor() {
    super("No WoCo passkey was used on this device.");
    this.name = "PasskeyAssertionUnavailableError";
  }
}

/** A ceremony was cancelled or refused — wrapped so the raw spec prose (Chrome
 *  appends a w3.org URL) never reaches the claimer. */
export class PasskeyCeremonyCancelledError extends Error {
  constructor(action: "creation" | "authentication") {
    super(`Passkey ${action} was cancelled or not permitted by your device.`);
    this.name = "PasskeyCeremonyCancelledError";
  }
}

function loadCredential(): CredentialMeta | null {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCredential(meta: CredentialMeta): void {
  localStorage.setItem(CRED_KEY, JSON.stringify(meta));
}

// ---------------------------------------------------------------------------
// Authenticate (create-or-get)
// ---------------------------------------------------------------------------

/**
 * Sign in with an EXISTING passkey. NEVER creates.
 *
 * Previously this created a new passkey whenever localStorage held no metadata
 * — so a returning claimer in a fresh browser, or after clearing site data, was
 * silently given a brand-new account and lost sight of their tickets. Passkeys
 * sync (iCloud Keychain, Google Password Manager), so an empty localStorage
 * says nothing about whether the claimer has a WoCo passkey. The discoverable
 * picker asks the authenticator, which actually knows.
 *
 * Order: pinned get() when we hold metadata (no picker, fastest), else — or on
 * an ambiguous failure — a discoverable get(). Only an explicit user decision
 * reaches passkeyCreateAccount().
 */
export async function passkeySignIn(): Promise<{ privateKey: Uint8Array; address: string }> {
  return withCeremonyLock(_passkeySignInImpl);
}

async function _passkeySignInImpl(): Promise<{ privateKey: Uint8Array; address: string }> {
  const existing = loadCredential();
  if (existing) {
    try {
      return await restorePasskey(existing);
    } catch (e) {
      // Ambiguous — the pinned credential may be gone, or the user may have
      // cancelled. Do NOT delete the metadata on a guess: a cancel would
      // permanently demote this browser to the picker. A successful discoverable
      // retry rewrites it instead, so a genuinely stale pin heals on success.
      // Anything else (unsupported PRF, RP-ID SecurityError) is a real fault.
      const ambiguous =
        (e instanceof DOMException && e.name === "NotAllowedError") ||
        e instanceof PasskeyAssertionUnavailableError;
      if (!ambiguous) throw e;
    }
  }
  return discoverPasskey();
}

/** Discoverable get() — the authenticator offers every WoCo passkey it holds. */
async function discoverPasskey(): Promise<{ privateKey: Uint8Array; address: string }> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        // No allowCredentials → discoverable mode
        userVerification: "required",
        extensions: { prf: { eval: { first: salt } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      throw new PasskeyAssertionUnavailableError();
    }
    throw e;
  }

  if (!credential) throw new PasskeyAssertionUnavailableError();

  const prfOutput = extractPrfResult(credential.getClientExtensionResults());
  saveCredential({ credentialId: toBase64url(credential.rawId), rpId });
  return deriveKey(prfOutput);
}

/**
 * Create a NEW passkey account. Only ever call this behind an explicit user
 * choice — it mints a new identity, it does not recover an existing one.
 */
export async function passkeyCreateAccount(): Promise<{ privateKey: Uint8Array; address: string }> {
  return withCeremonyLock(() =>
    createPasskey().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        throw new PasskeyCeremonyCancelledError("creation");
      }
      throw e;
    }),
  );
}

async function createPasskey(): Promise<{ privateKey: Uint8Array; address: string }> {
  const salt = await getPrfSalt();
  const rpId = getPasskeyRpId();

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "WoCo Tickets", id: rpId },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "WoCo Ticket Holder",
        displayName: "WoCo Ticket Holder",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" },
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

  let prfOutput: ArrayBuffer;
  if (extensions.prf?.results?.first) {
    prfOutput = extensions.prf.results.first;
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

    if (!getResult) throw new Error("Passkey authentication was cancelled.");
    prfOutput = extractPrfResult(getResult.getClientExtensionResults());
  } else {
    throw new Error(
      "Your passkey does not support the PRF extension. " +
      "Try a different authenticator (e.g. iCloud Keychain, Google Password Manager, or 1Password).",
    );
  }

  saveCredential({ credentialId: toBase64url(credential.rawId), rpId });
  return deriveKey(prfOutput);
}

async function restorePasskey(meta: CredentialMeta): Promise<{ privateKey: Uint8Array; address: string }> {
  const salt = await getPrfSalt();
  const credentialId = fromBase64url(meta.credentialId);

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

  // Same ambiguity class as NotAllowedError, so raise the same type — otherwise
  // this path would skip the discoverable fallback in _passkeySignInImpl.
  if (!credential) throw new PasskeyAssertionUnavailableError();

  const prfOutput = extractPrfResult(credential.getClientExtensionResults());
  return deriveKey(prfOutput);
}

// ---------------------------------------------------------------------------
// EIP-712 signing (noble secp256k1 — no ethers)
// ---------------------------------------------------------------------------

/**
 * Sign a pre-computed EIP-712 digest with a raw secp256k1 private key.
 * Returns the 65-byte r/s/v hex signature matching what ethers
 * `verifyTypedData` expects.
 *
 * The caller must pass the digest produced by `eip712Digest(...)` — this
 * function does NOT apply any additional hashing or EIP-191 prefix.
 */
export function signClaimDigest(privateKey: Uint8Array, digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error("eip712 digest must be 32 bytes");

  const sig = secp256k1.sign(digest, privateKey);

  // Encode as 65-byte signature: r (32) + s (32) + v (1)
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");

  return "0x" + r + s + v;
}
