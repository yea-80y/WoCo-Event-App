/**
 * The account's later secrets on this device (#186): loading them after an unlock,
 * checking them against the chain, taking a newer ring, putting passkeys into the ring,
 * and the removal that moves the account to new keys.
 *
 * Loaded lazily: the auth store (in every page load) keeps only the state and the
 * gates that read it, and lends both here through `AccountKeysHost` - the same
 * "the store lends state, not flows" shape as `co-owner-flows.ts`.
 */
import { deriveFeedSignerKey } from "@woco/shared";
import type { KeyRingMember } from "@woco/shared/keyring/ring";
import {
  allSecretsOf,
  currentSecretOf,
  hasLockedChain,
  openLockedChain,
  restoreChainWindow,
  storeLockedChain,
  writeChainWindow,
  type AccountChain,
} from "../auth/account-chain.js";
import { SEED_UNLOCK_POLICY } from "../auth/seed-unlock-policy.js";
import type { CoOwnerHost } from "../auth/co-owner-flows.js";
import type { RotationProgress, RotationResult } from "./rotate.js";

export type KeysVerdict = "pending" | "ok" | "behind" | "keyless" | "foreign" | "unknown";

export interface UnlockedSeed {
  seedAddress: string;
  parent: string;
  seed: string;
  expiresAt: number | null;
  chain: AccountChain | null;
}

/** What the auth store lends: its state, and the steps only it can take. */
export interface AccountKeysHost {
  isPasskey(): boolean;
  deviceRole(): boolean;
  unlocked(): UnlockedSeed | null;
  setChain(chain: AccountChain): void;
  lockGen(): number;
  prf(): string | null;
  ownerKey(): string | null;
  /** This passkey's own address (its key on the co-owner list). */
  self(): string | null;
  relock(): void;
  setVerdict(v: KeysVerdict): void;
  setNotice(n: "keyless" | "changed"): void;
  commitSigner(): void;
  /** The store's gates: the verdict, waited for (and caught up once with `prompt`). */
  requireCurrentKeys(opts: { prompt?: boolean }): Promise<void>;
  currentKeysConfirmed(): Promise<boolean>;
  anchorMemo(): { account: string; ref: string | null; at: number } | null;
  setAnchorMemo(m: { account: string; ref: string | null; at: number }): void;
  ensurePasskeyKey(): Promise<void>;
  ensureKernel(): Promise<void>;
  kernel(): import("../auth/kernel-account.js").BuiltKernel | null;
  coOwnerHost(): CoOwnerHost;
  removeRecordAfterList(parent: string, key: string): Promise<void>;
  signTypedDataAsHolder(typed: unknown): Promise<string>;
  setRemovalProgress(p: RotationProgress | null): void;
  setPendingRemoval(p: { going: string[] } | null): void;
  seedLockedMessage(): string;
}

export function keysVerdictMessage(v: KeysVerdict): string {
  switch (v) {
    case "behind":
      return "Your account's keys changed on another of your passkeys. Confirm it's you to update this device.";
    case "keyless":
      return "This passkey doesn't have your account's latest keys. Open WoCo on another of your passkeys to set it up.";
    case "foreign":
      return "This device's keys don't match your account. Sign in again.";
    default:
      return "Couldn't check your account's keys right now - try again in a moment.";
  }
}

/** The anchor, cached briefly for the silent paths that ask it often (fresh at every unlock). */
export async function readAnchor(h: AccountKeysHost, account: string, opts: { fresh?: boolean } = {}): Promise<string | null | "error"> {
  const now = Date.now();
  const memo = h.anchorMemo();
  if (!opts.fresh && memo?.account === account && now - memo.at < 30_000) return memo.ref;
  const { readRingAnchor } = await import("../auth/kernel-account.js");
  const ref = await readRingAnchor(account);
  if (ref !== "error") h.setAnchorMemo({ account, ref, at: now });
  return ref;
}

/** Use `chain` as the account's later secrets from now on (the signer is committed by a verdict). */
function applyChain(h: AccountKeysHost, chain: AccountChain, opts: { persistWindow: boolean }): void {
  const u = h.unlocked();
  if (!u) return;
  h.setChain(chain);
  if (opts.persistWindow) {
    const gen = h.lockGen();
    void writeChainWindow(u.seedAddress, u.parent, chain, u.expiresAt, () => gen === h.lockGen()).catch((e) =>
      console.warn("[auth] could not keep the account keys' window (non-fatal):", e),
    );
  }
}

/**
 * The account's later secrets, right after its seed unlocked: opened with the passkey
 * when a ceremony just ran, else from the window copy, then checked against the chain.
 * A seed restored from its window while the chain's window copy is missing - but a
 * locked chain exists - is relocked rather than run on generation 0. ANY failure leaves
 * the verdict short of "ok": nothing then signs or seals (fail closed).
 */
export async function loadAccountChain(
  h: AccountKeysHost,
  seedAddr: string,
  parent: string,
  gen: number,
  mode: "window" | "unlock",
): Promise<void> {
  const current = () => gen === h.lockGen() && h.unlocked()?.seedAddress === seedAddr && h.unlocked()?.parent === parent;
  try {
    const prf = mode === "unlock" ? h.prf() : null;
    if (!h.unlocked()?.chain) {
      const chain = prf ? await openLockedChain(seedAddr, parent, prf) : await restoreChainWindow(seedAddr, parent, SEED_UNLOCK_POLICY);
      if (!current()) return;
      if (chain) {
        applyChain(h, chain, { persistWindow: !!prf });
      } else if (!prf && (await hasLockedChain(seedAddr))) {
        console.warn("[auth] account keys have no open window copy - locking until the next confirm");
        if (current()) h.relock();
        return;
      }
    }
    const verdict = await verifyCurrentKeys(h, prf);
    if (!current()) return;
    h.setVerdict(verdict);
    if (verdict === "ok") {
      h.commitSigner();
      // A co-owned account's passkey with no ring entry yet adds itself, once.
      if (prf && h.unlocked()?.chain?.ringRef !== enrolledAt(seedAddr)) void enrolSelfOnce(h, seedAddr);
      if (prf) void removalLeftHere(h, seedAddr);
    }
  } catch (e) {
    console.warn("[auth] account keys could not be checked:", e);
    if (current()) h.setVerdict("unknown");
  }
}

/**
 * Is what this device holds the account's current generation? Reads the anchor (no
 * passkey needed). A newer ring is adopted only with the PRF in hand - its entry opens
 * with this passkey's box key; without it the answer is "behind".
 */
export async function verifyCurrentKeys(h: AccountKeysHost, prf: string | null): Promise<KeysVerdict> {
  if (!h.isPasskey()) return "ok";
  const u = h.unlocked();
  if (!u) return "unknown";
  const ref = await readAnchor(h, u.parent, { fresh: true });
  if (ref === "error") return "unknown";
  const held = u.chain?.ringRef ?? null;
  // The contract never clears an entry: none while a ring is held is a lagging read.
  if (ref === held || ref === null) return "ok";
  if (!prf) return "behind";
  return syncKeyRing(h, prf);
}

/** A device merely BEHIND asks for the passkey once and takes the newer ring. */
export async function catchUp(h: AccountKeysHost): Promise<KeysVerdict> {
  await h.ensurePasskeyKey();
  const prf = h.prf();
  const verdict = prf ? await verifyCurrentKeys(h, prf) : "unknown";
  h.setVerdict(verdict);
  if (verdict === "ok") h.commitSigner();
  return verdict;
}

/** Take the account's current key ring, with this passkey's PRF output in hand. */
async function syncKeyRing(h: AccountKeysHost, prf: string): Promise<KeysVerdict> {
  const u = h.unlocked();
  const coOwner = h.self();
  if (!h.isPasskey() || !u || !coOwner) return "unknown";
  const gen = h.lockGen();
  const [{ adoptKeyRing }, { fetchKeyRing }, { readRingAnchor }, { passkeyBoxKeypair }] = await Promise.all([
    import("./adopt.js"),
    import("./ring-read.js"),
    import("../auth/kernel-account.js"),
    import("@woco/shared/keyring/account-secret"),
  ]);
  const box = passkeyBoxKeypair(prf);
  try {
    const res = await adoptKeyRing({
      parent: u.parent,
      coOwner,
      boxSecretKey: box.secretKey,
      seed: u.seed,
      held: u.chain,
      readAnchor: readRingAnchor,
      fetchRing: fetchKeyRing,
    });
    const now = h.unlocked();
    const stillOurs = gen === h.lockGen() && now?.seedAddress === u.seedAddress && now.parent === u.parent;
    if (!stillOurs) return "unknown";
    switch (res.status) {
      case "adopted": {
        await storeLockedChain(u.seedAddress, u.parent, res.chain, prf);
        const before = u.chain?.gen ?? 0;
        applyChain(h, res.chain, { persistWindow: true });
        if (res.chain.gen > before) h.setNotice("changed");
        return "ok";
      }
      case "none":
      case "current":
      case "older":
        return "ok";
      case "keyless":
        h.setNotice("keyless");
        return "keyless";
      case "foreign":
        console.error("[auth] the account's key ring does not belong to this seed - not used");
        return "foreign";
      default:
        console.warn(`[auth] key ring check: ${res.reason}`);
        return "unknown";
    }
  } finally {
    box.secretKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Putting passkeys into the ring
// ---------------------------------------------------------------------------

export type RingChange = { prev: string | null; next: string; chain: AccountChain };

/**
 * The account's key ring for a co-owner change made from this device, stored and ready
 * to ride in the same op - or null when nothing about the ring changes. The ring always
 * includes THIS passkey (a device that changes the account must be able to open its
 * keys), never re-seals to a key that is off the list, and is built only from the
 * CONFIRMED current generation: a device behind refuses rather than fork the ring.
 * `add`: members of passkeys being added whose keys are on this device.
 */
export async function ringForChange(h: AccountKeysHost, add: KeyRingMember[]): Promise<RingChange | null> {
  if (!h.isPasskey()) return null;
  await h.requireCurrentKeys({ prompt: true });
  const u = h.unlocked();
  const self = h.self();
  const ownerKey = h.ownerKey();
  const prf = h.prf();
  if (!u || !self || !ownerKey || !prf) throw new Error(h.seedLockedMessage());
  const [members, { fetchKeyRing }, kernel] = await Promise.all([
    import("./members.js"),
    import("./ring-read.js"),
    import("../auth/kernel-account.js"),
  ]);
  const ref = await readAnchor(h, u.parent, { fresh: true });
  const held = u.chain?.ringRef ?? null;
  if (ref === "error" || (ref === null && held !== null)) throw new Error(keysVerdictMessage("unknown"));
  if (ref !== held) throw new Error(keysVerdictMessage("behind"));
  const current = ref ? { ref, ring: await fetchKeyRing(ref) } : null;
  const root = await kernel.readKernelRoot(u.parent);
  if (root === "error") throw new Error(keysVerdictMessage("unknown"));
  const listed = root === "weighted" ? await kernel.readCoOwners(u.parent) : [self];
  if (listed === "error" || listed === null) throw new Error(keysVerdictMessage("unknown"));
  // One passkey and nothing added: no ring is needed until the account has a second.
  if (add.length === 0 && root !== "weighted") return null;
  const inRing = new Set(current?.ring.entries.map((e) => e.statement.coOwner) ?? []);
  const selfMember = inRing.has(self) ? [] : [await members.memberOf(u.parent, { address: self, privateKey: ownerKey, prfSecret: prf })];
  if (add.length === 0 && selfMember.length === 0) return null;
  const ring = await members.ringWithMembers({
    parent: u.parent,
    seed: u.seed,
    chain: u.chain,
    current,
    onChain: [...listed, ...add.map((m) => m.statement.coOwner)],
    add: [...selfMember, ...add],
  });
  const next = await members.storeKeyRing(ring);
  return { prev: ref, next, chain: { ringRef: next, gen: ring.gen, secrets: u.chain?.secrets ?? [] } };
}

/** The ring this device just named onchain is the account's now: hold it as current. */
export async function adoptOwnRing(h: AccountKeysHost, chain: AccountChain): Promise<void> {
  const u = h.unlocked();
  const prf = h.prf();
  if (!u || !prf) return;
  await storeLockedChain(u.seedAddress, u.parent, chain, prf);
  applyChain(h, chain, { persistWindow: true });
  h.setAnchorMemo({ account: u.parent, ref: chain.ringRef, at: Date.now() });
  h.setVerdict("ok");
  h.commitSigner();
}

/**
 * Put THIS passkey into the account's key ring when it holds the current keys but has no
 * entry yet - a device just linked, or one from before key rings. One sponsored op, once;
 * a failure is retried at the next unlock. Without an entry, the next removal would leave
 * this device without the account's new keys.
 */
export async function enrolSelfInKeyRing(h: AccountKeysHost): Promise<void> {
  try {
    if (!h.isPasskey() || h.deviceRole() || !(await h.currentKeysConfirmed())) return;
    const ring = await ringForChange(h, []);
    if (!ring) return;
    await h.ensureKernel();
    const kernel = h.kernel();
    if (!kernel) return;
    const { setKeyRingAlone } = await import("../auth/kernel-account.js");
    const res = await setKeyRingAlone(kernel, { prev: ring.prev, next: ring.next });
    if (res.confirmed) await adoptOwnRing(h, ring.chain);
  } catch (e) {
    console.warn("[auth] could not add this passkey to the account's keys yet (retried at the next unlock):", e);
  }
}

/** The ring this passkey last confirmed itself in, so an unlock does not re-check it every time. */
function enrolledAt(seedAddr: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`woco:keyring:enrolled:${seedAddr}`) ?? null;
  } catch {
    return null;
  }
}

async function enrolSelfOnce(h: AccountKeysHost, seedAddr: string): Promise<void> {
  await enrolSelfInKeyRing(h);
  const ref = h.unlocked()?.chain?.ringRef;
  if (!ref) return;
  try {
    const { fetchKeyRing } = await import("./ring-read.js");
    const ring = await fetchKeyRing(ref);
    if (ring.entries.some((e) => e.statement.coOwner === seedAddr)) {
      globalThis.localStorage?.setItem(`woco:keyring:enrolled:${seedAddr}`, ref);
    }
  } catch {
    /* checked again at the next unlock */
  }
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * A removal this device began and did not finish, found at an unlock. Past its flip the
 * removed passkey is already off and the account on new keys: what is left (moving what
 * readers follow) finishes by itself. Before it nothing changed, so the person decides:
 * the passkey keeps working until they press "Finish removing".
 */
async function removalLeftHere(h: AccountKeysHost, seedAddr: string): Promise<void> {
  try {
    const { hasPendingRotation, openPendingRotation } = await import("./pending-rotation.js");
    if (!(await hasPendingRotation(seedAddr))) return;
    const u = h.unlocked();
    const prf = h.prf();
    if (!u || !prf) return;
    const p = (await openPendingRotation(seedAddr, u.parent, prf)) as import("./rotate.js").PendingRotation | null;
    if (!p || p.parent !== u.parent) return;
    const flipped = p.phase === "flipped" || (!!p.nextRing && (await readAnchor(h, u.parent, { fresh: true })) === p.nextRing);
    if (flipped) await rotateOnRemovalFor(h, [], { resume: true });
    else h.setPendingRemoval({ going: p.going });
  } catch (e) {
    console.warn("[auth] an unfinished removal was not resumed (tried again at the next unlock):", e);
  }
}

/**
 * Remove passkeys and move the account to new keys, or finish a removal this device
 * started (`resume`). Needs the CURRENT generation confirmed and this passkey's keys in
 * hand - the caller has asked for a fresh confirm.
 */
export async function rotateOnRemovalFor(h: AccountKeysHost, going: string[], opts: { resume?: boolean } = {}): Promise<RotationResult> {
  await h.requireCurrentKeys({ prompt: true });
  const u = h.unlocked();
  const prf = h.prf();
  const ownerKey = h.ownerKey();
  const self = h.self();
  if (!h.isPasskey() || !u || !prf || !ownerKey || !self) throw new Error(h.seedLockedMessage());
  const [{ rotateOnRemoval }, { liveRotationSteps }, flows] = await Promise.all([
    import("./rotate.js"),
    import("./rotate-live.js"),
    import("../auth/co-owner-flows.js"),
  ]);
  const steps = liveRotationSteps({
    parent: u.parent,
    self: { address: self, privateKey: ownerKey, prfSecret: prf },
    seed: u.seed,
    chain: u.chain,
    oldSigner: deriveFeedSignerKey(currentSecretOf(u.seed, u.chain)),
    oldSecrets: allSecretsOf(u.seed, u.chain),
    flip: async (g, ring) => {
      await flows.removeCoOwnersWithRing(h.coOwnerHost(), g, ring);
      return { confirmed: true };
    },
    adopt: (chain) => adoptOwnRing(h, chain),
    signTypedDataAsHolder: (typed) => h.signTypedDataAsHolder(typed),
    removeRecord: (key) => h.removeRecordAfterList(u.parent, key),
    progress: (p) => h.setRemovalProgress(p),
  });
  try {
    return await rotateOnRemoval(steps, going, opts);
  } finally {
    h.setRemovalProgress(null);
  }
}
