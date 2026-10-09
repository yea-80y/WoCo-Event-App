/**
 * Putting a passkey on the account's co-owner list and taking one off (#746, every
 * passkey a co-owner). Loaded on the tap: the store lends only its state
 * (`_coOwnerHost` in auth-store.svelte.ts), so none of this is in a page load.
 */
import type { BuiltKernel } from "./kernel-account.js";

/** The chain reads and the one write these flows use - kernel-account.ts's, or a test's. */
export interface CoOwnerChain {
  readKernelRoot(kernel: string): Promise<"ecdsa" | "weighted" | "none" | "error">;
  readCoOwners(kernel: string): Promise<string[] | null | "error">;
  setCoOwners(
    kernel: BuiltKernel,
    root: "ecdsa" | "weighted" | "none",
    signers: readonly string[],
    ring?: { prev: string | null; next: string },
  ): Promise<unknown>;
  setKeyRingAlone(kernel: BuiltKernel, ring: { prev: string | null; next: string }): Promise<{ confirmed: boolean }>;
  readRingAnchor(account: string): Promise<string | null | "error">;
}

export interface CoOwnerHost {
  /** Open this device's Kernel with the validator the account really has. */
  ensureKernel(): Promise<void>;
  kernel(): BuiltKernel | null;
  self(): string | null;
  parent(): string | null;
  /** The account's root may have changed: rebuild the Kernel on its next use. */
  dropKernel(): void;
  lockedMessage(): string;
  /** Absent in the app: the real reads load on first use. */
  chain?: CoOwnerChain;
}

async function chainOf(h: CoOwnerHost): Promise<CoOwnerChain> {
  return h.chain ?? (await import("./kernel-account.js"));
}

/** The account's co-owner list now, from chain: this key alone while the root is still
 *  ECDSA (it signs the switch, so it must be that owner). Throws when unread. */
async function currentCoOwners(h: CoOwnerHost): Promise<{ root: "ecdsa" | "weighted" | "none"; list: string[] }> {
  const kernel = h.kernel();
  const self = h.self();
  if (!kernel || !self) throw new Error(h.lockedMessage());
  const { readKernelRoot, readCoOwners } = await chainOf(h);
  const root = await readKernelRoot(kernel.address);
  if (root === "error") throw new Error("Couldn't reach the network - nothing was changed. Try again.");
  if (root !== "weighted") return { root, list: [self] };
  const list = await readCoOwners(kernel.address);
  if (list === "error" || list === null) throw new Error("Couldn't read your passkeys - nothing was changed. Try again.");
  return { root, list };
}

/**
 * Put `key` on the account's co-owner list: the switch the first time (one sponsored
 * op that also deploys a counterfactual account), renew after. Signed by this
 * device's key; the Kernel is rebuilt afterwards because its root may have changed.
 * True when this call added it; false when it was on the list already.
 */
export async function addCoOwner(
  h: CoOwnerHost,
  key: string,
  ring?: { prev: string | null; next: string },
): Promise<boolean> {
  await h.ensureKernel();
  const { root, list } = await currentCoOwners(h);
  if (list.includes(key.toLowerCase())) return false;
  const [{ listWith }, { setCoOwners }] = await Promise.all([import("./co-owner-calls.js"), chainOf(h)]);
  await setCoOwners(h.kernel()!, root, listWith(list, key), ring);
  h.dropKernel();
  return true;
}

/** Take `key` off the account's co-owner list, if it is on it. The last one never. */
export async function removeCoOwner(h: CoOwnerHost, key: string): Promise<void> {
  return removeCoOwners(h, [key]);
}

/** Take several keys off in ONE list change. Keys not on the list are ignored; the last passkey never goes. */
export async function removeCoOwners(
  h: CoOwnerHost,
  keys: readonly string[],
  ring?: { prev: string | null; next: string },
): Promise<void> {
  await h.ensureKernel();
  const { root, list } = await currentCoOwners(h);
  if (root !== "weighted") return;
  const going = keys.map((k) => k.toLowerCase()).filter((k) => list.includes(k));
  if (going.length === 0) return;
  const [{ listWithout }, { setCoOwners }] = await Promise.all([import("./co-owner-calls.js"), chainOf(h)]);
  const next = going.reduce<string[]>((acc, k) => listWithout(acc, k), list);
  await setCoOwners(h.kernel()!, "weighted", next, ring);
  h.dropKernel();
}

/**
 * A removal's FLIP (#186): the passkeys off the list and the account's key ring onto
 * `ring` in ONE op. If another device already took them off, the ring still moves (a
 * ring-only op) - the new keys must land whatever the list says. The anchor is read
 * back: the flip is done only when it names the new ring.
 */
export async function removeCoOwnersWithRing(
  h: CoOwnerHost,
  keys: readonly string[],
  ring: { prev: string | null; next: string },
): Promise<void> {
  await h.ensureKernel();
  const { root, list } = await currentCoOwners(h);
  if (root !== "weighted") throw new Error("This account has only one passkey - nothing to remove.");
  const going = keys.map((k) => k.toLowerCase()).filter((k) => list.includes(k));
  const chain = await chainOf(h);
  if (going.length === 0) {
    await chain.setKeyRingAlone(h.kernel()!, ring);
  } else {
    const { listWithout } = await import("./co-owner-calls.js");
    const next = going.reduce<string[]>((acc, k) => listWithout(acc, k), list);
    await chain.setCoOwners(h.kernel()!, "weighted", next, ring);
  }
  h.dropKernel();
  const parent = h.parent();
  if (parent && (await chain.readRingAnchor(parent)) !== ring.next) {
    throw new Error("Your account's new keys didn't land - nothing else was changed. Try again.");
  }
}

/**
 * A new passkey goes on the list, then gets its device record. If the record fails,
 * the key comes off the list again: a key with full control onchain and no record to
 * remove it by must never be left behind (background commit review). Only what THIS
 * call put on the list is ever taken back - a key already on it is a passkey of the
 * account's, record or not - and a failed undo is never silent. The caller's later
 * failures (an undelivered link answer) remove it through `revoke`.
 */
export async function addCoOwnerWithRecord<T>(
  h: CoOwnerHost,
  key: string,
  record: () => Promise<T>,
  /** The account's key ring moving in the same op (#186). */
  ring?: { prev: string | null; next: string },
): Promise<T> {
  const added = await addCoOwner(h, key, ring);
  try {
    const result = await record();
    // This device added it: its own new-passkey alert must not ask about it.
    const parent = h.parent();
    if (added && parent) {
      void import("./new-passkey-alert.js").then((m) => m.rememberOwnPasskey(parent, key)).catch(() => {});
    }
    return result;
  } catch (e) {
    if (added) {
      try {
        await removeCoOwner(h, key);
      } catch (undo) {
        // Never silent: the key still has access until someone removes it.
        console.error("[auth] could not take back a passkey without a record:", undo);
        throw new Error(
          "The new passkey was added to your account but couldn't be saved. Remove it in Your passkeys before trying again.",
        );
      }
    }
    throw e;
  }
}
