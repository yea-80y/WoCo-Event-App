/**
 * "Make this device the main one" (#746 step 4, Fable consult 7). Loaded lazily.
 *
 * The account's owner is the main passkey's key. Moving that to a linked device is
 * one sponsored userOp from the account (`rotateOwnerSelf`), and it ends every
 * grant the old main signed - so the new main signs fresh ones for the old main and
 * every other device FIRST, and the old main only rotates once it holds them:
 *
 *   linked device (new main)          main (old main)
 *   offer  {parent, itself}  ------>  checks it is a live device of this account
 *                                     person confirms; passkey sheet
 *                           <------  answer {itself, the other devices}
 *   signs a grant for each
 *   reply  {grants}          ------>  checks every grant: signed by the new main,
 *                                     for exactly those devices
 *                                     writes its own envelope (it becomes a linked
 *                                     device, so it signs in like one everywhere)
 *                                     rotates; becomes a linked device here
 *   sees itself the owner             registers the grants, old main first
 *   on chain; becomes the owner;
 *   registers them too (a repeat is "done")
 *
 * Both devices keep the grants until they are registered, and finish at their next
 * sign-in or Your passkeys visit. Grants signed for a rotation that never happened
 * are dropped once the code has expired: they must not re-add a device later.
 * Ownership is only ever read from the chain, never from the server's session rank,
 * which lags a rotation by up to its owner cache.
 */

import { verifyTypedData, type TypedDataField } from "ethers";
import { DEVICE_GRANT_DOMAIN, DEVICE_GRANT_TYPES, PAIRING_TTL_MS } from "@woco/shared";
import type { PairingTransport } from "./pairing-channel.js";
import { makeMainPendingKey } from "./make-main-key.js";
import {
  LINK_CODE_UNKNOWN,
  parseMakeMainAnswer,
  parseMakeMainReply,
  type MakeMainOffer,
  type PairedDevice,
  type SignedGrant,
} from "./device-link.js";

export type SubmitResult = "done" | "later";

/** Grants waiting to be registered, per account, on this device. Statements only. */
export interface PendingMakeMain {
  parent: string;
  newOwner: string;
  previousOwner: string;
  grants: SignedGrant[];
  /** Before the rotation: drop the grants after this if the owner never changed. */
  expiresAt: number | null;
}


export interface PendingStore {
  read(parent: string): PendingMakeMain | null;
  write(p: PendingMakeMain): void;
  clear(parent: string): void;
}

export const localPendingStore: PendingStore = {
  read(parent) {
    try {
      const raw = globalThis.localStorage?.getItem(makeMainPendingKey(parent));
      return raw ? (JSON.parse(raw) as PendingMakeMain) : null;
    } catch {
      return null;
    }
  },
  write(p) {
    try {
      globalThis.localStorage?.setItem(makeMainPendingKey(p.parent), JSON.stringify(p));
    } catch {
      /* the other device registers them too */
    }
  },
  clear(parent) {
    try {
      globalThis.localStorage?.removeItem(makeMainPendingKey(parent));
    } catch {
      /* nothing to clear */
    }
  },
};

const types = DEVICE_GRANT_TYPES as unknown as Record<string, TypedDataField[]>;

function signerOf(g: SignedGrant): string | null {
  try {
    return verifyTypedData(DEVICE_GRANT_DOMAIN, types, g.grant, g.grantSig).toLowerCase();
  } catch {
    return null;
  }
}

/** Exactly one grant per expected device, each for this account, each signed by `newOwner`. */
export function grantsMatch(
  grants: SignedGrant[],
  expected: { parent: string; newOwner: string; devices: PairedDevice[] },
): boolean {
  if (grants.length !== expected.devices.length) return false;
  const want = new Map(expected.devices.map((d) => [d.grantee.toLowerCase(), d.credentialTag.toLowerCase()]));
  const seen = new Set<string>();
  for (const g of grants) {
    const grantee = g.grant.grantee.toLowerCase();
    if (g.grant.parent !== expected.parent.toLowerCase()) return false;
    if (want.get(grantee) !== g.grant.credentialTag.toLowerCase() || seen.has(grantee)) return false;
    if (signerOf(g) !== expected.newOwner.toLowerCase()) return false;
    seen.add(grantee);
  }
  return true;
}

/** Register what is still waiting, in order; keep what did not land. */
async function submitAll(
  pending: PendingMakeMain,
  submit: (g: SignedGrant) => Promise<SubmitResult>,
  store: PendingStore,
): Promise<boolean> {
  const left: SignedGrant[] = [];
  for (const g of pending.grants) {
    let r: SubmitResult = "later";
    try {
      r = await submit(g);
    } catch {
      r = "later";
    }
    if (r === "later") left.push(g);
  }
  if (left.length === 0) {
    store.clear(pending.parent);
    return true;
  }
  store.write({ ...pending, grants: left });
  return false;
}

/**
 * Finish what a make-main left on this device. The chain says whether the rotation
 * happened: if it did, register the grants; if it did not and the code expired,
 * drop them. Returns true when nothing is left.
 */
export async function resumeMakeMain(deps: {
  parent: string;
  readOwner: (parent: string) => Promise<string | null | "error">;
  submit: (g: SignedGrant) => Promise<SubmitResult>;
  /** This device's own side of a rotation it did not see land (owner or device). */
  settle?: (pending: PendingMakeMain) => Promise<void>;
  store?: PendingStore;
  now?: () => number;
}): Promise<boolean> {
  const store = deps.store ?? localPendingStore;
  const pending = store.read(deps.parent);
  if (!pending) return true;
  const owner = await deps.readOwner(pending.parent);
  if (owner === "error") return false;
  if (owner === pending.newOwner.toLowerCase()) {
    await deps.settle?.(pending);
    return submitAll(pending, deps.submit, store);
  }
  if (pending.expiresAt !== null && (deps.now ?? Date.now)() > pending.expiresAt) {
    store.clear(pending.parent);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The linked device that becomes the main one
// ---------------------------------------------------------------------------

export interface MakeThisDeviceMainOptions {
  onCode: (code: { typed: string; qr: string }) => void;
  onStep?: (step: "waiting" | "signing" | "finishing") => void;
  signal?: AbortSignal;
}

export interface MakeThisDeviceMainDeps {
  apiBase: string;
  parent: string;
  self: string;
  selfTag: string;
  /** Grants for these devices, signed raw by this device's own key. */
  signGrants: (devices: PairedDevice[]) => Promise<SignedGrant[]>;
  readOwner: (parent: string) => Promise<string | null | "error">;
  becomeOwner: () => Promise<void>;
  submit: (g: SignedGrant) => Promise<SubmitResult>;
  transport?: PairingTransport;
  store?: PendingStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runMakeThisDeviceMain(
  opts: MakeThisDeviceMainOptions,
  deps: MakeThisDeviceMainDeps,
): Promise<{ registered: boolean }> {
  const store = deps.store ?? localPendingStore;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const parent = deps.parent.toLowerCase();
  const self = deps.self.toLowerCase();
  const ch = await import("./pairing-channel.js");
  const code = ch.newPairingCode();
  const channel = ch.pairingChannel(code);
  const transport = deps.transport ?? ch.httpPairingTransport(deps.apiBase);
  const deadline = now() + PAIRING_TTL_MS;

  await transport.post(
    channel.id,
    "offer",
    await channel.seal("offer", { v: 1, kind: "make-main", parent, grantee: self, credentialTag: deps.selfTag }),
  );
  opts.onCode({ typed: ch.formatPairingCode(code), qr: ch.pairingQrPayload(code) });
  opts.onStep?.("waiting");
  const answer = parseMakeMainAnswer(
    await channel.open("answer", await ch.waitForSlot(transport, channel.id, "answer", { signal: opts.signal, sleep })).catch(() => null),
  );
  if (!answer || answer.previous.grantee === self || answer.devices.some((d) => d.grantee === self)) {
    throw new Error(LINK_CODE_UNKNOWN);
  }

  opts.onStep?.("signing");
  // The old main first: it is the device the person is holding.
  const grants = await deps.signGrants([answer.previous, ...answer.devices]);
  const pending: PendingMakeMain = { parent, newOwner: self, previousOwner: answer.previous.grantee, grants, expiresAt: deadline };
  store.write(pending);
  await transport.post(channel.id, "reply", await channel.seal("reply", { v: 1, kind: "make-main", grants }));

  opts.onStep?.("finishing");
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const owner = await deps.readOwner(parent);
    if (owner === self) break;
    if (now() > deadline) {
      // Never rotated: these grants must not re-add a device later.
      store.clear(parent);
      throw new Error("Your other device didn't finish, so nothing changed. Start again when you're ready.");
    }
    await sleep(3_000);
  }
  await deps.becomeOwner();
  return { registered: await submitAll({ ...pending, expiresAt: null }, deps.submit, store) };
}

// ---------------------------------------------------------------------------
// The main passkey handing over
// ---------------------------------------------------------------------------

export interface ApproveMakeMainContext {
  apiBase: string;
  parent: string;
  self: string;
  selfTag: string;
  /** This account's live linked devices, as this browser verified them. */
  devices: PairedDevice[];
  writeOwnEnvelope: () => Promise<void>;
  rotate: (newOwner: string) => Promise<void>;
  becomeDevice: () => Promise<void>;
  submit: (g: SignedGrant) => Promise<SubmitResult>;
  onStep?: (step: "waiting" | "changing" | "finishing") => void;
  transport?: PairingTransport;
  store?: PendingStore;
  sleep?: (ms: number) => Promise<void>;
}

/** Throws with the reason, in words, if the offer is not one this account can act on. */
export function checkMakeMainOffer(offer: MakeMainOffer, ctx: { parent: string; self: string; devices: PairedDevice[] }): void {
  if (offer.parent !== ctx.parent.toLowerCase()) {
    throw new Error("That device is linked to a different account.");
  }
  if (offer.grantee === ctx.self.toLowerCase()) {
    throw new Error("That code is from this device. Scan the one on the other device.");
  }
  const device = ctx.devices.find((d) => d.grantee.toLowerCase() === offer.grantee);
  if (!device || device.credentialTag.toLowerCase() !== offer.credentialTag) {
    throw new Error("That device isn't linked to this account. Link it first, then make it the main passkey.");
  }
}

export async function runApproveMakeMain(
  code: Uint8Array,
  offer: MakeMainOffer,
  ctx: ApproveMakeMainContext,
): Promise<{ registered: boolean }> {
  checkMakeMainOffer(offer, ctx);
  const store = ctx.store ?? localPendingStore;
  const parent = ctx.parent.toLowerCase();
  const ch = await import("./pairing-channel.js");
  const channel = ch.pairingChannel(code);
  const transport = ctx.transport ?? ch.httpPairingTransport(ctx.apiBase);
  const previous: PairedDevice = { grantee: ctx.self.toLowerCase(), credentialTag: ctx.selfTag };
  const devices = ctx.devices
    .filter((d) => d.grantee.toLowerCase() !== offer.grantee)
    .map((d) => ({ grantee: d.grantee.toLowerCase(), credentialTag: d.credentialTag.toLowerCase() }));

  await transport.post(channel.id, "answer", await channel.seal("answer", { v: 1, kind: "make-main", previous, devices }));
  ctx.onStep?.("waiting");
  const reply = parseMakeMainReply(
    await channel.open("reply", await ch.waitForSlot(transport, channel.id, "reply", { sleep: ctx.sleep })).catch(() => null),
  );
  if (!reply || !grantsMatch(reply.grants, { parent, newOwner: offer.grantee, devices: [previous, ...devices] })) {
    throw new Error(LINK_CODE_UNKNOWN);
  }

  ctx.onStep?.("changing");
  // Its own envelope first: once it is a linked device, that is how it signs in on
  // every device its passkey syncs to. Nothing irreversible has happened yet.
  await ctx.writeOwnEnvelope();
  // Kept before the rotation, so a confirm that cannot be read still leaves them
  // here; they expire only if the owner never changed.
  const pending: PendingMakeMain = {
    parent,
    newOwner: offer.grantee,
    previousOwner: previous.grantee,
    grants: reply.grants,
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
  store.write(pending);
  await ctx.rotate(offer.grantee);
  const landed = { ...pending, expiresAt: null };
  store.write(landed);
  await ctx.becomeDevice();
  ctx.onStep?.("finishing");
  return { registered: await submitAll(landed, ctx.submit, store) };
}

// ---------------------------------------------------------------------------
// Wiring to the auth store (`_makeMainHost`): what needs its state comes in, the
// rest - grants, the list, the envelope, the chain - is read and written here.
// ---------------------------------------------------------------------------

export interface MakeMainHost {
  apiBase: string;
  account: () => { passkey: boolean; parent: string | null; self: string | null; device: boolean; session: boolean };
  /** This device's own raw key; may show the passkey sheet. */
  ownKey: () => Promise<string | null>;
  /** A passkey sheet now, whatever the unlock window says. */
  freshMainPasskey: () => Promise<void>;
  unlocked: () => { seed: string | null; prf: string | null };
  kernel: () => Promise<import("./kernel-account.js").BuiltKernel | null>;
  signGrant: (key: string, parent: string, grantee: string, credentialTag: string) => Promise<SignedGrant>;
  becomeOwner: (self: string, parent: string) => Promise<void>;
  becomeDevice: (self: string, parent: string) => Promise<void>;
  lockedMessage: () => string;
}

/** This device's own passkey, as the hash a grant names it by. */
async function ownCredentialTag(): Promise<string> {
  const { StorageKeys, credentialTagOf } = await import("@woco/shared");
  const { getKV } = await import("./storage/indexeddb.js");
  const pinned = await getKV<{ credentialId?: string }>(StorageKeys.PASSKEY_CREDENTIAL);
  if (!pinned?.credentialId) throw new Error("This device's passkey isn't recorded here. Sign out and in again first.");
  const { credentialIdBytes } = await import("./passkey-record.js");
  return credentialTagOf(credentialIdBytes(pinned.credentialId));
}

export async function submitGrant(g: SignedGrant): Promise<SubmitResult> {
  const { registerDeviceGrant } = await import("../api/device-grants.js");
  const res = await registerDeviceGrant(g.grant, g.grantSig);
  // A repeat - the other device registered the same statement first - is done too.
  return res.ok || res.code === "nonce-used" ? "done" : "later";
}

async function readOwner(parent: string): Promise<string | null | "error"> {
  const { readKernelEcdsaOwnerStrict } = await import("./kernel-account.js");
  return readKernelEcdsaOwnerStrict(parent);
}

export async function makeThisDeviceMain(opts: MakeThisDeviceMainOptions, host: MakeMainHost): Promise<{ registered: boolean }> {
  const { passkey, parent, self, device } = host.account();
  if (!passkey || !device || !parent || !self) throw new Error("This device is already the main passkey.");
  return runMakeThisDeviceMain(opts, {
    apiBase: host.apiBase,
    parent,
    self,
    selfTag: await ownCredentialTag(),
    signGrants: async (devices) => {
      const key = await host.ownKey();
      if (!key || host.account().self !== self) throw new Error(host.lockedMessage());
      const out: SignedGrant[] = [];
      for (const d of devices) out.push(await host.signGrant(key, parent, d.grantee, d.credentialTag));
      return out;
    },
    readOwner,
    becomeOwner: () => host.becomeOwner(self, parent),
    submit: submitGrant,
  });
}

export async function approveMakeMain(
  code: Uint8Array,
  offer: MakeMainOffer,
  host: MakeMainHost,
  onStep?: (step: "waiting" | "changing" | "finishing") => void,
): Promise<{ registered: boolean }> {
  await host.freshMainPasskey();
  const { parent, self } = host.account();
  const { seed, prf } = host.unlocked();
  if (!parent || !self || !seed || !prf) throw new Error(host.lockedMessage());
  const { listDeviceGrants } = await import("../api/device-grants.js");
  const { verifyDeviceGrantList } = await import("./device-grant-verify.js");
  const listed = await listDeviceGrants();
  if (!listed.ok || !listed.data) throw new Error("Couldn't load your passkeys - try again.");
  const devices = verifyDeviceGrantList(listed.data.grants, { parent, owner: self }).filter((d) => d.removedAt === null);
  return runApproveMakeMain(code, offer, {
    apiBase: host.apiBase,
    parent,
    self,
    selfTag: await ownCredentialTag(),
    devices,
    onStep,
    writeOwnEnvelope: async () => {
      const { writePortabilityEnvelope } = await import("./recovery-portability.js");
      await writePortabilityEnvelope({ prfSecret: prf, preservedKernelAddress: parent, identitySeed: seed });
    },
    rotate: async (newOwner) => {
      const kernel = await host.kernel();
      if (!kernel) throw new Error(host.lockedMessage());
      const { rotateOwnerSelf } = await import("./kernel-account.js");
      await rotateOwnerSelf(kernel, newOwner);
    },
    becomeDevice: () => host.becomeDevice(self, parent),
    submit: submitGrant,
  });
}

/** Resume at sign-in or on Your passkeys. Never mints a session: on a passkey that
 *  can be a sheet at page open, so without one the grants wait. */
export async function resumeForHost(host: MakeMainHost): Promise<boolean> {
  const { passkey, parent, self, session } = host.account();
  if (!passkey || !parent || !self) return true;
  return resumeMakeMain({
    parent,
    readOwner,
    submit: async (g) => (session ? submitGrant(g) : "later"),
    settle: async (pending) => {
      if (pending.newOwner === self) await host.becomeOwner(self, parent);
      else if (pending.previousOwner === self) await host.becomeDevice(self, parent);
    },
  });
}
