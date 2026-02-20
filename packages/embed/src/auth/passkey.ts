/// <reference path="./webauthn-prf.d.ts" />

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
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

async function getPrfSalt(): Promise<Uint8Array> {
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

export async function passkeyAuthenticate(): Promise<{ privateKey: Uint8Array; address: string }> {
  const existing = loadCredential();
  if (existing) {
    return restorePasskey(existing);
  }
  return createPasskey();
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

  if (!credential) {
    throw new Error("Passkey authentication was cancelled.");
  }

  const prfOutput = extractPrfResult(credential.getClientExtensionResults());
  return deriveKey(prfOutput);
}

// ---------------------------------------------------------------------------
// EIP-191 signing (noble secp256k1 — no ethers)
// ---------------------------------------------------------------------------

/**
 * Sign a message using EIP-191 personal_sign format.
 * Returns hex signature with recovery byte (v = 27 or 28).
 */
export function signClaimMessage(privateKey: Uint8Array, message: string): string {
  const enc = new TextEncoder();
  const msgBytes = enc.encode(message);

  // EIP-191: "\x19Ethereum Signed Message:\n" + len + message
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);

  const hash = keccak_256(prefixed);
  const sig = secp256k1.sign(hash, privateKey);

  // Encode as 65-byte signature: r (32) + s (32) + v (1)
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");

  return "0x" + r + s + v;
}
