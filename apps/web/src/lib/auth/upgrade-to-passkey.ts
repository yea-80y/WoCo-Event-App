/**
 * Upgrade an email or Google account to a passkey, in place (#746).
 *
 * Design: Fable consult 10-07 (build with changes); owner decisions 10-07 - every
 * email account is offered it, locked ones included (one sponsored op, the server's
 * `upgrade` shape); likes and follows MOVE - retracted under the old feed signer
 * before the switch, re-posted under the new one after; a referral statement is
 * re-signed. The account keeps its address, so its tickets, names, unlock and
 * followers stay: they are keyed by the account, never by a key.
 *
 * What changes is who controls it, and the seed under it:
 *  - ONE sponsored op, signed by the email key: the co-owner switch to a list of one
 *    key, the passkey's, with the email key's ECDSA validation uninstalled. Any
 *    recovery route (email or wallet backups) is removed first, by its own op.
 *  - the new seed is the passkey's own PRF seed (`passkeyIdentitySeed`): never
 *    derived from, signed by or passed through the email key, and sealed to the
 *    passkey alone (its portability envelope), never to an escrow.
 *  - the old seed sealed nothing an organiser holds - an account that hosts events
 *    or websites is refused, its feed signer being pinned where the money path
 *    reads it - and it leaves the device once the switch has landed.
 *
 * Phases, resumable from a device marker that holds no secret:
 *   prepare  - reads; the passkey ceremony; backups removed; the passkey's binding,
 *              locked seed and envelope (read back); profile and referral copied to
 *              the new feed; the marker; likes and follows retracted.
 *   switch   - the op (the store). A refusal changes nothing past `prepare`: the
 *              same passkey retries it, or `cancelUpgrade` puts it all back.
 *   finalize - the email key's traces leave the device; the marker says "committed".
 *   move     - likes and follows re-posted under the new feed; the marker goes.
 *
 * Pure orchestration over the deps the store lends (co-owner-flows.ts does the
 * same); loaded on the tap.
 */

import { deriveFeedSignerKey, passkeyIdentitySeed, type Hex0x } from "@woco/shared";
import type { PasskeyCredentialHandle } from "./passkey-account.js";
import type { MarkerStore, UpgradeMarker } from "./upgrade-marker.js";

export { localMarkerStore, parseUpgradeMarker, upgradeMarkerKey } from "./upgrade-marker.js";
export type { MarkerStore, UpgradeMarker } from "./upgrade-marker.js";

export type SocialKind = "like" | "follow";

/** A feed signer: the key and the address that owns its feeds. */
export interface FeedKey {
  privKey: string;
  address: string;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const WALLET_ACCOUNT_MESSAGE = "Wallet accounts can't be upgraded - make a separate organiser account.";
export const HOSTS_SOMETHING_MESSAGE =
  "This account already has events or a website, so it can't be upgraded - make a separate organiser account.";
export const LOCKED_DEPLOYED_MESSAGE =
  "This account can't be upgraded until it's unlocked with a ticket - or make a separate organiser account.";
export const NO_PASSKEYS_MESSAGE = "This browser can't make passkeys. Open WoCo in Chrome or Safari to upgrade.";
export const READ_FAILED_MESSAGE = "Couldn't read this account just now - nothing was changed. Try again.";
export const ENVELOPE_FAILED_MESSAGE =
  "Couldn't save your account keys to the new passkey - nothing was changed. Try again.";
export const BACKUPS_FAILED_MESSAGE =
  "Couldn't remove this account's backups just now - your account hasn't changed. Try again.";
export const COPY_FAILED_MESSAGE = "Couldn't copy your profile to the new passkey - nothing was changed. Try again.";
export const RETRACT_FAILED_MESSAGE = "Couldn't move your likes and follows yet - your account hasn't changed. Try again.";
export const SWITCH_FAILED_MESSAGE = "The upgrade didn't go through - your account hasn't changed. Try again in a moment.";

// ---------------------------------------------------------------------------
// Who is offered what (pure)
// ---------------------------------------------------------------------------

export interface PlanInput {
  authKind: string;
  /** Hosts events or websites: yes, no, or could not tell. */
  hostsSomething: boolean | "unknown";
  /** Can its backups come off? Not for a locked account that is deployed: the removal op is
   *  sent for every deployed account, and a locked account is paid for the upgrade op only. */
  backupsRemovable: boolean | "unknown";
  passkeySupported: boolean;
}

export type UpgradeOffer =
  | { kind: "upgrade" }
  /** Only a separate organiser account - with why. */
  | { kind: "separate-only"; reason: string }
  /** Nothing can be decided now - with what to do. */
  | { kind: "unavailable"; reason: string };

export function planUpgrade(i: PlanInput): UpgradeOffer {
  if (i.authKind !== "web3auth") return { kind: "separate-only", reason: WALLET_ACCOUNT_MESSAGE };
  if (i.hostsSomething === true) return { kind: "separate-only", reason: HOSTS_SOMETHING_MESSAGE };
  if (i.backupsRemovable === false) return { kind: "separate-only", reason: LOCKED_DEPLOYED_MESSAGE };
  if (!i.passkeySupported) return { kind: "unavailable", reason: NO_PASSKEYS_MESSAGE };
  if (i.hostsSomething === "unknown" || i.backupsRemovable === "unknown") return { kind: "unavailable", reason: READ_FAILED_MESSAGE };
  return { kind: "upgrade" };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/** The just-made passkey: its key, its PRF output and its credential. */
export interface MintedPasskey {
  address: string;
  privateKey: string;
  prfSecret: string;
  credential: PasskeyCredentialHandle;
}

/** What only this tab holds after `prepare`: never stored, gone with the tab. */
export interface LivePasskey {
  passkey: string;
  privateKey: string;
  prfSecret: string;
  seed: string;
}

/** The profile as the old feed holds it - copied byte for byte. */
export interface ProfileCopy {
  data: unknown | null;
  avatar: unknown | null;
}

export interface SocialDeps {
  readLive(feed: string, kind: SocialKind): Promise<Hex0x[] | "unavailable">;
  /** One statement, read thorough: `null` = none, "unavailable" = no conclusive answer. */
  readStatement(feed: string, kind: SocialKind, subject: Hex0x): Promise<boolean | null | "unavailable">;
  /** True once the statement is written. */
  write(signer: FeedKey, kind: SocialKind, subject: Hex0x, value: boolean): Promise<boolean>;
}

export interface PrepareDeps {
  parent: string;
  emailKey: string;
  marker: MarkerStore;
  social: SocialDeps;
  hostsSomething(): Promise<boolean | "unknown">;
  backupsRemovable(): Promise<boolean | "unknown">;
  /** The account's seed now - the email account's. Null when it is not on the device. */
  oldSeed(): Promise<string | null>;
  readReferrer(feed: string): Promise<Hex0x | null | "unavailable">;
  readProfile(feed: string): Promise<ProfileCopy | null | "unavailable">;
  mintPasskey(): Promise<MintedPasskey>;
  /** Every backup off the account, proven onchain; throws, in words, when not. */
  removeBackups(): Promise<void>;
  putBinding(passkey: string, parent: string): Promise<void>;
  storeLockedSeed(passkey: string, parent: string, seed: string, prfSecret: string): Promise<void>;
  /** Undo the two above, for a prepare that stops before its marker. */
  clearPasskeyState(passkey: string): Promise<void>;
  /** Write the passkey's envelope ({parent, seed}, sealed to its PRF) unless it already says exactly that. */
  writeEnvelope(args: { prfSecret: string; parent: string; seed: string }): Promise<void>;
  /** The envelope as a fresh read opens it, or null. */
  readEnvelope(prfSecret: string): Promise<{ parent: string; seed: string } | null>;
  writeProfile(signer: FeedKey, copy: ProfileCopy): Promise<void>;
  writeReferral(signer: FeedKey, referrer: Hex0x): Promise<void>;
}

/**
 * Everything before the switch up to the marker; `retractOld` is the last step. Throws
 * the words to show; a throw here leaves only a passkey in the person's manager that
 * opens nothing.
 */
export async function prepareUpgrade(
  d: PrepareDeps,
  progress: (msg: string) => void = () => {},
): Promise<{ marker: UpgradeMarker; live: LivePasskey }> {
  const parent = d.parent.toLowerCase();
  const emailKey = d.emailKey.toLowerCase();

  // (1) Reads, all decisive before anything changes.
  progress("Checking your account…");
  const hosts = await d.hostsSomething();
  if (hosts === true) throw new Error(HOSTS_SOMETHING_MESSAGE);
  if (hosts === "unknown") throw new Error(READ_FAILED_MESSAGE);
  // Before the ceremony: otherwise every attempt leaves a passkey that opens nothing.
  const removable = await d.backupsRemovable();
  if (removable === false) throw new Error(LOCKED_DEPLOYED_MESSAGE);
  if (removable === "unknown") throw new Error(READ_FAILED_MESSAGE);
  const oldSeed = await d.oldSeed();
  if (!oldSeed) throw new Error(READ_FAILED_MESSAGE);
  const oldFeed = deriveFeedSignerKey(oldSeed).address.toLowerCase();
  const [likes, follows, referrer, profile] = await Promise.all([
    d.social.readLive(oldFeed, "like"),
    d.social.readLive(oldFeed, "follow"),
    d.readReferrer(oldFeed),
    d.readProfile(oldFeed),
  ]);
  if (likes === "unavailable" || follows === "unavailable" || referrer === "unavailable" || profile === "unavailable") {
    throw new Error(READ_FAILED_MESSAGE);
  }

  // (2) The passkey. Its seed is its own PRF seed and nothing else (PQ invariant 1).
  progress("Create your passkey…");
  const minted = await d.mintPasskey();
  const passkey = minted.address.toLowerCase();
  const seed = passkeyIdentitySeed(minted.prfSecret);
  const newFeed = deriveFeedSignerKey(seed);
  if (passkey === emailKey || seed === oldSeed) throw new Error(READ_FAILED_MESSAGE);

  // (3) Backups off first, by their own op (PQ invariant 3): failure stops here.
  progress("Removing email backups…");
  try {
    await d.removeBackups();
  } catch (e) {
    console.warn("[upgrade] backups not removed:", e);
    throw new Error(BACKUPS_FAILED_MESSAGE);
  }

  // (4) The passkey's hold on the account, before anything points at it: the binding
  // first (everything else keys off it, as at recovery), then its locked seed, then the
  // envelope that opens the account on its other devices - read back, because the
  // switch is what makes it the only way in from them.
  progress("Saving your account keys to your passkey…");
  const undo = async (message: string, e: unknown): Promise<never> => {
    console.warn("[upgrade] prepare stopped, passkey state undone:", e);
    await d.clearPasskeyState(passkey).catch(() => {});
    throw new Error(message);
  };
  try {
    await d.putBinding(passkey, parent);
    await d.storeLockedSeed(passkey, parent, seed, minted.prfSecret);
    await d.writeEnvelope({ prfSecret: minted.prfSecret, parent, seed });
    const back = await d.readEnvelope(minted.prfSecret);
    if (!back || back.parent.toLowerCase() !== parent || back.seed !== seed) throw new Error("envelope read-back differs");
  } catch (e) {
    await undo(ENVELOPE_FAILED_MESSAGE, e);
  }

  // (5) What a reader looks for under the CURRENT feed signer, copied there now: a
  // copy no switch follows is read by nobody, and nothing here can count twice.
  progress("Copying your profile…");
  try {
    if (profile) await d.writeProfile(newFeed, profile);
    if (referrer) await d.writeReferral(newFeed, referrer);
  } catch (e) {
    await undo(COPY_FAILED_MESSAGE, e);
  }

  const marker: UpgradeMarker = {
    v: 1,
    parent,
    emailKey,
    oldFeedSigner: oldFeed,
    passkey,
    credential: minted.credential,
    stage: "prepared",
    likes,
    follows,
    retracted: likes.length === 0 && follows.length === 0,
  };
  d.marker.write(marker);
  return { marker, live: { passkey, privateKey: minted.privateKey, prfSecret: minted.prfSecret, seed } };
}

/**
 * Write `false` under the old feed for every like and follow the marker carries:
 * before the switch, so the account never counts twice. Idempotent - a retry
 * rewrites the same value. Throws until every one is written.
 */
export async function retractOld(
  d: Pick<PrepareDeps, "marker" | "social" | "oldSeed">,
  marker: UpgradeMarker,
  progress: (msg: string) => void = () => {},
): Promise<UpgradeMarker> {
  if (marker.retracted) return marker;
  progress("Moving your likes and follows…");
  const seed = await d.oldSeed();
  if (!seed) throw new Error(RETRACT_FAILED_MESSAGE);
  const oldKey = deriveFeedSignerKey(seed);
  if (oldKey.address.toLowerCase() !== marker.oldFeedSigner) throw new Error(RETRACT_FAILED_MESSAGE);
  const ok = await writeAll(d.social, oldKey, marker, false);
  if (!ok) throw new Error(RETRACT_FAILED_MESSAGE);
  const next = { ...marker, retracted: true };
  d.marker.write(next);
  return next;
}

async function writeAll(social: SocialDeps, signer: FeedKey, m: UpgradeMarker, value: boolean): Promise<boolean> {
  let ok = true;
  for (const [kind, subjects] of [["like", m.likes], ["follow", m.follows]] as const) {
    for (const subject of subjects) {
      if (!(await social.write(signer, kind, subject, value).catch(() => false))) ok = false;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

/** The chain as the switch needs it; `setCoOwners` is bound to the email key's Kernel. */
export interface SwitchChain {
  readKernelRoot(kernel: string): Promise<"ecdsa" | "weighted" | "none" | "error">;
  readKernelSignerFor(kernel: string, eoa: string): Promise<string | null | "error">;
  setCoOwners(root: "ecdsa" | "none", signers: readonly string[]): Promise<{ confirmed: boolean }>;
}

/** Has the switch landed: is the passkey on the account's list? */
export async function switchLanded(c: Pick<SwitchChain, "readKernelSignerFor">, m: UpgradeMarker): Promise<boolean> {
  return (await c.readKernelSignerFor(m.parent, m.passkey).catch(() => "error" as const)) === m.passkey;
}

/**
 * The one op: the co-owner switch whose list is the passkey ALONE - the email key is
 * not kept as a co-owner (any co-owner holds full control), and its ECDSA validation
 * goes in the same batch (PQ invariant 3). A counterfactual account deploys in it.
 * A throw after sending proves nothing either way, so the chain decides; a landed op
 * whose read-back failed is `confirmed: false`, still landed.
 */
export async function sendUpgradeSwitch(c: SwitchChain, m: UpgradeMarker): Promise<{ confirmed: boolean }> {
  if (m.stage !== "prepared" || !m.retracted) throw new Error(SWITCH_FAILED_MESSAGE);
  const root = await c.readKernelRoot(m.parent);
  if (root === "error") throw new Error(SWITCH_FAILED_MESSAGE);
  if (root === "weighted") {
    // Already co-owned: an earlier attempt landed after its tab gave up on it.
    if (await switchLanded(c, m)) return { confirmed: true };
    throw new Error(SWITCH_FAILED_MESSAGE);
  }
  try {
    return { confirmed: (await c.setCoOwners(root, [m.passkey])).confirmed };
  } catch (e) {
    if (await switchLanded(c, m)) return { confirmed: true };
    console.warn("[upgrade] switch not landed:", e);
    throw new Error(SWITCH_FAILED_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Cancel (before the switch only - the store checks the chain first)
// ---------------------------------------------------------------------------

/**
 * Put the email account back as it was: its likes and follows re-posted under the
 * old feed, the passkey's binding and locked seed gone, the marker gone. The passkey
 * stays in the person's manager and opens nothing (its envelope names an account it
 * does not control). Throws, leaving the marker, when the re-post did not finish.
 */
export async function cancelUpgrade(
  d: Pick<PrepareDeps, "marker" | "social" | "oldSeed" | "clearPasskeyState">,
  marker: UpgradeMarker,
): Promise<void> {
  if (marker.stage !== "prepared") throw new Error("This upgrade has already finished.");
  const seed = await d.oldSeed();
  if (!seed) throw new Error(READ_FAILED_MESSAGE);
  const oldKey = deriveFeedSignerKey(seed);
  if (oldKey.address.toLowerCase() !== marker.oldFeedSigner) throw new Error(READ_FAILED_MESSAGE);
  if (!(await writeAll(d.social, oldKey, marker, true))) {
    throw new Error("Couldn't put your likes and follows back yet - try again.");
  }
  await d.clearPasskeyState(marker.passkey);
  d.marker.clear(marker.parent);
}

// ---------------------------------------------------------------------------
// Finalize + move (after the switch has landed)
// ---------------------------------------------------------------------------

export interface FinalizeDeps {
  /** "This email key opens this account no more": refuses the next email sign-in here. */
  tombstoneEmailKey(emailKey: string, parent: string, passkey: string): void;
  /** The old seed and everything derived from it that sits on the device (PQ invariant 2). */
  wipeOldSeed(emailKey: string): Promise<void>;
  /** The email login's fast-path entries and bindings, so nothing signs back in through them. */
  forgetEmailLogin(emailKey: string): Promise<void>;
  /** The passkey's record (credential -> account), written once a session exists. */
  queuePasskeyRecord(credentialId: string, parent: string): void;
}

/** The email account's traces leave the device. Idempotent: a resume runs it again. */
export async function finalizeUpgrade(d: FinalizeDeps & { marker: MarkerStore }, marker: UpgradeMarker): Promise<UpgradeMarker> {
  d.tombstoneEmailKey(marker.emailKey, marker.parent, marker.passkey);
  await d.forgetEmailLogin(marker.emailKey);
  d.queuePasskeyRecord(marker.credential.credentialId, marker.parent);
  await d.wipeOldSeed(marker.emailKey);
  const next: UpgradeMarker = { ...marker, stage: "committed" };
  d.marker.write(next);
  return next;
}

/**
 * Re-post the likes and follows under the account's new feed signer, then drop the
 * marker. Only after the switch, and each only once the OLD feed reads it not-true now:
 * between the retraction and here the old signer may have written it again - a like
 * pressed while the switch was refused, an Undo in another tab - and then it already
 * counts once, there. Unread stays for the next session; it is never posted blind.
 * False when anything is still outstanding.
 */
export async function moveSocial(
  d: { marker: MarkerStore; social: SocialDeps },
  marker: UpgradeMarker,
  newKey: FeedKey,
): Promise<boolean> {
  if (marker.stage !== "committed" || !marker.retracted) return false;
  const left: UpgradeMarker = { ...marker, likes: [], follows: [] };
  for (const kind of ["like", "follow"] as const) {
    for (const subject of kind === "like" ? marker.likes : marker.follows) {
      const old = await d.social.readStatement(marker.oldFeedSigner, kind, subject).catch(() => "unavailable" as const);
      if (old === true) continue;
      const moved = old !== "unavailable" && (await d.social.write(newKey, kind, subject, true).catch(() => false));
      if (!moved) (kind === "like" ? left.likes : left.follows).push(subject);
    }
  }
  if (left.likes.length === 0 && left.follows.length === 0) {
    d.marker.clear(marker.parent);
    return true;
  }
  d.marker.write(left);
  return false;
}

// ---------------------------------------------------------------------------
// Runners - the store calls these with what it lends (co-owner-flows.ts's pattern)
// ---------------------------------------------------------------------------

/** What the auth store lends: its state, and the steps only it can take. */
export interface UpgradeStoreHost {
  /** The signed-in email account, or null for any other kind. */
  emailAccount(): { parent: string; emailKey: string; keyReady: boolean } | null;
  /** The signed-in passkey account, or null for any other kind. */
  passkeyAccount(): { parent: string; passkey: string; hasSession: boolean } | null;
  keyMissing(): Error;
  ensureSession(): Promise<boolean>;
  oldSeed(): Promise<string | null>;
  removeBackups(): Promise<void>;
  putBinding(passkey: string, parent: string): Promise<void>;
  clearBinding(passkey: string): Promise<void>;
  readSignerFor(kernel: string, eoa: string): Promise<string | null | "error">;
  /** The chain, with `setCoOwners` signed by the email key's Kernel. */
  emailKernel(): Promise<SwitchChain>;
  /** This device opens the account with the passkey: binding, pin, identity keys, in-memory state. */
  adoptPasskey(marker: UpgradeMarker, live: LivePasskey | null, confirmed: boolean): Promise<void>;
  finalizeDeps(): FinalizeDeps;
  /** End the Web3Auth session, then the API session the email key signed - LAST. */
  endEmailSession(): Promise<void>;
  feedKeyIfPresent(): Promise<FeedKey | null>;
  /** Mint the passkey's session, then resume through the store's one single-flight path. */
  resumeLater(): void;
}

/** The I/O the runners build their steps from: live, or a test's. */
export interface UpgradeIO {
  marker: MarkerStore;
  prepareDeps(account: { parent: string; emailKey: string }): Promise<PrepareDeps>;
  social(): Promise<SocialDeps>;
}

export const NO_SESSION_MESSAGE = "Couldn't reach WoCo just now - nothing was changed. Try again.";
export const ALREADY_LANDED_MESSAGE = "The upgrade has already gone through - finish it to open the account with your passkey.";

/** This tab's just-made passkey, for the commit: never stored, gone with the tab. */
let liveInTab: LivePasskey | null = null;

/** Start an upgrade, or pick up the one this device prepared. Throws the words to show. */
export async function runUpgrade(h: UpgradeStoreHost, io: UpgradeIO, progress: (msg: string) => void = () => {}): Promise<void> {
  const account = h.emailAccount();
  if (!account) throw new Error("Only an email or Google account can be upgraded.");
  if (!account.keyReady) throw h.keyMissing();
  // Every step signs requests with the email key's session: made first, never mid-flow.
  if (!(await h.ensureSession())) throw new Error(NO_SESSION_MESSAGE);
  const deps = await io.prepareDeps(account);
  let marker = io.marker.read(account.parent);
  if (marker && (marker.emailKey !== account.emailKey || marker.stage !== "prepared")) marker = null;
  if (!marker) {
    const prepared = await prepareUpgrade(deps, progress);
    marker = prepared.marker;
    liveInTab = prepared.live;
  }
  marker = await retractOld(deps, marker, progress);
  progress("Handing your account to your passkey…");
  const { confirmed } = await sendUpgradeSwitch(await h.emailKernel(), marker);
  await commitUpgrade(h, io, marker, liveInTab?.passkey === marker.passkey ? liveInTab : null, confirmed);
  liveInTab = null;
  h.resumeLater();
}

/**
 * The switch has landed. As `recoverAndRekey`'s commit: the passkey's state first
 * (binding and locked seed are down since prepare), the email key's traces out, and
 * the session the email key signed killed LAST - before that, a concurrent mint would
 * sign under a key the account no longer has.
 */
export async function commitUpgrade(
  h: UpgradeStoreHost,
  io: Pick<UpgradeIO, "marker">,
  marker: UpgradeMarker,
  live: LivePasskey | null,
  confirmed: boolean,
): Promise<void> {
  await h.adoptPasskey(marker, live, confirmed);
  await finalizeUpgrade({ ...h.finalizeDeps(), marker: io.marker }, marker);
  await h.endEmailSession();
}

/** Undo the upgrade this device prepared, unless its switch has landed. */
export async function runCancel(h: UpgradeStoreHost, io: UpgradeIO): Promise<void> {
  const account = h.emailAccount();
  if (!account) return;
  const marker = io.marker.read(account.parent);
  if (!marker || marker.emailKey !== account.emailKey || marker.stage !== "prepared") return;
  if (await switchLanded({ readKernelSignerFor: h.readSignerFor }, marker)) throw new Error(ALREADY_LANDED_MESSAGE);
  if (!(await h.ensureSession())) throw new Error(NO_SESSION_MESSAGE);
  await cancelUpgrade(await io.prepareDeps(account), marker);
  liveInTab = null;
}

/**
 * A passkey account with an upgrade marker: finalize when the switch landed but this
 * device never committed (a tab closed mid-way), then re-post the likes and follows.
 * Never mints a session or asks for the passkey on its own.
 */
export async function runResume(h: UpgradeStoreHost, io: UpgradeIO): Promise<void> {
  const account = h.passkeyAccount();
  if (!account) return;
  let marker = io.marker.read(account.parent);
  if (!marker || marker.passkey !== account.passkey) return;
  if (marker.stage === "prepared") {
    if (!(await switchLanded({ readKernelSignerFor: h.readSignerFor }, marker))) return;
    marker = await finalizeUpgrade({ ...h.finalizeDeps(), marker: io.marker }, marker);
  }
  if (!h.passkeyAccount()?.hasSession) return;
  const key = await h.feedKeyIfPresent();
  const still = h.passkeyAccount();
  if (!key || still?.parent !== account.parent || still.passkey !== account.passkey) return;
  await moveSocial({ marker: io.marker, social: await io.social() }, marker, key);
}
