/**
 * Linking another device (#746 step 4, Fable consult 7): the new device shows a
 * code, the main device scans it. Loaded lazily - only these two flows need it.
 *
 * The messages, inside the pairing channel's sealed boxes (`pairing-channel.ts`):
 *   offer   (device being linked)  its passkey's address, the hash of its
 *                                  credential id, and a key that lives for this
 *                                  one pairing. Nothing about the device itself:
 *                                  the main shows only what it knows.
 *   answer  (main)                 the account and its seed, sealed to that key,
 *                                  sent after the main registered the grant.
 * Making a linked device the main passkey (`make-main.ts`) uses the same channel:
 *   offer   (the linked device)    the account and its own passkey;
 *   answer  (main)                 its own passkey and the account's other devices;
 *   reply   (the linked device)    grants for all of them, signed by its own key -
 *                                  so they exist before the main hands over the
 *                                  account (Fable consult 7).
 * What a message may change is decided by the grant's signature and the server's
 * grant list, never by the message.
 *
 * The parts that need the auth store's state (signing in, the owner's key, the
 * grant) are passed in by `auth-store.svelte.ts`; so are the transport and the
 * passkey, which is what lets the tests run both halves against each other.
 */

import {
  MAX_DEVICE_GRANTS,
  credentialTagOf,
  parseDeviceGrant,
  type DeviceGrantMessage,
  type PasskeyProviderId,
} from "@woco/shared";
import {
  asCeremonyCancel,
  createAddedPasskey,
  passkeyHandleOnThisOrigin,
  pinPasskeyCredential,
  restorePasskeyAccount,
  type PasskeyLogin,
} from "./passkey-account.js";
import { credentialIdBytes } from "./passkey-record.js";
import { linkedEnvelopePendingKey } from "./make-main-key.js";
import type { LinkSecret, PairingTransport } from "./pairing-channel.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const XWING_PK_HEX = /^[0-9a-f]{2432}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;

export interface LinkOffer {
  v: 1;
  kind: "link";
  grantee: string;
  credentialTag: string;
  recipientPk: string;
}

export interface LinkAnswer {
  v: 1;
  kind: "link";
  sealed: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function parseLinkOffer(v: unknown): LinkOffer | null {
  if (!isObject(v) || v.v !== 1 || v.kind !== "link") return null;
  const { grantee, credentialTag, recipientPk } = v;
  if (typeof grantee !== "string" || !ADDRESS.test(grantee)) return null;
  if (typeof credentialTag !== "string" || !BYTES32.test(credentialTag)) return null;
  if (typeof recipientPk !== "string" || !XWING_PK_HEX.test(recipientPk)) return null;
  return { v: 1, kind: "link", grantee, credentialTag, recipientPk };
}

export interface MakeMainOffer {
  v: 1;
  kind: "make-main";
  parent: string;
  grantee: string;
  credentialTag: string;
}

export interface PairedDevice {
  grantee: string;
  credentialTag: string;
}

export interface MakeMainAnswer {
  v: 1;
  kind: "make-main";
  /** The main passkey, which becomes a linked device. */
  previous: PairedDevice;
  /** Every other live device, to be granted again by the new main. */
  devices: PairedDevice[];
}

export interface SignedGrant {
  grant: DeviceGrantMessage;
  grantSig: string;
}

export interface MakeMainReply {
  v: 1;
  kind: "make-main";
  grants: SignedGrant[];
}

export type PairingOffer = LinkOffer | MakeMainOffer;

function parseDevice(v: unknown): PairedDevice | null {
  if (!isObject(v)) return null;
  const { grantee, credentialTag } = v;
  if (typeof grantee !== "string" || !ADDRESS.test(grantee)) return null;
  if (typeof credentialTag !== "string" || !BYTES32.test(credentialTag)) return null;
  return { grantee, credentialTag };
}

export function parseMakeMainOffer(v: unknown): MakeMainOffer | null {
  if (!isObject(v) || v.v !== 1 || v.kind !== "make-main") return null;
  const device = parseDevice(v);
  if (!device || typeof v.parent !== "string" || !ADDRESS.test(v.parent)) return null;
  return { v: 1, kind: "make-main", parent: v.parent, ...device };
}

export function parsePairingOffer(v: unknown): PairingOffer | null {
  return parseLinkOffer(v) ?? parseMakeMainOffer(v);
}

export function parseMakeMainAnswer(v: unknown): MakeMainAnswer | null {
  if (!isObject(v) || v.v !== 1 || v.kind !== "make-main" || !Array.isArray(v.devices)) return null;
  if (v.devices.length >= MAX_DEVICE_GRANTS) return null;
  const previous = parseDevice(v.previous);
  const devices = v.devices.map(parseDevice);
  if (!previous || devices.some((d) => d === null)) return null;
  return { v: 1, kind: "make-main", previous, devices: devices as PairedDevice[] };
}

export function parseMakeMainReply(v: unknown): MakeMainReply | null {
  if (!isObject(v) || v.v !== 1 || v.kind !== "make-main" || !Array.isArray(v.grants)) return null;
  if (v.grants.length > MAX_DEVICE_GRANTS) return null;
  const grants: SignedGrant[] = [];
  for (const g of v.grants) {
    if (!isObject(g) || typeof g.grantSig !== "string" || !SIG.test(g.grantSig)) return null;
    const grant = parseDeviceGrant(g.grant);
    if (!grant) return null;
    grants.push({ grant, grantSig: g.grantSig });
  }
  return { v: 1, kind: "make-main", grants };
}

export function parseLinkAnswer(v: unknown): LinkAnswer | null {
  if (!isObject(v) || v.v !== 1 || v.kind !== "link" || !isObject(v.sealed)) return null;
  return { v: 1, kind: "link", sealed: v.sealed };
}

export const LINK_CODE_UNREADABLE = "That isn't a WoCo code. Scan the code on the other device, or type it in.";
export const LINK_CODE_UNKNOWN = "The other device sent something this one doesn't understand. Update WoCo on both and start again.";

// ---------------------------------------------------------------------------
// The new device
// ---------------------------------------------------------------------------

/** This tab's passkey for a link still in progress, so a reload asks for the same
 *  one again instead of making a second. Its id only - never key material. */
const PAIRING_CREDENTIAL_KEY = "woco:pairing-credential";

type PairingCredential = { credentialId: string; provider?: PasskeyProviderId };

function readPairingCredential(): PairingCredential | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PAIRING_CREDENTIAL_KEY);
    const v = raw ? (JSON.parse(raw) as { credentialId?: unknown; provider?: unknown }) : null;
    return v && typeof v.credentialId === "string"
      ? { credentialId: v.credentialId, ...(typeof v.provider === "string" ? { provider: v.provider as PasskeyProviderId } : {}) }
      : null;
  } catch {
    return null;
  }
}

function writePairingCredential(v: PairingCredential | null): void {
  try {
    if (v) globalThis.sessionStorage?.setItem(PAIRING_CREDENTIAL_KEY, JSON.stringify(v));
    else globalThis.sessionStorage?.removeItem(PAIRING_CREDENTIAL_KEY);
  } catch {
    /* without storage a reload makes a new passkey - the old one stays unused */
  }
}

export type LinkingPasskey = PasskeyLogin & { provider?: PasskeyProviderId };

/** The passkey this device links with: the one this tab already made, else a new one. */
export async function pairingPasskey(): Promise<LinkingPasskey> {
  const pending = readPairingCredential();
  if (pending) {
    try {
      const material = await restorePasskeyAccount({
        retryDiscoverable: false,
        credential: passkeyHandleOnThisOrigin(pending.credentialId, pending.provider),
      });
      return { ...material, credentialId: pending.credentialId, provider: pending.provider, handleKind: "added", attachment: "platform" };
    } catch (e) {
      // Declined, or gone from the manager: either way the next try makes a new one,
      // and this one never opens a second sheet.
      writePairingCredential(null);
      throw asCeremonyCancel(e);
    }
  }
  const added = await createAddedPasskey({
    exclude: [],
    createdOn: new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
  });
  writePairingCredential({ credentialId: added.credentialId, provider: added.provider });
  return { ...added, handleKind: "added", attachment: "platform" };
}

export interface LinkThisDeviceOptions {
  onCode: (code: { typed: string; qr: string }) => void;
  onStep?: (step: "creating" | "waiting" | "linking") => void;
  signal?: AbortSignal;
}

export interface LinkThisDeviceDeps {
  apiBase: string;
  /** Sign in as a device of `secret.parent` - the server's verdict decides. */
  signIn: (account: LinkingPasskey, secret: LinkSecret) => Promise<void>;
  transport?: PairingTransport;
  passkey?: () => Promise<LinkingPasskey>;
  /** After the sign-in: pin the passkey here, write its envelope, record and label. */
  settle?: (account: LinkingPasskey, secret: LinkSecret, credentialTag: string) => Promise<void>;
}

export async function runLinkThisDevice(opts: LinkThisDeviceOptions, deps: LinkThisDeviceDeps): Promise<void> {
  opts.onStep?.("creating");
  const account = await (deps.passkey ?? pairingPasskey)();
  const ch = await import("./pairing-channel.js");
  const code = ch.newPairingCode();
  const channel = ch.pairingChannel(code);
  const transport = deps.transport ?? ch.httpPairingTransport(deps.apiBase);
  const recipient = ch.newPairingRecipient();
  const grantee = account.address.toLowerCase();
  const credentialTag = credentialTagOf(credentialIdBytes(account.credentialId));
  try {
    // Posted before the code is shown: the slot is write-once, so nobody who sees
    // the code can file an offer under it first.
    await transport.post(
      channel.id,
      "offer",
      await channel.seal("offer", { v: 1, kind: "link", grantee, credentialTag, recipientPk: recipient.publicKeyHex }),
    );
    opts.onCode({ typed: ch.formatPairingCode(code), qr: ch.pairingQrPayload(code) });
    opts.onStep?.("waiting");
    const box = await ch.waitForSlot(transport, channel.id, "answer", { signal: opts.signal });
    opts.onStep?.("linking");
    // Anything that does not open is not from the main device - one message for all of it.
    const answer = parseLinkAnswer(await channel.open("answer", box).catch(() => null));
    const secret = answer
      ? await ch.openLinkSecret(recipient, answer.sealed, { id: channel.id, grantee }).catch(() => null)
      : null;
    if (!secret) throw new Error(LINK_CODE_UNKNOWN);
    recipient.forget();
    await deps.signIn(account, secret);
    writePairingCredential(null);
    await (deps.settle ?? settleLinkedPasskey)(account, secret, credentialTag);
  } finally {
    recipient.forget();
  }
}

/** Best-effort past the sign-in: the device already works without any of these. */
async function settleLinkedPasskey(account: LinkingPasskey, secret: LinkSecret, credentialTag: string): Promise<void> {
  await pinPasskeyCredential(passkeyHandleOnThisOrigin(account.credentialId, account.provider));
  // Its own envelope, so it signs in wherever its manager syncs. Awaited (Fable
  // consult 7); if it fails, the back-fill retries it with the next session.
  try {
    const { writePortabilityEnvelope } = await import("./recovery-portability.js");
    await writePortabilityEnvelope({ prfSecret: account.prfSecret, preservedKernelAddress: secret.parent, identitySeed: secret.seed });
  } catch (e) {
    // Retried at the next sign-in (`_retryLinkedEnvelope`); until then this passkey
    // signs in on this device only.
    console.warn("[auth] linked passkey's envelope not written yet (retried at next sign-in):", e);
    try {
      globalThis.localStorage?.setItem(linkedEnvelopePendingKey(account.address), "1");
    } catch {
      /* without storage it waits for a session mint, where the back-fill also runs */
    }
  }
  try {
    const { writePasskeyRecord } = await import("./passkey-record.js");
    const { passkeyRecordCommit } = await import("@woco/shared/auth/passkey-record");
    const id = credentialIdBytes(account.credentialId);
    await writePasskeyRecord(id, { v: 1, kind: "added", commit: passkeyRecordCommit(secret.parent, id) });
  } catch (e) {
    console.warn("[auth] linked passkey's record not written (non-fatal):", e);
  }
  const { writePasskeyMeta } = await import("./passkey-meta.js");
  await writePasskeyMeta(secret.parent, credentialTag, {
    provider: account.provider ?? "unknown",
    addedAt: Date.now(),
    credentialId: account.credentialId,
  }).catch((e) => console.warn("[auth] linked passkey's label not kept (non-fatal):", e));
}

// ---------------------------------------------------------------------------
// The main device
// ---------------------------------------------------------------------------

/** The offer behind a scanned or typed code, for the person to confirm. Reads only. */
export async function readPairingOffer(
  input: string,
  deps: { apiBase: string; transport?: PairingTransport },
): Promise<{ code: Uint8Array; offer: PairingOffer }> {
  const ch = await import("./pairing-channel.js");
  const code = ch.parsePairingCode(input);
  if (!code) throw new Error(LINK_CODE_UNREADABLE);
  const channel = ch.pairingChannel(code);
  const box = await (deps.transport ?? ch.httpPairingTransport(deps.apiBase)).read(channel.id, "offer");
  if (box === null || box === "gone") throw new ch.PairingExpiredError();
  const offer = parsePairingOffer(await channel.open("offer", box).catch(() => null));
  if (!offer) throw new Error(LINK_CODE_UNKNOWN);
  return { code, offer };
}

export interface ApproveDeviceLinkContext {
  apiBase: string;
  parent: string;
  /** This passkey's own address: a code from this device is refused. */
  self: string;
  seed: string;
  /** Owner-signed grant for the new passkey, registered with the server. */
  grant: (grantee: string, credentialTag: string) => Promise<unknown>;
  /** Take that grant back when the answer certainly never reached the other device. */
  revoke: (grantee: string) => Promise<unknown>;
  transport?: PairingTransport;
}

/** Grant first, so the new device's sign-in finds it; then the sealed answer. */
export async function runApproveDeviceLink(
  code: Uint8Array,
  offer: LinkOffer,
  ctx: ApproveDeviceLinkContext,
): Promise<void> {
  if (offer.grantee === ctx.self.toLowerCase() || offer.grantee === ctx.parent.toLowerCase()) {
    throw new Error("That code is from this device. Scan the one on the other device.");
  }
  await ctx.grant(offer.grantee, offer.credentialTag);
  const ch = await import("./pairing-channel.js");
  const channel = ch.pairingChannel(code);
  const sealed = await ch.sealLinkSecret(
    offer.recipientPk,
    { parent: ctx.parent, seed: ctx.seed },
    { id: channel.id, grantee: offer.grantee },
  );
  try {
    await (ctx.transport ?? ch.httpPairingTransport(ctx.apiBase)).post(
      channel.id,
      "answer",
      await channel.seal("answer", { v: 1, kind: "link", sealed }),
    );
  } catch (e) {
    if (e instanceof ch.PairingExpiredError) {
      // Certainly not delivered: a grant for a passkey that will never sign in is a
      // slot taken and a row that lies. Best effort - it can be removed by hand.
      await ctx.revoke(offer.grantee).catch(() => {});
      throw new Error("The other device's code expired before it could finish. Nothing was linked - start again there.");
    }
    // Maybe delivered: the other device may be signing in now.
    throw new Error("Couldn't reach the other device. If it doesn't finish linking, remove it from Your passkeys.");
  }
}
