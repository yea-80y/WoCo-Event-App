import {
  StorageKeys,
  PASSKEY_PRF_OUTPUT_BYTES,
  passkeyProviderFromAaguid,
  PASSKEY_PROVIDERS,
  type PasskeyAccountKeys,
  type PasskeyProviderId,
  type PasskeyWindowAccountResult,
  type PasskeyWindowAction,
  type PasskeyWindowError,
  type PasskeyWindowGuardianResult,
  type PasskeyWindowRequest,
  type PasskeyWindowResult,
} from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import { PASSKEY_WINDOW, PasskeyWindowErrorReply, passkeyWindow, windowRefusal } from "./passkey-window.js";

/**
 * The app's passkey accounts. Every ceremony runs in the passkey sign-in window
 * (passkey-window.ts, src/auth-window/), so this module never calls WebAuthn and never
 * sees the PRF output: it sends the window a request and takes back the keys derived
 * from it. What stays here is everything the app keeps - the credential pin, the
 * ceremony lock, and the errors the sign-in screens read.
 */

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

/** Every WoCo passkey's RP ID: the window's own host (`PASSKEY_PRODUCTION_RP_ID`). */
const PASSKEY_RP_ID = new URL(PASSKEY_WINDOW).hostname;

/**
 * What one ceremony yields. `privateKey` is the Kernel's ECDSA owner key
 * (`keccak256(prf)`, frozen); `keys` is everything else the PRF output gives - the
 * seed of a passkey-made account, its seed lock, box key and portability keys
 * (`@woco/shared` crypto/passkey-prf.ts). Never the output itself.
 */
export interface PasskeyKeyMaterial {
  address: string;
  privateKey: `0x${string}`;
  keys: PasskeyAccountKeys;
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

/** The owner key and its address. ethers is imported lazily — this module is in the
 *  login modal's boot graph. */
async function materialOf(keys: PasskeyAccountKeys): Promise<PasskeyKeyMaterial> {
  const { hexlify, Wallet } = await import("ethers");
  const privateKey = hexlify(keys.ownerKey) as `0x${string}`;
  return { address: new Wallet(privateKey).address.toLowerCase(), privateKey, keys };
}

/**
 * What a backup-passkey GUARDIAN yields: its owner key (the on-chain guardian that
 * signs the recovery userOp) and its escrow master (#642), from which the escrow
 * and SOC keys derive.
 */
export interface PasskeyGuardianMaterial {
  address: string;
  privateKey: string;
  escrowMaster: Uint8Array;
}

/**
 * The passkey answered without the secret WoCo derives the account from. Said in
 * terms of what to do, never "PRF". A CREATION knows which manager saved the passkey
 * (`created.provider`, from its AAGUID): named, because that manager now holds a
 * useless passkey and the advice must not send the person back to it - the old
 * copy recommended Google Password Manager whichever manager had failed.
 */
export class PasskeyPrfUnsupportedError extends Error {
  readonly provider?: PasskeyProviderId;
  /** `label`: the name the passkey was saved under ("WoCo Account" unless a backup). */
  constructor(created?: { provider: PasskeyProviderId; label?: string }) {
    const name = created && created.provider in PASSKEY_PROVIDERS
      ? PASSKEY_PROVIDERS[created.provider as keyof typeof PASSKEY_PROVIDERS].name
      : null;
    super(
      created
        ? `${name ?? "This password manager"} saved the passkey but can't give WoCo the secret your account is made from, so it can't be used. ` +
            `Delete the "${created.label ?? "WoCo Account"}" passkey${name ? ` from ${name}` : ""} and create it again in a different password manager.`
        : "This password manager can't hold a WoCo passkey. Use a different one - Apple Passwords on an iPhone, iPad or Mac, or Google Password Manager on Android or in Chrome.",
    );
    this.name = "PasskeyPrfUnsupportedError";
    if (created) this.provider = created.provider;
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

/**
 * The passkey EXISTS, but the follow-up that was to hand over its secret (asked for in
 * the window when the creation gave none) was declined. The credential is in the
 * password manager and a sign-in with it (one tap, one ceremony) finishes the account.
 */
export class PasskeyCreatedWithoutSecretError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(
      "Your passkey was created, but the follow-up confirmation that gives WoCo its secret didn't complete. Tap Sign in with Passkey and choose it to finish.",
    );
    this.name = "PasskeyCreatedWithoutSecretError";
    this.cause = cause;
  }
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
 * ONE ceremony at a time. In the page this was a WebAuthn rule (a second call while
 * one is pending rejects with a NotAllowedError indistinguishable from a cancel, which
 * once cascaded into minting a new account); with the window it is ours: one window,
 * one request, and two callers that race (`_getSigner` and `_getSeedSigner` both await
 * `_ensurePasskeyKey`) must not open two.
 *
 * Every exported ceremony runs through this serial queue. The `_impl` split below is
 * not stylistic: taking the lock inside a function that another locked function calls
 * would self-deadlock, so the lock is held ONLY at the exported boundary.
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
  /** The browser refused before any sheet could open (see `isQuickRefusal`): the
   *  person chose nothing, so "you may have cancelled" and the create offer are wrong. */
  readonly noSheet: boolean;
  constructor(cause?: unknown) {
    const noSheet = isQuickRefusal(cause);
    super(
      noSheet
        ? PROMPT_DID_NOT_OPEN_MESSAGE
        : "No passkey was used. You may have cancelled, or there may be no WoCo passkey on this device.",
    );
    this.name = "PasskeyAssertionUnavailableError";
    this.cause = cause;
    this.noSheet = noSheet;
  }
}

/**
 * A NotAllowedError that came back faster than a sheet can be shown and dismissed
 * (iOS: a Face ID or passkey sheet takes longer than this to appear and be
 * cancelled). WebKit refuses like that before any prompt when it will not run the
 * ceremony at all: no user gesture it accepts, another ceremony still pending, or an
 * embedded web view (an app's built-in browser) whose host app is not associated
 * with this domain. The window measures it (`quick`); copy only - never a decision.
 */
const quickRefusals = new WeakSet<object>();

export function isQuickRefusal(e: unknown): boolean {
  return typeof e === "object" && e !== null && quickRefusals.has(e);
}

export const PROMPT_DID_NOT_OPEN_MESSAGE =
  "The passkey prompt didn't open. Tap the button again - if it still doesn't open, this browser can't use passkeys here, so open WoCo in Safari or Chrome.";

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
 * The browser refused passkeys for the passkey host before any prompt. That host is one
 * label below the Public Suffix List's `*.eth.limo`, which every engine accepts (Firefox
 * refused `woco.eth.limo` itself), so this should not happen - it is kept so a browser
 * that still does says where passkeys work, rather than showing the raw refusal.
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

export class PasskeyCeremonyCancelledError extends Error {
  readonly cause?: unknown;
  /** No sheet was shown: the browser refused to start the ceremony (`isQuickRefusal`). */
  readonly noSheet: boolean;
  constructor(action: "creation" | "authentication", cause?: unknown) {
    const noSheet = isQuickRefusal(cause);
    super(noSheet ? PROMPT_DID_NOT_OPEN_MESSAGE : `Passkey ${action} was cancelled or not permitted by your device.`);
    this.name = "PasskeyCeremonyCancelledError";
    this.cause = cause;
    this.noSheet = noSheet;
  }
}

/** A window refusal as the error the in-page ceremonies threw, so every caller reads it
 *  exactly as before. Browser refusals come back as DOMExceptions by name. */
export function errorFromWindow(e: PasskeyWindowError): unknown {
  switch (e.name) {
    case "NotAllowedError": {
      const d = windowRefusal(e);
      if (e.quick) quickRefusals.add(d);
      return d;
    }
    case "InvalidStateError":
      return new DOMException("The password manager refused this passkey.", "InvalidStateError");
    case "SecurityError":
      return new PasskeyBrowserRefusedError(PASSKEY_RP_ID, new DOMException("The operation is insecure.", "SecurityError"));
    case "PrfUnsupported":
      return new PasskeyPrfUnsupportedError(
        e.label ? { provider: passkeyProviderFromAaguid(e.aaguid ?? null), label: e.label } : undefined,
      );
    case "BadPrfLength":
      return new Error(
        `Your passkey returned an unexpected PRF result (${e.detail ?? "?"} bytes, expected ${PASSKEY_PRF_OUTPUT_BYTES}). ` +
          "Try a different authenticator (e.g. iCloud Keychain, Google Password Manager, or 1Password).",
      );
    case "CreatedWithoutSecret":
      return new PasskeyCreatedWithoutSecretError();
    case "IsBackup":
      return new PasskeyIsBackupError();
    case "FromAnotherDevice":
      return new PasskeyFromAnotherDeviceError();
    case "NotOnThisDevice":
      return new PasskeyNotOnThisDeviceError();
    case "UnsupportedRequest":
      return new Error("The passkey window and this page are out of step. Reload WoCo and try again.");
    case "Unexpected":
      return new Error(`The passkey window hit a problem${e.detail ? `: ${e.detail}` : ""}.`);
  }
}

type WindowRun = (
  action: PasskeyWindowAction,
  params?: Pick<PasskeyWindowRequest, "credentialId" | "fallback" | "exclude" | "createdOn">,
) => Promise<PasskeyWindowResult>;

let _runWindow: WindowRun = (action, params) => passkeyWindow(action, params);

/** Tests only: answer ceremonies from a script instead of a window. */
export function __setPasskeyWindowForTests(run: WindowRun | null): void {
  _runWindow = run ?? ((action, params) => passkeyWindow(action, params));
}

async function inWindow(action: PasskeyWindowAction, params?: Parameters<WindowRun>[1]): Promise<PasskeyWindowResult> {
  try {
    return await _runWindow(action, params);
  } catch (e) {
    throw e instanceof PasskeyWindowErrorReply ? errorFromWindow(e.reply) : e;
  }
}

const account = async (action: PasskeyWindowAction, params?: Parameters<WindowRun>[1]) =>
  (await inWindow(action, params)) as PasskeyWindowAccountResult;

async function guardian(action: "backup-create" | "backup-get"): Promise<PasskeyGuardianMaterial> {
  const { keys } = (await inWindow(action)) as PasskeyWindowGuardianResult;
  const { hexlify, Wallet } = await import("ethers");
  const privateKey = hexlify(keys.ownerKey);
  keys.ownerKey.fill(0);
  return { address: new Wallet(privateKey).address.toLowerCase(), privateKey, escrowMaster: keys.escrowMaster };
}

/**
 * Run a ceremony under the lock, translating a raw NotAllowedError into readable
 * copy. Applied at the exported boundary so it covers every request a ceremony makes.
 * Non-NotAllowedError faults — unsupported PRF, a refused browser — pass through
 * untouched; they are actionable and must stay legible.
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

/** Check if this browser supports WebAuthn passkeys (the window runs in this browser). */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

// ---------------------------------------------------------------------------
// Authenticate (discoverable)
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
  let r: PasskeyWindowAccountResult;
  try {
    r = await account("signin");
  } catch (e) {
    // NotAllowedError is the opaque catch-all; anything else (PRF unsupported,
    // a backup passkey, a refused browser) is a real, actionable fault.
    if (e instanceof DOMException && e.name === "NotAllowedError") throw new PasskeyAssertionUnavailableError(e);
    throw e;
  }
  return pinSignIn(r);
}

/** Pin what a sign-in answered with, so init() can restore kind on reload. A sign-in
 *  cannot read the provider (#746: creation only), so keep the one recorded for this
 *  same passkey rather than erase it. */
async function pinSignIn(r: PasskeyWindowAccountResult): Promise<PasskeyLogin> {
  const prev = await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL);
  const meta: PasskeyCredentialMeta = {
    credentialId: r.credentialId,
    rpId: PASSKEY_RP_ID,
    ...(prev?.credentialId === r.credentialId && prev.provider ? { provider: prev.provider } : {}),
  };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, meta);
  return {
    ...(await materialOf(r.keys)),
    credentialId: r.credentialId,
    attachment: r.attachment,
    handleKind: r.handleKind,
    replacedPin: prev ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create (only called when no existing passkey for this RP)
// ---------------------------------------------------------------------------

/**
 * Create a new passkey and derive the account from it.
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

async function _mintPasskeyAccountImpl(): Promise<
  PasskeyKeyMaterial & { credential: PasskeyCredentialMeta; attachment: PasskeyAttachment }
> {
  const r = await account("create");
  const meta: PasskeyCredentialMeta = { credentialId: r.credentialId, rpId: PASSKEY_RP_ID, provider: passkeyProviderFromAaguid(r.aaguid) };
  return { ...(await materialOf(r.keys)), credential: meta, attachment: r.attachment };
}

// ---------------------------------------------------------------------------
// Added passkey (#746 step 3) - a second passkey for the SAME account
// ---------------------------------------------------------------------------

export interface AddedPasskey extends PasskeyKeyMaterial {
  credentialId: string;
  provider: PasskeyProviderId;
}

/** A locale's date as the window takes it (PASSKEY_CREATED_ON_RE): anything else
 *  dropped, so no locale can make "Add a passkey" fail. */
export function passkeyNameDate(text: string, now: Date = new Date()): string {
  const kept = text.replace(/[^\p{L}\p{M}\p{N}\p{Zs}\p{P}]/gu, "").trim().slice(0, 40);
  return kept || now.toISOString().slice(0, 10);
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
 * - Platform only, and a cross-platform answer refused (in the window): a passkey
 *   made through a QR code lives on the other device, where its key opens a
 *   different account.
 * - The added user handle tells a later sign-in what it is (`handleKind`).
 */
export async function createAddedPasskey(opts: {
  exclude: readonly string[];
  /** Shown in the password manager beside the main passkey's "WoCo Account". */
  createdOn: string;
}): Promise<AddedPasskey> {
  return ceremony("creation", () => _createAddedPasskeyImpl(opts));
}

async function _createAddedPasskeyImpl(opts: { exclude: readonly string[]; createdOn: string }): Promise<AddedPasskey> {
  let r: PasskeyWindowAccountResult;
  try {
    r = await account("add", { exclude: [...opts.exclude], createdOn: passkeyNameDate(opts.createdOn) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "InvalidStateError") throw new PasskeyAlreadyInManagerError();
    throw e;
  }
  return { ...(await materialOf(r.keys)), credentialId: r.credentialId, provider: passkeyProviderFromAaguid(r.aaguid) };
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
 *   2. Labelled "WoCo Backup" (in the window) so the user can tell it apart from
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
  return ceremony("creation", () => guardian("backup-create"));
}

/**
 * Re-derive the backup passkey key at RECOVERY time. Discoverable get() shows the
 * authenticator picker so the user selects their "WoCo Backup" passkey; we never
 * touch StorageKeys.PASSKEY_CREDENTIAL — the recovering device may already hold a
 * different primary credential we must not disturb.
 */
export async function getPasskeyBackupKey(): Promise<PasskeyGuardianMaterial> {
  return ceremony("authentication", () => guardian("backup-get"));
}

// ---------------------------------------------------------------------------
// Restore (used by init() to re-derive key silently when session exists)
// ---------------------------------------------------------------------------

/**
 * Authenticate with a stored passkey credential (pinned by ID).
 * Used for re-derivation after a reload, when we know which credential to use.
 * Falls back to the account picker if the stored credential is refused - unless
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

/** A credential made under the passkey host's RP ID, as the pin and
 *  `restorePasskeyAccount` take it - for a passkey not (yet) pinned here: one being
 *  linked (#746 step 4). */
export function passkeyHandleOnThisOrigin(credentialId: string, provider?: PasskeyProviderId): PasskeyCredentialHandle {
  return { credentialId, rpId: PASSKEY_RP_ID, ...(provider ? { provider } : {}) };
}

async function _restorePasskeyAccountImpl(
  retryDiscoverable: boolean,
  credential?: PasskeyCredentialHandle,
): Promise<PasskeyKeyMaterial> {
  const meta = credential ?? (await getKV<PasskeyCredentialMeta>(StorageKeys.PASSKEY_CREDENTIAL));
  // No pin, or one made under another RP ID (a passkey from before the window, which
  // the window's host cannot use): the picker, sign-in only, never creates.
  if (!meta || meta.rpId !== PASSKEY_RP_ID) return _authenticatePasskeyImpl();
  const r = await account("restore", { credentialId: meta.credentialId, fallback: retryDiscoverable });
  // The picker answered instead of the pinned passkey: pin what answered, as a sign-in does.
  if (r.credentialId !== meta.credentialId && !credential) return pinSignIn(r);
  return materialOf(r.keys);
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
