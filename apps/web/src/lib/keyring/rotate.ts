/**
 * Removing a passkey moves the account to NEW keys (#186).
 *
 * The removed passkey keeps the identity seed and every generation it was ever given,
 * so whatever the account signs or seals from now on must come from a secret it never
 * sees: a fresh random S_{g+1}, sealed to the remaining passkeys in a new key ring.
 * Because the account's feeds are addressed by their signer, everything readers follow
 * moves to the new signer too.
 *
 *   1. prepare   the list and ring, read from chain; this device on the current generation
 *   2. secret    S' - kept as a pending rotation, so a closed tab resumes with the SAME one
 *   3. copy      events, site configs, profile under the new signer (nothing reads them yet)
 *   4. ring      S' sealed to every remaining passkey, earlier secrets under it; stored
 *   5. flip      ONE op: the passkey off the list AND the anchor onto the new ring. Before
 *                it, readers follow the old keys; after it, the new - never a mix
 *   6. adopt     this device holds S' as current
 *   7. after     the server told; site pointers, live sites, event pages and names moved;
 *                the contact list re-sealed; the passkey's device record removed;
 *                likes and follows re-made under the new signer
 *
 * A step before the flip that fails leaves the account exactly as it was (the removed
 * passkey still works, nothing changed). After the flip the removal is done; what is
 * left is retried on the next open, and the person is told which addresses to update
 * themselves.
 *
 * Pure: every step is passed in (`rotate-live.ts` has the real ones).
 */
import type { KeyRing, KeyRingMember } from "@woco/shared/keyring/ring";
import type { AccountChain } from "../auth/account-chain.js";

export interface PendingRotation {
  v: 1;
  parent: string;
  /** The passkeys being removed. */
  going: string[];
  /** The generation S' is. */
  gen: number;
  /** S', 0x-hex. Stored locked like the account's other secrets. */
  secret: string;
  /** The ring the anchor named when this began - the flip's compare-and-swap. */
  prevRing: string | null;
  /** The new ring, once stored. */
  nextRing?: string;
  phase: "copying" | "flipped";
  /** Post-flip steps still to do. */
  after?: AfterStep[];
}

export type AfterStep = "server" | "sites" | "pages" | "list" | "records" | "social";
export const AFTER_STEPS: readonly AfterStep[] = ["server", "sites", "pages", "list", "records", "social"];

export type RotationProgress =
  | { step: "keys" }
  | { step: "events"; done: number; total: number }
  | { step: "sites" }
  | { step: "profile" }
  | { step: "onchain" }
  | { step: "after" };

export interface NewKeys {
  secret: string;
  feedSigner: { privKey: string; address: string };
  orderKeyRef: string;
  orderPublicKey: Uint8Array;
}

export interface RotationSteps {
  parent: string;
  self: string;
  /** What this device holds now. */
  seed: string;
  chain: AccountChain | null;
  readAnchor(): Promise<string | null | "error">;
  readCoOwners(): Promise<string[] | "error">;
  fetchRing(ref: string): Promise<KeyRing>;
  /** This device's member, for a ring that does not have it yet. */
  selfMember(): Promise<KeyRingMember>;
  newSecret(): string;
  keysOf(secret: string): Promise<NewKeys>;
  loadPending(): Promise<PendingRotation | null>;
  savePending(p: PendingRotation): Promise<void>;
  clearPending(): Promise<void>;
  copyEvents(keys: NewKeys, progress: (done: number, total: number) => void): Promise<void>;
  copySiteConfigs(keys: NewKeys): Promise<void>;
  copyProfile(keys: NewKeys): Promise<void>;
  /** Build the ring for S' and store it with the new order key; returns its reference. */
  storeRing(args: { gen: number; secret: string; prevRing: string | null; members: KeyRingMember[] }): Promise<string>;
  /** The flip: one op taking `going` off the list and moving the anchor. */
  flip(going: string[], ring: { prev: string | null; next: string }): Promise<{ confirmed: boolean }>;
  adopt(chain: AccountChain): Promise<void>;
  after: Record<AfterStep, (keys: NewKeys, ctx: { going: string[] }) => Promise<void>>;
  progress(p: RotationProgress): void;
}

export class RotationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationRefusedError";
  }
}

export interface RotationResult {
  /** Post-flip steps that did not finish; retried on the next open. */
  unfinished: AfterStep[];
  /** Passkeys left without the new keys (no ring entry to seal to): they must be set up again. */
  keyless: string[];
}

/** The chain this device holds once S' is current. */
function chainAfter(held: AccountChain | null, gen: number, ring: string, secret: string): AccountChain {
  const secrets = [...(held?.secrets ?? [])];
  while (secrets.length < gen - 1) secrets.push("");
  return { ringRef: ring, gen, secrets: [...secrets.slice(0, gen - 1), secret] };
}

/**
 * Remove `going` from the account and move it to new keys - or, with `resume`, finish a
 * removal that was interrupted. Throws before the flip with the account unchanged.
 *
 * A pending removal is continued only when it is the SAME removal: `resume`, or the same
 * passkeys against the same ring. A request to remove someone else never inherits an old
 * pending list - the confirm the person saw names who goes. And a pending removal the
 * account has since moved past (another device rotated again) is dropped, never resumed:
 * adopting its secret would roll this device back to keys a later-removed passkey holds.
 */
export async function rotateOnRemoval(
  s: RotationSteps,
  going: readonly string[],
  opts: { resume?: boolean } = {},
): Promise<RotationResult> {
  const parent = s.parent.toLowerCase();
  const self = s.self.toLowerCase();
  const requested = [...new Set(going.map((g) => g.toLowerCase()))].sort();
  let pending = await s.loadPending();
  if (pending && pending.parent !== parent) pending = null;

  const anchor = await s.readAnchor();
  if (anchor === "error") throw new RotationRefusedError("Couldn't read your account's keys - nothing was changed. Try again.");

  // An interrupted flip that landed: only what comes after is left.
  if (pending?.phase === "copying" && pending.nextRing && anchor === pending.nextRing) {
    pending = { ...pending, phase: "flipped", after: [...AFTER_STEPS] };
    await s.savePending(pending);
  }
  // A flipped removal is resumed only while its generation is still the account's.
  if (pending?.phase === "flipped") {
    const heldGen = s.chain?.gen ?? 0;
    let anchoredGen: number | null = null;
    if (anchor === pending.nextRing) anchoredGen = pending.gen;
    else if (anchor) anchoredGen = (await s.fetchRing(anchor)).gen;
    if (anchoredGen !== pending.gen || heldGen > pending.gen) {
      console.warn("[keyring] a pending removal the account has moved past - dropped");
      await s.clearPending();
      pending = null;
      if (opts.resume) return { unfinished: [], keyless: [] };
    } else if (!opts.resume && requested.join() !== [...pending.going].sort().join()) {
      throw new RotationRefusedError("A removal is still finishing on this device. Let it finish, then try again.");
    }
  }
  if (opts.resume && !pending) return { unfinished: [], keyless: [] };

  let keyless: string[] = [];
  if (!pending || pending.phase === "copying") {
    // Copying never resumes into a different removal than the one asked for.
    const samePending = pending && (opts.resume || requested.join() === [...pending.going].sort().join());
    const goingNow = samePending ? pending!.going.map((g) => g.toLowerCase()) : requested;
    if (goingNow.length === 0) throw new RotationRefusedError("Pick a passkey to remove.");
    if (goingNow.includes(self)) throw new RotationRefusedError("Remove this passkey from another of your passkeys.");
    const held = s.chain?.ringRef ?? null;
    if (anchor !== held) throw new RotationRefusedError("Your account's keys changed on another device. Open this page again, then remove the passkey.");
    const list = await s.readCoOwners();
    if (list === "error") throw new RotationRefusedError("Couldn't read your passkeys - nothing was changed. Try again.");
    const remaining = list.map((a) => a.toLowerCase()).filter((a) => !goingNow.includes(a));
    if (remaining.length === 0) throw new RotationRefusedError("This is the only passkey on the account. Add another before removing it.");
    if (!remaining.includes(self)) throw new RotationRefusedError("This device isn't one of the account's passkeys any more.");

    const gen = (s.chain?.gen ?? 0) + 1;
    // The SAME S' only for the same removal against the same ring: a ring sealed with an
    // earlier attempt's secret may already be stored, and its flip may even land.
    if (!samePending || pending!.prevRing !== anchor || pending!.gen !== gen) {
      pending = { v: 1, parent, going: goingNow, gen, secret: s.newSecret(), prevRing: anchor, phase: "copying" };
      await s.savePending(pending);
    }
    s.progress({ step: "keys" });
    const keys = await s.keysOf(pending!.secret);

    s.progress({ step: "events", done: 0, total: 0 });
    await s.copyEvents(keys, (done, total) => s.progress({ step: "events", done, total }));
    s.progress({ step: "sites" });
    await s.copySiteConfigs(keys);
    s.progress({ step: "profile" });
    await s.copyProfile(keys);

    // Members: everyone remaining who has an entry in the current ring, and this device.
    const ring = anchor ? await s.fetchRing(anchor) : null;
    const { keyRingMembers } = await import("@woco/shared/keyring/ring");
    const members: KeyRingMember[] = ring ? keyRingMembers(ring).filter((m) => remaining.includes(m.statement.coOwner)) : [];
    if (!members.some((m) => m.statement.coOwner === self)) members.push(await s.selfMember());
    keyless = remaining.filter((a) => !members.some((m) => m.statement.coOwner === a));

    s.progress({ step: "onchain" });
    const nextRing = await s.storeRing({ gen, secret: pending!.secret, prevRing: anchor, members });
    pending = { ...pending!, nextRing };
    await s.savePending(pending);
    await s.flip(pending.going, { prev: anchor, next: nextRing });
    pending = { ...pending, phase: "flipped", after: [...AFTER_STEPS] };
    await s.savePending(pending);
  }

  // Flipped, and still the account's generation: hold it (never backwards), then move
  // what readers follow.
  const p = pending!;
  if ((s.chain?.gen ?? 0) < p.gen || (s.chain?.gen === p.gen && s.chain.secrets.at(-1) !== p.secret)) {
    await s.adopt(chainAfter(s.chain, p.gen, p.nextRing!, p.secret));
  }
  s.progress({ step: "after" });
  const keys = await s.keysOf(p.secret);
  const left: AfterStep[] = [];
  for (const step of p.after ?? AFTER_STEPS) {
    try {
      await s.after[step](keys, { going: p.going });
    } catch (e) {
      console.warn(`[keyring] removal step "${step}" not finished (retried on the next open):`, e);
      left.push(step);
    }
  }
  if (left.length === 0) await s.clearPending();
  else await s.savePending({ ...p, after: left });
  return { unfinished: left, keyless };
}
