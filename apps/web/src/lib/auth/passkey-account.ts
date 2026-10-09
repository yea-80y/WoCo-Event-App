/// <reference path="./webauthn-prf.d.ts" />

import {
  StorageKeys,
  PASSKEY_PRF_SALT_INPUT,
  PASSKEY_PRF_OUTPUT_BYTES,
  passkeyGuardianEscrowMaster,
  resolvePasskeyRpId,
  newBackupUserHandle,
  isBackupUserHandle,
  newAddedUserHandle,
  isAddedUserHandle,
  aaguidFromAuthenticatorData,
  passkeyProviderFromAaguid,
  type PasskeyProviderId,
} from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import { mustSignInElsewhere } from "./sign-in-host.js";
import { buildEnv } from "../build-env.js";

/** Credential metadata stored in IndexedDB (not secret) */
interface PasskeyCredentialMeta {
  credentialId: string; // base64url-encoded
  rpId: string;
  /** The password manager that made it, read at creation and kept on this device
   *  only (#746). Absent on passkeys made before that, which cannot be identified later. */
  provider?: PasskeyProviderId;
}

/**
 * The same metadata, named for the one caller that holds it UNWRITTEN. Recovery
 * must mint a passkey before the irreversible on-chain rotation and pin it only
 * after (#158), so the handle crosses code that has no business treating it as a
 * storage record yet — the name is the reminder that nothing is committed until
 * `pinPasskeyCredential` runs.
 */
export type PasskeyCredentialHandle = PasskeyCredentialMeta;

// RP-ID policy lives in @woco/shared (resolvePasskeyRpId) — identity-critical,
// and the embed resolves it too, so a local copy is how #175 shipped.
function getPasskeyRpId(): string {
  return resolvePasskeyRpId(window.location.hostname);
}

/** The RP ID for a ceremony - refused off the canonical host (#186, Fable on
 *  #822): a passkey made or used there is scoped to that hostname, a second
 *  account. Sign-in already redirects; this also covers the upgrade, add-device
 *  and backup flows reachable from a session restored on another host. Only
 *  ceremonies throw: getPasskeyRpId stays safe for restore-time reads. */
function ceremonyRpId(): string {
  if (mustSignInElsewhere(window.location.hostname, buildEnv(() => import.meta.env.DEV) === true)) {
    throw new Error("Passkeys work on woco.eth.limo only - open WoCo there to continue.");
  }
  return getPasskeyRpId();
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

/**
 * What one PRF ceremony yields. `privateKey` is the Kernel's ECDSA owner key
 * (`keccak256(prf)`, frozen); `prfSecret` is the PRF output itself, the root of the
 * identity seed and the portability keys (`@woco/shared` crypto/passkey-prf.ts, #642).
 * They are carried apart because neither is derivable from the other.
 */
export interface PasskeyKeyMaterial {
  address: string;
  privateKey: `0x${string}`;
  prfSecret: `0x${string}`;
}

/**
 * How a passkey answered: on this device ("platform") or from another device or a
 * security key ("cross-platform", which includes the QR-code flow). Null when the
 * browser does not say. A QR-code answer can carry the wrong PRF output, so a
 * "cross-platform" sign-in commits only when the passkey's record (#746) confirms
 * the account it derived (passkey-record.ts).
 */
export type PasskeyAttachment = "platform" | "cross-platform" | null;

/** A sign-in or creation: the key material plus which credential produced it. */
export interface PasskeyLogin extends PasskeyKeyMaterial {
  credentialId: string;
  attachment: PasskeyAttachment;
  /** "added": the credential was made by "Add a passkey" (#746) - it signs in as a
   *  device of an account, never as an account of its own. */
  handleKind: "added" | null;
  /** Sign-in only: the pin this ceremony overwrote (null = none), so a sign-in
   *  refused after the ceremony can put it back. */
  replacedPin?: PasskeyCredentialHandle | null;
}

function attachmentOf(credential: PublicKeyCredential): PasskeyAttachment {
  const a = (credential as { authenticatorAttachment?: string | null }).authenticatorAttachment;
  return a === "platform" || a === "cross-platform" ? a : null;
}

/** Derive the owner key + address from the PRF output, and hand the output on.
 *  ethers is imported lazily — this module is in the login modal's boot graph. */
async function deriveKey(prfOutput: ArrayBuffer): Promise<PasskeyKeyMaterial> {
  const prfBytes = new Uint8Array(prfOutput);
  // Checked BEFORE the owner key too: a short output used to keccak into a valid,
  // wrong account, and it would now also become somebody's identity seed.
  if (prfBytes.length !== PASSKEY_PRF_OUTPUT_BYTES) {
    throw new Error(
      `Your passkey returned an unexpected PRF result (${prfBytes.length} bytes, expected ${PASSKEY_PRF_OUTPUT_BYTES}). ` +
        "Try a different authenticator (e.g. iCloud Keychain, Google Password Manager, or 1Password).",
    );
  }
  const { keccak256, hexlify, Wallet } = await import("ethers");
  const privateKey = keccak256(prfBytes) as `0x${string}`;
  const wallet = new Wallet(privateKey);
  return {
    address: wallet.address.toLowerCase(),
    privateKey,
    prfSecret: hexlify(prfBytes) as `0x${string}`,
  };
}

/**
 * What a backup-passkey GUARDIAN yields: its owner key (the on-chain guardian that
 * signs the recovery userOp) and its escrow master (#642), from which the escrow
 * and SOC keys derive. The raw PRF output would be the root of a second account's
 * seed, so it never leaves this module — only purpose-bound children do.
 */
export interface PasskeyGuardianMaterial {
  address: string;
  privateKey: string;
  escrowMaster: Uint8Array;
}

async function deriveGuardianKey(prfOutput: ArrayBuffer): Promise<PasskeyGuardianMaterial> {
  const { address, privateKey, prfSecret } = await deriveKey(prfOutput);
  return { address, privateKey, escrowMaster: passkeyGuardianEscrowMaster(prfSecret) };
}

/**
 * The passkey answered without the secret WoCo derives the account from. Said in
 * terms of what to do, never "PRF".
 */
export class PasskeyPrfUnsupportedError extends Error {
  constructor() {
    super(
      "This password manager can't hold a WoCo passkey yet. Try Google Password Manager, iCloud Keychain or 1Password.",
    );
    this.name = "PasskeyPrfUnsupportedError";
  }
}

/**
 * A sign-in answered from another device - a phone by QR code, or a security key -
 * either without the secret WoCo derives the account from, or with one this
 * passkey's record does not confirm. Over QR code that secret can differ from the
 * phone's own, and a different secret is a different, empty account; pairing gives
 * this device its own passkey instead.
 */
export class PasskeyFromAnotherDeviceError extends Error {
  constructor() {
    super("That passkey answered from another device - add this one from your phone instead.");
    this.name = "PasskeyFromAnotherDeviceError";
  }
}

/** Extract PRF result from a WebAuthn credential response. */
function extractPrfResult(
  extensions: AuthenticationExtensionsClientOutputs,
): ArrayBuffer {
  const prf = extensions.prf;
  if (!prf?.results?.first) throw new PasskeyPrfUnsupportedError();
  return toArrayBuffer(prf.results.first);
}

/**
 * The PRF output of a credential that was just CREATED. Many authenticators return
 * it at creation; some report `prf.enabled` without a value, and some (Samsung Pass,
 * per Corbado's August 2026 measurements) report nothing at all at creation and
 * answer only when the credential is used. The PRF extension makes evaluation at
 * creation optional, so the authoritative probe is one assertion against this exact
 * credential - tried whenever creation gave no value, whatever `enabled` said.
 */
async function prfAfterCreate(
  credential: PublicKeyCredential,
  rpId: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const created = credential.getClientExtensionResults().prf?.results?.first;
  if (created) return toArrayBuffer(created);
  const getResult = (await credentialsGet({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      allowCredentials: [{ id: new Uint8Array(credential.rawId), type: "public-key" }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: salt } },
      },
    },
  })) as PublicKeyCredential | null;
  if (!getResult) throw new Error("Passkey authentication was cancelled.");
  return extractPrfResult(getResult.getClientExtensionResults());
}

/**
 * A backup passkey was picked to SIGN IN. It belongs under Recover account: as a
 * login it would derive an empty account of its own (#545 A3).
 */
export class PasskeyIsBackupError extends Error {
  constructor() {
    super("That's the backup passkey for your account. Sign in with your main passkey, or use it under Recover account.");
    this.name = "PasskeyIsBackupError";
  }
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
 * `_getSeedSigner` both await `_ensurePasskeyKey`), and mobile's slower
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
/** "Add a passkey" was offered a password manager that already holds one of this
 *  account's passkeys (`excludeCredentials`, #746). */
export class PasskeyAlreadyInManagerError extends Error {
  constructor() {
    super(
      "That password manager already holds a passkey for this account. Pick a different one, or set up a second password manager on this device first.",
    );
    this.name = "PasskeyAlreadyInManagerError";
  }
}

/** "Add a passkey" was answered by another device (a QR code): that passkey would
 *  open a different account on the device holding it. */
export class PasskeyNotOnThisDeviceError extends Error {
  constructor() {
    super("That passkey would live on another device. Pick a password manager on this one.");
    this.name = "PasskeyNotOnThisDeviceError";
  }
}

/**
 * The browser refused passkeys for this address before any prompt. Firefox refuses
 * an RP ID that is itself on the Public Suffix List, even when it equals the page's
 * host, and `*.eth.limo` joined that list on 2026-09-01 - so woco.eth.limo is one.
 * Chromium and WebKit accept the exact match. Nothing WoCo sends can change it.
 */
export class PasskeyBrowserRefusedError extends Error {
  readonly cause?: unknown;
  readonly host: string;
  constructor(host: string, cause?: unknown) {
    super(`This browser can't use passkeys on ${host}. Open WoCo in Chrome, Brave, Edge or Safari to continue.`);
    this.name = "PasskeyBrowserRefusedError";
    this.host = host;
    this.cause = cause;
  }
}

/** Only when the RP ID IS the page's host: a SecurityError there cannot be a mismatch
 *  of ours. (Storage faults surface from IndexedDB, outside these wrappers.) */
function namedRefusal(e: unknown, rpId: string | undefined): unknown {
  return e instanceof DOMException && e.name === "SecurityError" && rpId === window.location.hostname
    ? new PasskeyBrowserRefusedError(rpId, e)
    : e;
}

/** Every ceremony calls the browser through these two, so none shows the raw refusal. */
function credentialsGet(options: CredentialRequestOptions): Promise<Credential | null> {
  return navigator.credentials.get(options).catch((e: unknown) => {
    throw namedRefusal(e, options.publicKey?.rpId);
  });
}

function credentialsCreate(options: CredentialCreationOptions): Promise<Credential | null> {
  return navigator.credentials.create(options).catch((e: unknown) => {
    throw namedRefusal(e, options.publicKey?.rp.id);
  });
}

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
 * and any inner one (the create paths do a second get() when creation returns
 * no PRF value, `prfAfterCreate`) without restructuring either.
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
export async function authenticatePasskey(): Promise<PasskeyLogin> {
  return withCeremonyLock(_authenticatePasskeyImpl);
}

async function _authenticatePasskeyImpl(): Promise<PasskeyLogin> {
  const salt = await getPrfSalt();
  const rpId = ceremonyRpId();

  let credential: PublicKeyCredential | null;
  try {
    // Discoverable mode (no allowCredentials) → user picks from all passkeys for this RP
    credential = (await credentialsGet({
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

  // Before anything is derived or pinned: a backup passkey must never become this
  // device's login credential.
  const userHandle = (credential.response as AuthenticatorAssertionResponse).userHandle;
  if (userHandle && isBackupUserHandle(new Uint8Array(userHandle))) throw new PasskeyIsBackupError();

  // Here, not inside extractPrfResult, which creation and the unlock share: only a
  // sign-in from another device is steered to pairing.
  const attachment = attachmentOf(credential);
  const extensions = credential.getClientExtensionResults();
  if (attachment === "cross-platform" && !extensions.prf?.results?.first) throw new PasskeyFromAnotherDeviceError();
  const prfOutput = extractPrfResult(extensions);

  // Update stored credential metadata so init() can restore kind on reload. A sign-in
  // cannot read the provider (#746: creation only), so keep the one recorded for
  // this same passkey rather than erase it.
  const credentialId = toBase64url(credential.rawId);
  const prev = await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL);
  const meta: PasskeyCredentialMeta = {
    credentialId,
    rpId,
    ...(prev?.credentialId === credentialId && prev.provider ? { provider: prev.provider } : {}),
  };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, meta);

  return {
    ...(await deriveKey(prfOutput)),
    credentialId: meta.credentialId,
    attachment,
    handleKind: userHandle && isAddedUserHandle(new Uint8Array(userHandle)) ? "added" : null,
    replacedPin: prev ?? null,
  };
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
export async function createPasskeyAccount(): Promise<PasskeyLogin> {
  return ceremony("creation", _createPasskeyAccountImpl);
}

/**
 * Mint a primary-login passkey and hand back its credential WITHOUT pinning it as
 * this device's login. The recovery ceremony needs the two halves apart: the new
 * Kernel owner IS the PRF-EOA, so the passkey has to exist before the irreversible
 * on-chain rotation, while the pin is a local commit that belongs beside the
 * binding and the identity seed — after the rotation is proven (#158). Pinning at
 * mint time left a device whose stored credential owned no account whenever a
 * later step of the ceremony threw, and `init()` then demanded a parent and seed
 * address that were never written.
 *
 * The caller MUST pass the returned handle to `pinPasskeyCredential` once it
 * commits, or this device keeps offering "Create" to an account it already owns.
 */
export async function createPasskeyAccountUnpinned(): Promise<
  PasskeyKeyMaterial & { credential: PasskeyCredentialHandle }
> {
  return ceremony("creation", _mintPasskeyAccountImpl);
}

/** Commit a minted credential as this device's primary login — the second half of
 *  `createPasskeyAccountUnpinned`. */
export async function pinPasskeyCredential(handle: PasskeyCredentialHandle): Promise<void> {
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, handle);
}

async function _createPasskeyAccountImpl(): Promise<PasskeyLogin> {
  const { credential, attachment, ...material } = await _mintPasskeyAccountImpl();
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, credential);
  return { ...material, credentialId: credential.credentialId, attachment, handleKind: null };
}

/** The password manager a just-created credential reports (#746); "unknown" when
 *  the browser cannot say. Never throws: a label is not worth a failed sign-up. */
function providerOf(credential: PublicKeyCredential): PasskeyProviderId {
  try {
    const response = credential.response as AuthenticatorAttestationResponse & {
      getAuthenticatorData?: () => ArrayBuffer;
    };
    const data = response.getAuthenticatorData?.();
    return passkeyProviderFromAaguid(data ? aaguidFromAuthenticatorData(new Uint8Array(data)) : null);
  } catch {
    return "unknown";
  }
}

async function _mintPasskeyAccountImpl(): Promise<
  PasskeyKeyMaterial & { credential: PasskeyCredentialMeta; attachment: PasskeyAttachment }
> {
  const salt = await getPrfSalt();
  const rpId = ceremonyRpId();

  const credential = (await credentialsCreate({
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

  const prfOutput = await prfAfterCreate(credential, rpId, salt);

  const meta: PasskeyCredentialMeta = {
    credentialId: toBase64url(credential.rawId),
    rpId,
    provider: providerOf(credential),
  };

  return { ...(await deriveKey(prfOutput)), credential: meta, attachment: attachmentOf(credential) };
}

// ---------------------------------------------------------------------------
// Added passkey (#746 step 3) - a second passkey for the SAME account
// ---------------------------------------------------------------------------

export interface AddedPasskey extends PasskeyKeyMaterial {
  credentialId: string;
  provider: PasskeyProviderId;
}

/**
 * Make another passkey for the signed-in account, on THIS device, in a password
 * manager that does not already hold one of its passkeys. Never pinned as this
 * device's login - the main passkey stays that; the caller grants it, writes its
 * envelope and its record.
 *
 * - `exclude`: every credential this device knows for the account (base64url), so
 *   the manager that holds one refuses and the person picks another - a second
 *   passkey in the same manager is lost with it.
 * - Platform only, and a cross-platform answer refused: a passkey made through a
 *   QR code lives on the other device, where its key opens a different account.
 * - The added user handle tells a later sign-in what it is (`handleKind`).
 */
export async function createAddedPasskey(opts: {
  exclude: readonly string[];
  /** Shown in the password manager beside the main passkey's "WoCo Account". */
  createdOn: string;
}): Promise<AddedPasskey> {
  return ceremony("creation", () => _createAddedPasskeyImpl(opts));
}

async function _createAddedPasskeyImpl(opts: {
  exclude: readonly string[];
  createdOn: string;
}): Promise<AddedPasskey> {
  const salt = await getPrfSalt();
  const rpId = ceremonyRpId();
  const name = `WoCo Account - added ${opts.createdOn}`;

  let credential: PublicKeyCredential | null;
  try {
    credential = (await credentialsCreate({
      publicKey: {
        rp: { name: "WoCo", id: rpId },
        user: { id: newAddedUserHandle(), name, displayName: name },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },   // ES256
          { alg: -257, type: "public-key" },  // RS256
        ],
        excludeCredentials: opts.exclude.map((id) => ({ id: fromBase64url(id), type: "public-key" as const })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
          authenticatorAttachment: "platform",
        },
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && e.name === "InvalidStateError") throw new PasskeyAlreadyInManagerError();
    throw e;
  }

  if (!credential) {
    throw new Error("Passkey creation was cancelled.");
  }
  if (attachmentOf(credential) === "cross-platform") throw new PasskeyNotOnThisDeviceError();

  const prfOutput = await prfAfterCreate(credential, rpId, salt);
  return {
    ...(await deriveKey(prfOutput)),
    credentialId: toBase64url(credential.rawId),
    provider: providerOf(credential),
  };
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
 * The owner key is keccak256(PRF(fixed-salt)) — identical construction to the
 * primary — and the escrow master is an HKDF sibling of it (#642), so
 * getPasskeyBackupKey() re-derives the SAME pair at recovery from the SAME
 * credential. A wrong pick fails SAFE: the derived guardian address won't match
 * the escrow, so recovery is refused rather than mis-applied. Independence from
 * the primary is guaranteed by the caller's own-key block (the derived address
 * can never equal auth.parent / auth.seedAddress).
 */
export async function createPasskeyBackupKey(): Promise<PasskeyGuardianMaterial> {
  return ceremony("creation", _createPasskeyBackupKeyImpl);
}

async function _createPasskeyBackupKeyImpl(): Promise<PasskeyGuardianMaterial> {
  const salt = await getPrfSalt();
  const rpId = ceremonyRpId();

  const credential = (await credentialsCreate({
    publicKey: {
      rp: { name: "WoCo", id: rpId },
      user: {
        // Tagged so a sign-in that picks it is refused instead of opening an
        // empty account (#545 A3). Recovery reads it through its own picker.
        id: newBackupUserHandle(),
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

  const prfOutput = await prfAfterCreate(credential, rpId, salt);
  return deriveGuardianKey(prfOutput);
}

/**
 * Re-derive the backup passkey key at RECOVERY time. Discoverable get() shows the
 * authenticator picker so the user selects their "WoCo Backup" passkey; we never
 * touch StorageKeys.PASSKEY_CREDENTIAL — the recovering device may already hold a
 * different primary credential we must not disturb.
 */
export async function getPasskeyBackupKey(): Promise<PasskeyGuardianMaterial> {
  return ceremony("authentication", _getPasskeyBackupKeyImpl);
}

async function _getPasskeyBackupKeyImpl(): Promise<PasskeyGuardianMaterial> {
  const salt = await getPrfSalt();
  const rpId = ceremonyRpId();

  const credential = (await credentialsGet({
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
  return deriveGuardianKey(prfOutput);
}

// ---------------------------------------------------------------------------
// Restore (used by init() to re-derive key silently when session exists)
// ---------------------------------------------------------------------------

/**
 * Authenticate with a stored passkey credential (pinned by ID).
 * Used for silent re-derivation on page reload when we know which credential to use.
 * Falls back to discoverable mode if stored credential is gone - unless
 * `retryDiscoverable` is false, where a declined sheet is the answer and the caller
 * offers the picker on its next attempt (#746 fix 1: cancel must not open a second sheet).
 */
export async function restorePasskeyAccount(
  opts: { retryDiscoverable?: boolean; credential?: PasskeyCredentialHandle } = {},
): Promise<PasskeyKeyMaterial> {
  return withCeremonyLock(() => _restorePasskeyAccountImpl(opts.retryDiscoverable ?? true, opts.credential));
}

/** A declined sheet from `restorePasskeyAccount`, in the words the other ceremonies use. */
export function asCeremonyCancel(e: unknown): unknown {
  return e instanceof DOMException && e.name === "NotAllowedError" ? new PasskeyCeremonyCancelledError("authentication", e) : e;
}

/** A credential made on this origin, as the pin and `restorePasskeyAccount` take it -
 *  for a passkey not (yet) pinned here: one being linked (#746 step 4). */
export function passkeyHandleOnThisOrigin(credentialId: string, provider?: PasskeyProviderId): PasskeyCredentialHandle {
  return { credentialId, rpId: getPasskeyRpId(), ...(provider ? { provider } : {}) };
}

async function _restorePasskeyAccountImpl(
  retryDiscoverable: boolean,
  credential?: PasskeyCredentialHandle,
): Promise<PasskeyKeyMaterial> {
  const meta = credential ?? (await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL));
  if (!meta) {
    // IDB cleared — fall back to the discoverable picker (sign-in only, never creates)
    return _authenticatePasskeyImpl();
  }

  const salt = await getPrfSalt();
  const credentialId = fromBase64url(meta.credentialId);

  try {
    const credential = (await credentialsGet({
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
    if (e instanceof DOMException && e.name === "NotAllowedError" && retryDiscoverable) {
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
