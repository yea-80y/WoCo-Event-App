/**
 * The buyer's own receipt copies, in their account's private storage on Swarm.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 5.1; layout in
 * `@woco/shared/holding/copy` (versioned, not frozen).
 *
 * Per account generation: one copy per order (the secret and its checked receipts,
 * sealed to that generation's order key, owned by its own copy signer, at a topic salted
 * from its secret) and one index listing the orders. Without the generation's secret
 * nobody can look a copy up, open it or tie it to an order; what a save still shows is
 * in `@woco/shared/holding/copy`.
 *
 * Every save is READ BACK before it counts: `saved` means the bytes we wrote are what
 * Swarm holds at our version and they open under our key. `unconfirmed` means the upload
 * was accepted but could not be read back yet. Only `saved` lets the caller erase the
 * server's copy, so a lost write can never also lose the receipt.
 *
 * I/O is passed in (`HoldingFeedIO`); `holding-io.ts` has the live one.
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { HoldingCopyV1, HoldingIndexEntry, HoldingIndexV1 } from "@woco/shared/holding/copy";
import type { ContentFeedResult, ContentFeedWriteBase } from "../swarm/content-feed.js";

/** A feed signer: the key and the address that owns its feeds. */
export interface FeedKey {
  privKey: string;
  address: string;
}

/** One account generation's keys, as the receipt store uses them. */
export interface HoldingGenKeys {
  signer: FeedKey;
  orderPublicKey: Uint8Array;
  orderSecretKey: Uint8Array;
  salt: Uint8Array;
}

export interface HoldingFeedIO {
  /** A thorough read and the version a write after it must target (`readContentFeedWriteBase`). */
  readBase(owner: string, topic: string): Promise<ContentFeedWriteBase<unknown>>;
  /** Save at the base's next version and read the bytes back (`writeAtNextVersion`). */
  write(args: {
    signer: FeedKey;
    topic: string;
    base: ContentFeedWriteBase<unknown>;
    build: (read: ContentFeedResult<unknown>) => Promise<unknown>;
  }): Promise<"verified" | "unconfirmed">;
  /** A thorough read of the latest version. */
  read(owner: string, topic: string): Promise<ContentFeedResult<unknown>>;
}

export type SaveResult = "saved" | "unconfirmed";

/** A save that stopped, with a message written for the person (the Keep page shows it). */
export class HoldingSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldingSaveError";
  }
}

/** A generation's keys from its account secret (0x-hex). Lazy: loads the lattice code. */
export async function holdingGenKeysOf(secretHex: string): Promise<HoldingGenKeys> {
  const [{ accountKeysOf }, { holdingCopySigner, holdingTopicSalt }, { bytesToHex, hexToBytes }] = await Promise.all([
    import("@woco/shared/keyring/account-secret"),
    import("@woco/shared/holding/copy"),
    import("@noble/hashes/utils.js"),
  ]);
  const secret = hexToBytes(secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex);
  const keys = accountKeysOf(secret);
  // The copies' own signer, never the content-feed signer that owns the public profile.
  const signer = holdingCopySigner(secret);
  return {
    signer: { privKey: `0x${bytesToHex(signer.privateKey)}`, address: signer.address },
    orderPublicKey: keys.orderKey.publicKey,
    orderSecretKey: keys.orderKey.secretKey,
    salt: holdingTopicSalt(secret),
  };
}

async function shared() {
  const [copy, sealed] = await Promise.all([import("@woco/shared/holding/copy"), import("@woco/shared/crypto/sealed-box")]);
  return { ...copy, ...sealed };
}

/** A sealed value as read, opened and parsed, or null when it does not open or parse. */
async function openAs<T>(
  keys: HoldingGenKeys,
  value: unknown,
  ctx: { info: string; aad: string },
  parse: (x: unknown) => T | null,
): Promise<T | null> {
  const s = await shared();
  try {
    return parse(await s.openBoxJson(keys.orderSecretKey, value, ctx));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A found version that is CERTAINLY the latest. A scan that could not see past it
 * (`scanClean` false) may have stopped short of the head: a list read one version early
 * misses the orders added since, and a mover would carry less and call it complete.
 */
function headOf(read: ContentFeedResult<unknown>): { value: unknown } | null | "unavailable" {
  if (read.status === "absent") return null;
  if (read.status !== "found" || !read.scanClean) return "unavailable";
  return { value: read.value };
}

/** The generation's index: null when it has none, "unavailable" when it could not be read or opened. */
export async function readHoldingIndex(keys: HoldingGenKeys, io: HoldingFeedIO): Promise<HoldingIndexV1 | null | "unavailable"> {
  const s = await shared();
  const topic = s.holdingIndexTopic(keys.salt);
  const read = headOf(await io.read(keys.signer.address, topic).catch(() => ({ status: "unavailable" as const })));
  if (read === null || read === "unavailable") return read;
  // Present but not ours to read is never "none": a write on top would drop its orders.
  return (await openAs(keys, read.value, s.holdingIndexSealContext(topic), s.parseHoldingIndex)) ?? "unavailable";
}

/** One order's copy: null when there is none, "unavailable" when it could not be read or opened. */
export async function readHoldingCopy(keys: HoldingGenKeys, pickupId: string, io: HoldingFeedIO): Promise<HoldingCopyV1 | null | "unavailable"> {
  const s = await shared();
  const topic = s.holdingCopyTopic(keys.salt, pickupId);
  const read = headOf(await io.read(keys.signer.address, topic).catch(() => ({ status: "unavailable" as const })));
  if (read === null || read === "unavailable") return read;
  const copy = await openAs(keys, read.value, s.holdingCopySealContext(pickupId), s.parseHoldingCopy);
  return copy && (await copyIsFor(copy, pickupId)) ? copy : "unavailable";
}

/** The copy's secret is the order's: what it is filed under. */
async function copyIsFor(copy: HoldingCopyV1, pickupId: string): Promise<boolean> {
  const [{ holdingPickupId }, { hexToBytes }] = await Promise.all([import("@woco/shared/holding/derive"), import("@noble/hashes/utils.js")]);
  return holdingPickupId(hexToBytes(copy.r)) === pickupId;
}

/**
 * Every copy the account holds, across the generations given (newest LAST, as
 * `getAccountSecrets().all` lists them): the newest generation's copy of an order wins.
 * `complete` is false when any index or copy could not be read - a mover must then stop.
 */
export async function readAllHoldingCopies(
  gens: HoldingGenKeys[],
  io: HoldingFeedIO,
): Promise<{ copies: { copy: HoldingCopyV1; entry: HoldingIndexEntry }[]; complete: boolean }> {
  const seen = new Set<string>();
  const copies: { copy: HoldingCopyV1; entry: HoldingIndexEntry }[] = [];
  let complete = true;
  for (const keys of [...gens].reverse()) {
    const index = await readHoldingIndex(keys, io);
    if (index === "unavailable") {
      complete = false;
      continue;
    }
    for (const entry of index?.orders ?? []) {
      if (seen.has(entry.pickupId)) continue;
      const copy = await readHoldingCopy(keys, entry.pickupId, io);
      if (copy === "unavailable" || copy === null) {
        // Listed but missing is as incomplete as unreadable: the index says it was saved.
        complete = false;
        continue;
      }
      seen.add(entry.pickupId);
      // From the copy, not the old line: the copy is what was checked when it was saved.
      const s = await shared();
      copies.push({ copy, entry: s.holdingIndexEntryOf(entry.pickupId, copy.box) });
    }
  }
  return { copies, complete };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Save one order's copy under `keys`, unless an equal one is already there. Throws on failure. */
export async function writeHoldingCopy(keys: HoldingGenKeys, copy: HoldingCopyV1, io: HoldingFeedIO): Promise<SaveResult> {
  const s = await shared();
  const { holdingPickupId } = await import("@woco/shared/holding/derive");
  const { hexToBytes } = await import("@noble/hashes/utils.js");
  const pickupId = holdingPickupId(hexToBytes(copy.r));
  const topic = s.holdingCopyTopic(keys.salt, pickupId);
  const ctx = s.holdingCopySealContext(pickupId);
  const base = await io.readBase(keys.signer.address, topic);
  // Only a read that is certainly the head may say "already there".
  if (base.read.status === "found" && base.read.scanClean) {
    const there = await openAs(keys, base.read.value, ctx, s.parseHoldingCopy);
    // A thorough read found it: that IS the read-back.
    if (there && s.sameHoldingCopy(there, copy)) return "saved";
  }
  // The receipts change only when a ticket is re-made (spec section 8): then the new
  // copy goes on top, at the next version. What is there is never needed to build it.
  let sealed: unknown;
  const written = await io.write({
    signer: keys.signer,
    topic,
    base,
    build: async () => (sealed = await s.sealBoxJsonCompressed(keys.orderPublicKey, copy, ctx)),
  });
  if (written !== "verified") return "unconfirmed";
  // The bytes Swarm holds are the ones sealed here: they must open under this account's key.
  if (!(await openAs(keys, sealed, ctx, s.parseHoldingCopy))) throw new HoldingSaveError("the saved receipt does not open under this account's key");
  return "saved";
}

/** Add `entries` to the generation's index (one write for all). Throws on failure, and on an index it cannot read. */
export async function addToHoldingIndex(keys: HoldingGenKeys, entries: HoldingIndexEntry[], io: HoldingFeedIO): Promise<SaveResult> {
  const s = await shared();
  const topic = s.holdingIndexTopic(keys.salt);
  const ctx = s.holdingIndexSealContext(topic);
  const current = async (read: ContentFeedResult<unknown>): Promise<HoldingIndexV1 | null> => {
    if (read.status === "absent") return null;
    if (read.status !== "found") throw new HoldingSaveError("your receipt list could not be read - try again later");
    const index = await openAs(keys, read.value, ctx, s.parseHoldingIndex);
    // Never written over: its orders would vanish from the account's list.
    if (!index) throw new HoldingSaveError("your receipt list could not be opened");
    return index;
  };
  const missing = (index: HoldingIndexV1 | null) =>
    entries.filter((e) => !index?.orders.some((o) => s.sameHoldingIndexEntry(o, e)));

  const base = await io.readBase(keys.signer.address, topic);
  // A base that names no next version may not be the head: never "already listed" off it
  // (the write below reads again, and refuses while it stays inconclusive).
  if (base.nextVersion !== null && missing(await current(base.read)).length === 0) return "saved";
  let sealed: unknown;
  const written = await io.write({
    signer: keys.signer,
    topic,
    base,
    // Built again on every attempt, from what is there then: another tab's order stays.
    build: async (read) => {
      let next = await current(read);
      for (const e of entries) next = s.withHoldingIndexEntry(next, e);
      return (sealed = await s.sealBoxJsonCompressed(keys.orderPublicKey, next, ctx));
    },
  });
  if (written !== "verified") return "unconfirmed";
  if (!(await openAs(keys, sealed, ctx, s.parseHoldingIndex))) throw new HoldingSaveError("the saved receipt list does not open under this account's key");
  return "saved";
}

/**
 * Save one order: its copy, then its line in the index. `saved` only when both read back.
 * The box is checked against `r` here, whoever opened it: an unchecked box is never kept,
 * and a checked one is in slot order, so the same receipts always make the same copy.
 */
export async function saveHoldingCopy(keys: HoldingGenKeys, r: Uint8Array, box: HoldingBoxV1, io: HoldingFeedIO): Promise<SaveResult> {
  const [s, { holdingPickupId }, { checkedHoldingBox }] = await Promise.all([
    shared(),
    import("@woco/shared/holding/derive"),
    import("@woco/shared/holding/open"),
  ]);
  const checked = checkedHoldingBox(r, box).box;
  const copy = s.holdingCopyOf(r, checked);
  if ((await writeHoldingCopy(keys, copy, io)) !== "saved") return "unconfirmed";
  return addToHoldingIndex(keys, [s.holdingIndexEntryOf(holdingPickupId(r), checked)], io);
}

/** What `readAllHoldingCopies` found, for `writeHoldingCopies`. */
export type SavedHoldingCopies = { copy: HoldingCopyV1; entry: HoldingIndexEntry }[];

/**
 * Save `copies` under `to`, then list them all in its index with one write. Throws unless
 * every copy and the index read back - the caller retries, and nothing is lost meanwhile:
 * wherever the copies came from, they are still there.
 */
export async function writeHoldingCopies(to: HoldingGenKeys, copies: SavedHoldingCopies, io: HoldingFeedIO): Promise<void> {
  // Not even a read for an account with none: a thorough read of a never-written feed can
  // come back inconclusive, and that would hold a passkey removal open for nothing.
  if (copies.length === 0) return;
  for (const { copy } of copies) {
    if ((await writeHoldingCopy(to, copy, io)) !== "saved") throw new HoldingSaveError("a saved receipt could not be confirmed yet - try again later");
  }
  if ((await addToHoldingIndex(to, copies.map((c) => c.entry), io)) !== "saved") {
    throw new HoldingSaveError("your receipt list could not be confirmed yet - try again later");
  }
}

/**
 * Carry every copy from the generations `from` (newest last) to `to`, at a passkey
 * removal. Refuses on a read that was not complete: a mover that carried only what it
 * could read would leave the rest behind the old keys.
 */
export async function moveHoldingCopies(from: HoldingGenKeys[], to: HoldingGenKeys, io: HoldingFeedIO): Promise<number> {
  const { copies, complete } = await readAllHoldingCopies(from, io);
  if (!complete) throw new HoldingSaveError("your saved receipts could not all be read - try again later");
  await writeHoldingCopies(to, copies, io);
  return copies.length;
}
