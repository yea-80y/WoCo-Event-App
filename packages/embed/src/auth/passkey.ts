/// <reference path="./webauthn-prf.d.ts" />

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { PASSKEY_PRF_SALT_INPUT, resolvePasskeyRpId } from "@woco/shared";

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

/** `Uint8Array<ArrayBuffer>`, not bare `Uint8Array`: WebAuthn's `BufferSource`
 *  excludes SharedArrayBuffer-backed views, and this always allocates a plain
 *  one — so this is a tightening, not a cast. Mirrors `getPrfSalt` above. */
function fromBase64url(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Coerce a WebAuthn `BufferSource` to a plain `ArrayBuffer`. TS 5.7's lib.dom
 *  models the PRF result as `BufferSource`, which admits views over a
 *  `SharedArrayBuffer`, so normalise by copying out of any view. Mirrors
 *  `apps/web/src/lib/auth/passkey-account.ts:34`, which already solved this. */
function toArrayBuffer(src: BufferSource): ArrayBuffer {
  if (src instanceof ArrayBuffer) return src;
  return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
}

function extractPrfResult(extensions: AuthenticationExtensionsClientOutputs): ArrayBuffer {
  const prf = extensions.prf;
  if (!prf?.results?.first) {
    throw new Error("PRF extension did not return a result. Your browser or passkey may not support PRF.");
  }
  return toArrayBuffer(prf.results.first);
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

// RP-ID policy lives in @woco/shared (resolvePasskeyRpId) — the embed runs on
// organiser domains, where it resolves to the ORGANISER's hostname: a WebAuthn
// constraint (the RP ID must be a registrable suffix of the document origin),
// which is why this module can sign in with an existing credential but must
// never create one (#175) — see the note above restorePasskey.
function getPasskeyRpId(): string {
  return resolvePasskeyRpId(window.location.hostname);
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
 * an ambiguous failure — a discoverable get(). There is no create path in the
 * embed at all (see the note below discoverPasskey).
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

// There is deliberately NO passkey-create path in this module (#175). The RP ID
// here is the ORGANISER's hostname, so a passkey minted by the embed would live
// under that domain's credential scope: a separate WoCo account per organiser
// site, none of them the account the buyer holds on woco.eth.limo, invisible to
// the canonical origin, and unrecoverable from it. Per #140's rule a claim must
// never mint an account. Create can only return when the ceremony runs in a
// WoCo-origin context (popup/iframe on woco.eth.limo) — a design change, not a
// config value.

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

  // @noble/curves v2 returns ENCODED BYTES. v1 returned a RecoveredSignature
  // object, so `sig.r` was a bigint; here it is `undefined`, and
  // `undefined.toString(16)` threw on EVERY call — the embed's passkey claim
  // path had been dead since the v2 bump on 2026-07-13 (#143). Nothing caught
  // it because vite/esbuild strip types without checking them and this package
  // was typechecked nowhere (#144).
  //
  // BOTH options are load-bearing:
  //   prehash: false — v2 defaults to TRUE, i.e. it would sha256 the argument.
  //     The caller passes an EIP-712 digest that is already the message to sign,
  //     so the default produces a perfectly valid signature over the wrong
  //     32 bytes. That failure is silent: the server recovers a different
  //     address and answers "not the claimer".
  //   format: "recovered" — 'compact' (the default) is 64 bytes with no
  //     recovery byte, and `v` is what lets a verifier recover the signer.
  //
  // NOTE ON REACH: no server consumes this today. The v1 claim route this posts
  // to was deleted with the rail (#207), so the embed's claim buttons currently
  // reach a 404 — tracked as #206. Fixing the signing is groundwork for the v2
  // rail (#202), not a live round trip. Worth stating, because a reader could
  // otherwise conclude from this function that the path works end to end.
  //
  // Layout is [recovery, r(32), s(32)] — recovery FIRST, verified against
  // ethers rather than assumed; `test/passkey-signing.test.ts` pins the exact
  // bytes for four frozen vectors covering both v=27 and v=28.
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });

  const recovery = sig[0]!;
  const rs = toHex(sig.subarray(1));
  const v = (recovery + 27).toString(16).padStart(2, "0");

  return "0x" + rs + v;
}
