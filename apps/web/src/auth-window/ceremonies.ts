/**
 * Every WebAuthn ceremony WoCo runs, inside the passkey sign-in window. Moved from the
 * app's passkey-account.ts with the same options, checks and order, so a passkey
 * behaves exactly as it did in the page. What changed is what leaves: each ceremony
 * ends in the keys the PRF output gives (`passkeyAccountKeys` / `passkeyGuardianKeys`)
 * or in a `PasskeyWindowError` the app turns back into its own message - never in the
 * PRF output itself, which is zeroed once derived.
 *
 * Checks that need the credential (its user handle, how it answered, whether it gave a
 * PRF value) happen here, because only here is the credential seen.
 */

import { PASSKEY_PRF_SALT_INPUT } from "@woco/shared/auth/constants";
import {
  isAddedUserHandle,
  isBackupUserHandle,
  newAddedUserHandle,
  newBackupUserHandle,
} from "@woco/shared/auth/passkey-backup-handle";
import { aaguidFromAuthenticatorData } from "@woco/shared/auth/aaguid";
import type {
  PasskeyWindowAccountResult,
  PasskeyWindowError,
  PasskeyWindowGuardianResult,
  PasskeyWindowRequest,
  PasskeyWindowResult,
} from "@woco/shared/auth/passkey-window-protocol";
import { PASSKEY_PRF_OUTPUT_BYTES, passkeyAccountKeys, passkeyGuardianKeys } from "@woco/shared/crypto/passkey-prf";

/** A refusal faster than any sheet can be shown and dismissed (passkey-account.ts). */
const QUICK_REFUSAL_MS = 500;

export class WindowCeremonyError extends Error {
  constructor(readonly reply: PasskeyWindowError) {
    super(reply.name);
  }
}

export interface CeremonyDeps {
  credentials: Pick<CredentialsContainer, "get" | "create">;
  rpId: string;
  /** The follow-up tap a creation needs when it gave no PRF value; rejects on Cancel. */
  tapAgain(): Promise<void>;
  now(): number;
}

const refuse = (reply: PasskeyWindowError): never => {
  throw new WindowCeremonyError(reply);
};

const PUBKEY_PARAMS: PublicKeyCredentialParameters[] = [
  { alg: -7, type: "public-key" }, // ES256
  { alg: -257, type: "public-key" }, // RS256
];

async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PASSKEY_PRF_SALT_INPUT)));
}

const challenge = () => crypto.getRandomValues(new Uint8Array(32));

function toBase64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(str: string): Uint8Array<ArrayBuffer> {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One browser call: its refusals become window errors, by DOMException name. */
async function browser<T>(deps: CeremonyDeps, run: () => Promise<T>): Promise<T> {
  const t0 = deps.now();
  try {
    return await run();
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "NotAllowedError") return refuse({ name, quick: deps.now() - t0 < QUICK_REFUSAL_MS });
    if (name === "SecurityError" || name === "InvalidStateError") return refuse({ name });
    return refuse({ name: "Unexpected", detail: `${String(name)}: ${(e as { message?: unknown } | null)?.message ?? ""}` });
  }
}

type Cred = PublicKeyCredential;

/** The PRF output a credential carried, as a copy - the browser's buffer is zeroed. */
function takePrf(credential: Cred): Uint8Array | null {
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  const view = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  const copy = view.slice();
  view.fill(0);
  if (copy.length !== PASSKEY_PRF_OUTPUT_BYTES) {
    copy.fill(0);
    return refuse({ name: "BadPrfLength", detail: String(copy.length) });
  }
  return copy;
}

function attachmentOf(credential: Cred): PasskeyWindowAccountResult["attachment"] {
  const a = (credential as { authenticatorAttachment?: string | null }).authenticatorAttachment;
  return a === "platform" || a === "cross-platform" ? a : null;
}

function userHandleOf(credential: Cred): Uint8Array | null {
  const h = (credential.response as AuthenticatorAssertionResponse).userHandle;
  return h ? new Uint8Array(h) : null;
}

/** The AAGUID a creation reports, or null; never throws (a label is not worth a failure). */
function aaguidOf(credential: Cred): string | null {
  try {
    const data = (credential.response as AuthenticatorAttestationResponse & { getAuthenticatorData?: () => ArrayBuffer })
      .getAuthenticatorData?.();
    return data ? aaguidFromAuthenticatorData(new Uint8Array(data)) : null;
  } catch {
    return null;
  }
}

function accountResult(credential: Cred, prf: Uint8Array, handleKind: "added" | null, aaguid: string | null): PasskeyWindowAccountResult {
  try {
    return { credentialId: toBase64url(credential.rawId), attachment: attachmentOf(credential), handleKind, aaguid, keys: passkeyAccountKeys(prf) };
  } finally {
    prf.fill(0);
  }
}

function guardianResult(prf: Uint8Array): PasskeyWindowGuardianResult {
  try {
    return { keys: passkeyGuardianKeys(prf) };
  } finally {
    prf.fill(0);
  }
}

/**
 * The PRF output of a credential just CREATED. Some authenticators return it at
 * creation, some only when the credential is used (Samsung Pass), so when creation gave
 * no value and did not say no, one assertion against this credential asks for it - after
 * a tap of its own here, where the in-page flow could only say "sign in to finish".
 * `enabled: false` IS a no (WebAuthn L3: true iff the credential supports PRF).
 */
async function prfAfterCreate(deps: CeremonyDeps, credential: Cred, salt: Uint8Array<ArrayBuffer>, aaguid: string | null, label: string): Promise<Uint8Array> {
  const created = takePrf(credential);
  if (created) return created;
  if (credential.getClientExtensionResults().prf?.enabled === false) return refuse({ name: "PrfUnsupported", aaguid, label });
  try {
    await deps.tapAgain();
  } catch {
    return refuse({ name: "CreatedWithoutSecret" });
  }
  let answer: Cred | null;
  try {
    answer = (await browser(deps, () =>
      deps.credentials.get({
        publicKey: {
          challenge: challenge(),
          rpId: deps.rpId,
          allowCredentials: [{ id: new Uint8Array(credential.rawId), type: "public-key" }],
          userVerification: "required",
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    )) as Cred | null;
  } catch (e) {
    // Not "creation was cancelled": the creation succeeded, so the person signs in with
    // the passkey they now have instead of making another.
    if (e instanceof WindowCeremonyError && e.reply.name === "NotAllowedError") return refuse({ name: "CreatedWithoutSecret" });
    throw e;
  }
  if (!answer) return refuse({ name: "CreatedWithoutSecret" });
  return takePrf(answer) ?? refuse({ name: "PrfUnsupported", aaguid, label });
}

/** Discoverable sign-in: the person picks from every WoCo passkey. Never creates. */
async function signIn(deps: CeremonyDeps, salt: Uint8Array<ArrayBuffer>): Promise<PasskeyWindowAccountResult> {
  const credential = (await browser(deps, () =>
    deps.credentials.get({
      publicKey: { challenge: challenge(), rpId: deps.rpId, userVerification: "required", extensions: { prf: { eval: { first: salt } } } },
    }),
  )) as Cred | null;
  if (!credential) return refuse({ name: "NotAllowedError", quick: false });
  // Before anything is derived: a backup passkey must never become a login.
  const handle = userHandleOf(credential);
  if (isBackupUserHandle(handle)) return refuse({ name: "IsBackup" });
  const attachment = attachmentOf(credential);
  if (attachment === "cross-platform" && !credential.getClientExtensionResults().prf?.results?.first) {
    return refuse({ name: "FromAnotherDevice" });
  }
  const prf = takePrf(credential) ?? refuse({ name: "PrfUnsupported" });
  return accountResult(credential, prf, isAddedUserHandle(handle) ? "added" : null, null);
}

/** The passkey this device signed in with, by ID; the picker after a refusal if asked. */
async function restore(deps: CeremonyDeps, salt: Uint8Array<ArrayBuffer>, credentialId: string, fallback: boolean): Promise<PasskeyWindowAccountResult> {
  let credential: Cred | null;
  try {
    credential = (await browser(deps, () =>
      deps.credentials.get({
        publicKey: {
          challenge: challenge(),
          rpId: deps.rpId,
          allowCredentials: [{ id: fromBase64url(credentialId), type: "public-key" }],
          userVerification: "required",
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    )) as Cred | null;
  } catch (e) {
    // Ambiguous: gone, or cancelled. The picker below answers either way.
    if (fallback && e instanceof WindowCeremonyError && e.reply.name === "NotAllowedError") return signIn(deps, salt);
    throw e;
  }
  if (!credential) return refuse({ name: "NotAllowedError", quick: false });
  const prf = takePrf(credential) ?? refuse({ name: "PrfUnsupported" });
  return accountResult(credential, prf, isAddedUserHandle(userHandleOf(credential)) ? "added" : null, null);
}

async function create(deps: CeremonyDeps, options: PublicKeyCredentialCreationOptions): Promise<Cred> {
  const credential = (await browser(deps, () => deps.credentials.create({ publicKey: options }))) as Cred | null;
  return credential ?? refuse({ name: "NotAllowedError", quick: false });
}

function creationOptions(
  deps: CeremonyDeps,
  salt: Uint8Array<ArrayBuffer>,
  user: { id: Uint8Array<ArrayBuffer>; name: string },
  extra: Partial<PublicKeyCredentialCreationOptions> = {},
  attachment?: AuthenticatorAttachment,
): PublicKeyCredentialCreationOptions {
  return {
    rp: { name: "WoCo", id: deps.rpId },
    user: { id: user.id, name: user.name, displayName: user.name },
    challenge: challenge(),
    pubKeyCredParams: PUBKEY_PARAMS,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
      ...(attachment ? { authenticatorAttachment: attachment } : {}),
    },
    extensions: { prf: { eval: { first: salt } } },
    ...extra,
  };
}

/** Run the one request this window accepted. */
export async function runCeremony(req: PasskeyWindowRequest, deps: CeremonyDeps): Promise<PasskeyWindowResult> {
  const salt = await prfSalt();
  switch (req.action) {
    case "signin":
      return signIn(deps, salt);
    case "restore":
      return restore(deps, salt, req.credentialId!, req.fallback!);
    case "create": {
      const label = "WoCo Account";
      const credential = await create(deps, creationOptions(deps, salt, { id: crypto.getRandomValues(new Uint8Array(32)), name: label }));
      const aaguid = aaguidOf(credential);
      return accountResult(credential, await prfAfterCreate(deps, credential, salt, aaguid, label), null, aaguid);
    }
    case "add": {
      // Its own name: "WoCo Account" here would name the MAIN passkey for deletion.
      const label = `WoCo Account - added ${req.createdOn!}`;
      const exclude = req.exclude!.map((id) => ({ id: fromBase64url(id), type: "public-key" as const }));
      // Platform only: a passkey made through a QR code lives on the other device.
      const credential = await create(deps, creationOptions(deps, salt, { id: newAddedUserHandle(), name: label }, { excludeCredentials: exclude }, "platform"));
      if (attachmentOf(credential) === "cross-platform") return refuse({ name: "NotOnThisDevice" });
      const aaguid = aaguidOf(credential);
      return accountResult(credential, await prfAfterCreate(deps, credential, salt, aaguid, label), "added", aaguid);
    }
    case "backup-create": {
      // Tagged so a sign-in that picks it is refused instead of opening an empty account.
      const label = "WoCo Backup";
      const credential = await create(deps, creationOptions(deps, salt, { id: newBackupUserHandle(), name: label }));
      return guardianResult(await prfAfterCreate(deps, credential, salt, aaguidOf(credential), label));
    }
    case "backup-get": {
      const credential = (await browser(deps, () =>
        deps.credentials.get({
          publicKey: { challenge: challenge(), rpId: deps.rpId, userVerification: "required", extensions: { prf: { eval: { first: salt } } } },
        }),
      )) as Cred | null;
      if (!credential) return refuse({ name: "NotAllowedError", quick: false });
      return guardianResult(takePrf(credential) ?? refuse({ name: "PrfUnsupported" }));
    }
  }
}
