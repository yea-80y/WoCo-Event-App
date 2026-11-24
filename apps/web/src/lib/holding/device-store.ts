/**
 * Private ticket receipts kept on THIS device (spec-receipt-note 5.2): the order's secret
 * from a Keep link, and the checked receipt box once fetched, under the device key.
 *
 * Why on the device at all: a guest opening a Keep link may have no account yet. The
 * secret is kept from the moment the link opens (so a reload, or a sign-in that leaves
 * the page and comes back, does not lose it), and the box from the first press (so the
 * server's copy expiring loses nothing for a guest who has not signed up).
 *
 * The rules:
 * - Nothing here ever drops a secret on an error. An entry goes only at sign-out.
 * - A field once known is never written over with nothing (two tabs, a stale read).
 * - Local only: no network, ever. The Keep page's load uses only this file.
 *
 * Not account data: one device, any person. Signing out deletes every entry
 * (`forgetAllDeviceReceipts`, from the sign-out sweep), so a shared device keeps no
 * receipt once someone signs out; one saved to an account is in that account.
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import { StorageKeys } from "@woco/shared";
import { AAD, decrypt, encrypt, ensureDeviceKey } from "../auth/storage/encryption.js";
import { delKV, getKV, listKeys, putKV } from "../auth/storage/indexeddb.js";
import type { EncryptedBlob } from "@woco/shared";

const PREFIX = `${StorageKeys.HOLDING_DEVICE}:`;
const HEX64 = /^[0-9a-f]{64}$/;

export interface DeviceReceipt {
  pickupId: string;
  /** The order's secret, 64 hex. Opens the box; derives every key of the order. */
  r: string;
  /** Where the box is on Swarm: from the link, or from the server's answer. */
  boxRoot?: string;
  /** The box, checked against `r` when it was fetched. */
  box?: HoldingBoxV1;
  /** The event's title as its page showed it when the receipt was shown: display only, never trusted. */
  title?: string;
  /** ms. */
  keptAt: number;
  /** The account (lowercase) the copy was saved in and READ BACK from. */
  savedTo?: string;
  /** Our server's copy is erased (or there was none left to erase). */
  serverErased?: boolean;
}

interface StoredV1 extends Omit<DeviceReceipt, "pickupId"> {
  v: 1;
}

const keyOf = (pickupId: string) => `${PREFIX}${pickupId}`;

async function shared() {
  const [{ holdingPickupId }, { parseHoldingBox }, { bytesToHex, hexToBytes }] = await Promise.all([
    import("@woco/shared/holding/derive"),
    import("@woco/shared/holding/box"),
    import("@noble/hashes/utils.js"),
  ]);
  return { holdingPickupId, parseHoldingBox, bytesToHex, hexToBytes };
}

/** An entry as stored, checked: its secret is the order it is filed under. */
async function parse(pickupId: string, x: unknown): Promise<DeviceReceipt | null> {
  const s = x as Partial<StoredV1> | null;
  if (!s || typeof s !== "object" || s.v !== 1 || typeof s.r !== "string" || !HEX64.test(s.r)) return null;
  if (!Number.isFinite(s.keptAt)) return null;
  const { holdingPickupId, parseHoldingBox, hexToBytes } = await shared();
  if (holdingPickupId(hexToBytes(s.r)) !== pickupId) return null;
  const out: DeviceReceipt = { pickupId, r: s.r, keptAt: s.keptAt as number };
  if (typeof s.boxRoot === "string" && HEX64.test(s.boxRoot)) out.boxRoot = s.boxRoot;
  if (s.box !== undefined) {
    const box = parseHoldingBox(s.box);
    if (box) out.box = box;
  }
  if (typeof s.title === "string" && s.title.length > 0) out.title = s.title.slice(0, 200);
  if (typeof s.savedTo === "string" && /^0x[0-9a-f]{40}$/.test(s.savedTo)) out.savedTo = s.savedTo;
  if (s.serverErased === true) out.serverErased = true;
  return out;
}

/** One entry, or null when there is none (or it does not open on this device). */
export async function readDeviceReceipt(pickupId: string): Promise<DeviceReceipt | null> {
  if (!HEX64.test(pickupId)) return null;
  const blob = await getKV<EncryptedBlob>(keyOf(pickupId));
  if (!blob) return null;
  try {
    return await parse(pickupId, await decrypt(await ensureDeviceKey(), AAD.HOLDING_DEVICE_ORDER(pickupId), blob));
  } catch {
    // Another device key (storage partly cleared): unreadable, and left alone.
    return null;
  }
}

/** Every entry this device holds and can open, newest first. */
export async function listDeviceReceipts(): Promise<DeviceReceipt[]> {
  const ids = (await listKeys(PREFIX)).map((k) => k.slice(PREFIX.length)).filter((id) => HEX64.test(id));
  const out: DeviceReceipt[] = [];
  for (const id of ids) {
    const got = await readDeviceReceipt(id);
    if (got) out.push(got);
  }
  return out.sort((a, b) => b.keptAt - a.keptAt);
}

// One write at a time in this tab: each is a read, a merge and a write.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Merge `change` into the entry for the order of `r`, creating it if needed. A field
 * already known is never removed: only `change`'s defined fields are applied.
 */
async function update(rHex: string, change: Partial<Omit<DeviceReceipt, "pickupId" | "r" | "keptAt">>, now: number): Promise<DeviceReceipt> {
  const run = async () => {
    const { holdingPickupId, hexToBytes } = await shared();
    const pickupId = holdingPickupId(hexToBytes(rHex));
    const was = await readDeviceReceipt(pickupId);
    const next: DeviceReceipt = { ...(was ?? { pickupId, r: rHex, keptAt: now }) };
    // Only what `change` names is written, so once erased stays erased and a saved
    // account stays named.
    for (const [k, v] of Object.entries(change)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    const { pickupId: _id, ...rest } = next;
    const stored: StoredV1 = { v: 1, ...rest };
    await putKV(keyOf(pickupId), await encrypt(await ensureDeviceKey(), AAD.HOLDING_DEVICE_ORDER(pickupId), stored));
    return next;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Keep the secret from a Keep link (and where its box is). Local only. */
export async function rememberKeepLink(r: Uint8Array, boxRoot: string | undefined, now = Date.now()): Promise<DeviceReceipt> {
  const { bytesToHex } = await shared();
  return update(bytesToHex(r), boxRoot && HEX64.test(boxRoot) ? { boxRoot } : {}, now);
}

/** Keep the checked box, and where it was found. */
export async function rememberDeviceBox(rHex: string, box: HoldingBoxV1, boxRoot: string, now = Date.now()): Promise<DeviceReceipt> {
  return update(rHex, { box, boxRoot }, now);
}

export async function rememberDeviceTitle(rHex: string, title: string, now = Date.now()): Promise<DeviceReceipt> {
  return update(rHex, { title: title.slice(0, 200) }, now);
}

/** The copy read back in `account`. */
export async function markDeviceReceiptSaved(rHex: string, account: string, now = Date.now()): Promise<DeviceReceipt> {
  return update(rHex, { savedTo: account.toLowerCase() }, now);
}

/** Our server's copy is gone. */
export async function markDeviceReceiptErased(rHex: string, now = Date.now()): Promise<DeviceReceipt> {
  return update(rHex, { serverErased: true }, now);
}

/** Sign-out: every receipt kept on this device goes. */
export async function forgetAllDeviceReceipts(): Promise<void> {
  for (const k of await listKeys(PREFIX)) await delKV(k);
}
