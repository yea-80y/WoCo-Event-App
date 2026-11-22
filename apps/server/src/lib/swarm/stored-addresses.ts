/**
 * The stored-address list: every address this server has put on the Etherna
 * PLATFORM batch, and nothing about who put it there.
 *
 * WHY IT EXISTS. Etherna's nodes issue that batch's stamps, so nothing on it can
 * be removed one item at a time. Content stops being stored only when the batch
 * is replaced: what is still live is stamped again on the new batch (a chunk
 * keeps its address on another batch and nobody's signature is needed) and the
 * old batch lapses with everything else. That needs the list of what is ON the
 * batch, and an address can only be listed at the moment it is stored.
 *
 * ADDRESSES ONLY (owner, 2026-11-22). No account, no IP, no order of arrival
 * (rows are sorted), no time finer than the UTC day - except that a file's own
 * modification time is that of its last row. A signed chunk's owner and
 * identifier are in the chunk itself, so they are not repeated here. What is
 * LIVE is not recorded either: a batch change reads that from the users' own
 * signed feeds.
 *
 * SEALED TO A KEY THIS SERVER DOES NOT HOLD (owner, 2026-11-22). A signed chunk
 * names its signer to anyone who reads it, so a readable list would be a ready
 * index from addresses to signers for whoever took the data folder or a backup.
 * The server only ever writes the list, so each file is sealed to a public key
 * (`STORED_ADDRESSES_SEAL_KEY`, X-Wing) whose private half is kept off the
 * server and is needed only to plan a batch change. What stays readable here:
 * the day in a file's name, its size, and the rows of files still open, which
 * are in this process's memory. No key, or not a key: nothing is listed and
 * health is red - an unsealed file is never written.
 *
 * THE PLATFORM BATCH ONLY. An account's own Etherna batch is theirs to replace,
 * and its id would mark every row with its owner.
 *
 * LISTED = ETHERNA TOOK IT, OR WAS ASKED AND DID NOT ANSWER. A signed chunk whose
 * send timed out may be in Etherna's store, and it may be a feed's newest
 * version, so it is listed: the list errs towards too much. A file is listed
 * only on an answer, because its address IS the answer: one nobody was given
 * has nothing pointing to it, and the same bytes saved again are listed then.
 * A bytes row holds the level ASKED for; a store found to have built the plain
 * tree instead gets a second row at level 0 (`saveForEtherna`). Whoever stamps
 * a file again must check the root it is answered, whatever the row says.
 *
 * WRITTEN, NEVER READ BACK. Each run of the server writes its own files and
 * opens no earlier one, so a file from an older build or a damaged one is never
 * overwritten and nothing here can fail at boot. A row repeated across files is
 * the reader's to fold. A file is sealed and rewritten whole when it gains rows,
 * so it is closed at `MAX_ROWS_PER_FILE` and at midnight UTC to keep that small.
 *
 * NEVER A GATE ON A SAVE. A row is noted in memory at once and its file written
 * just after, one write at a time; rows that arrive while one is being written
 * share the next. Failing a save over the list would leave a chunk the user was
 * told had failed. A write that fails is retried each minute; `/api/health`
 * `storedAddresses` is red until it lands, and stays red until restart once a
 * row could not be noted at all. Shutdown waits for the last write.
 *
 * WHAT IT DOES NOT HOLD, silently: anything stored before this list existed,
 * by a build without it (a rollback), or by another process with the same
 * Etherna account (a dev server lists into its own `.data`); rows noted in the
 * instant before a crash; and rows still in memory when the server is restarted
 * while red. A batch change that needs those finds them from the gateway
 * whitelist and from what the feeds point to.
 *
 * MUST SURVIVE RESTARTS (`.data/stored-addresses/`). Losing it, or the private
 * key, loses nothing that is stored. The next batch change then has to carry
 * everything it can find instead of only what is live.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SealContext } from "@woco/shared/crypto/sealed-box";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { writeJsonAtomic } from "../marketing/persist.js";

/** Rows per file before the next one is opened: the size of what a new row seals and rewrites (about 35 KB). */
export const MAX_ROWS_PER_FILE = 500;
/** Closed files not yet on disk, kept for the retry. Past this the oldest go, and health stays red. */
export const MAX_UNSAVED_FILES = 50;
/** An X-Wing public key, as hex. */
const SEAL_KEY_HEX_CHARS = 1216 * 2;

export const STORED_ADDRESSES_VERSION = 1 as const;
/** FROZEN with the files it sealed: a file is opened under the same info and its own day. */
export const STORED_ADDRESSES_SEAL_INFO = "woco/stored-addresses/v1";

export function storedAddressesSealContext(day: string): SealContext {
  return { info: STORED_ADDRESSES_SEAL_INFO, aad: `${STORED_ADDRESSES_SEAL_INFO}:${day}` };
}

/** `[root, level asked for, size in bytes]`. */
export type StoredBytesRow = [address: string, level: 0 | 1, size: number];

/** What a file's box opens to. No field names an account or a time. */
export interface StoredAddressesBody {
  batches: Record<string, { soc: string[]; bytes: StoredBytesRow[] }>;
}

/** One file on disk. */
export interface StoredAddressesFile {
  v: typeof STORED_ADDRESSES_VERSION;
  /** UTC day the rows were noted, `YYYY-MM-DD`. Bound into the seal. */
  day: string;
  /** `StoredAddressesBody` as JSON, gzipped, sealed to `STORED_ADDRESSES_SEAL_KEY`. */
  box: SealedBoxV2;
}

export type StoredItem =
  | { kind: "soc"; address: string; batchId: string }
  | { kind: "bytes"; address: string; batchId: string; level: 0 | 1; size: number };

interface ListFile {
  path: string;
  day: string;
  body: StoredAddressesBody;
  rows: number;
  /** Rows the copy on disk holds. */
  saved: number;
  /** The last write of it did not land. */
  failed: boolean;
  /** A write is waiting its turn. */
  queued: boolean;
  /** Rows already in THIS file. A repeat in another file is the reader's to fold. */
  seen: Set<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

let now: () => number = Date.now;
let maxRows = MAX_ROWS_PER_FILE;
let maxUnsaved = MAX_UNSAVED_FILES;
let runTag = newRunTag();
let part = 0;
let open: ListFile | undefined;
/** Closed files whose rows are not all on disk yet. */
let closed: ListFile[] = [];
/** One write at a time, in the order asked. Never rejects. */
let chain: Promise<void> = Promise.resolve();
let stats = { lostFiles: 0, droppedRows: 0 };
let dropReason = "";
let timer: ReturnType<typeof setInterval> | undefined;

/** Random, so a file name says nothing about when the server started. */
function newRunTag(): string {
  return randomBytes(6).toString("hex");
}

function norm(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

/** The batch this server stamps free-hosted content on at Etherna; none configured = nothing is noted. */
function platformBatch(): string | undefined {
  const b = process.env.ETHERNA_PLATFORM_BATCH;
  return b ? norm(b) : undefined;
}

/** The public key the list is sealed to, as hex; undefined when none that could be one is configured. */
function sealKey(): string | undefined {
  const k = norm((process.env.STORED_ADDRESSES_SEAL_KEY ?? "").trim());
  return k.length === SEAL_KEY_HEX_CHARS && /^[0-9a-f]+$/.test(k) ? k : undefined;
}

function dir(): string {
  return join(process.cwd(), ".data", "stored-addresses");
}

const onDisk = (f: ListFile): boolean => f.saved === f.rows && !f.failed && !f.queued;

function schedule(f: ListFile): void {
  if (f.queued) return;
  f.queued = true;
  chain = chain.then(() => flush(f));
}

/** Seal `f` as it stands now and write it. Rows that arrive meanwhile queue the next write. */
async function flush(f: ListFile): Promise<void> {
  f.queued = false;
  const rows = f.rows;
  try {
    const key = sealKey();
    if (!key) throw new Error("no seal key");
    // Sorted, so the order rows arrived in is not on disk. Serialised here, before
    // the first await: a row noted during the seal belongs to the next write.
    for (const b of Object.values(f.body.batches)) {
      b.soc.sort();
      b.bytes.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    }
    const plain: StoredAddressesBody = JSON.parse(JSON.stringify(f.body));
    const { sealBoxJsonCompressed } = await import("@woco/shared/crypto/sealed-box");
    const box = await sealBoxJsonCompressed(key, plain, storedAddressesSealContext(f.day));
    const file: StoredAddressesFile = { v: STORED_ADDRESSES_VERSION, day: f.day, box };
    f.failed = !writeJsonAtomic(f.path, file, "stored-addresses");
    if (!f.failed) f.saved = rows;
  } catch (err) {
    f.failed = true;
    console.error("[stored-addresses] ALARM: a file of the list could not be sealed:", (err as Error)?.message ?? err);
  }
  closed = closed.filter((c) => !onDisk(c));
  giveUpPastCeiling();
}

/** Only files whose write FAILED count: one merely waiting its turn is about to be written. */
function giveUpPastCeiling(): void {
  const failed = closed.filter((c) => c.failed);
  while (failed.length > maxUnsaved) {
    const oldest = failed.shift()!;
    closed = closed.filter((c) => c !== oldest);
    stats.lostFiles++;
  }
}

function close(f: ListFile): void {
  if (!onDisk(f)) closed.push(f);
}

function fileFor(day: string): ListFile {
  if (open && (open.day !== day || open.rows >= maxRows)) {
    close(open);
    open = undefined;
  }
  open ??= {
    path: join(dir(), `${day}.${runTag}.${part++}.json`),
    day,
    body: { batches: {} },
    rows: 0,
    saved: 0,
    failed: false,
    queued: false,
    seen: new Set(),
  };
  return open;
}

/**
 * Note one item on the list. Only the Etherna platform batch is listed; anything
 * else returns at once. Never throws and never waits: the list is never the
 * reason a save fails or slows. A row that cannot be noted at all turns health
 * red until restart.
 */
export function noteStored(item: StoredItem): void {
  try {
    const batchId = norm(item.batchId);
    if (batchId !== platformBatch()) return;
    // No key to seal to: nothing is kept, readable or not. Health says so.
    if (!sealKey()) return;
    const address = norm(item.address);
    if (!HEX64.test(address)) throw new Error("not a 32-byte address");

    const f = fileFor(new Date(now()).toISOString().slice(0, 10));
    const key = item.kind === "soc" ? `s:${address}` : `b:${address}:${item.level}`;
    if (f.seen.has(key)) return;
    f.seen.add(key);
    const rows = (f.body.batches[batchId] ??= { soc: [], bytes: [] });
    if (item.kind === "soc") rows.soc.push(address);
    else rows.bytes.push([address, item.level, item.size]);
    f.rows++;
    schedule(f);
  } catch (err) {
    stats.droppedRows++;
    dropReason = (err as Error)?.message ?? String(err);
    console.error("[stored-addresses] ALARM: a stored address could not be noted:", err);
  }
}

/** Write again whatever did not land. Called each minute; nothing to do when all is on disk. */
export function retryStoredAddresses(): void {
  for (const f of [...closed, ...(open ? [open] : [])]) if (f.failed) schedule(f);
}

/** Resolves once every write asked for so far has been tried. For shutdown, and tests. */
export async function flushStoredAddresses(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = chain;
    await seen;
  } while (seen !== chain);
}

function unsavedFiles(): number {
  return closed.filter((f) => f.failed).length + (open?.failed ? 1 : 0);
}

/** Why the list cannot be taken as complete, worst first; undefined when it can. */
function fault(): string | undefined {
  if (platformBatch() !== undefined && !sealKey()) return "no seal key configured: nothing is being listed";
  if (stats.lostFiles) return "unwritten files of the list were given up";
  if (stats.droppedRows) return `a stored address could not be noted: ${dropReason}`;
  if (unsavedFiles()) return "a file of the list could not be sealed or written";
  return undefined;
}

export function startStoredAddresses(): void {
  if (timer) return;
  timer = setInterval(retryStoredAddresses, 60_000);
  timer.unref();
}

/**
 * For `/api/health`, which is public: no counts of what was listed. RED while a
 * file's last write failed (do not restart: its rows are only in memory), until
 * restart after files were given up (`lostFiles`) or a row could not be noted
 * (`droppedRows`), and while a platform batch is configured with no key to seal
 * the list to: the next batch change must not take the list as complete.
 * `recording` false = nothing is being listed.
 */
export function storedAddressesHealth(): Record<string, unknown> {
  const reason = fault();
  return {
    ok: reason === undefined,
    recording: platformBatch() !== undefined && sealKey() !== undefined,
    unsavedFiles: unsavedFiles(),
    ...(stats.lostFiles ? { lostFiles: stats.lostFiles } : {}),
    ...(stats.droppedRows ? { droppedRows: stats.droppedRows } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Files this process still holds rows for: the open one, and closed ones not yet on disk. */
export function __storedAddressesHeldForTest(): number {
  return closed.length + (open ? 1 : 0);
}

/** A new run, as after a restart: nothing of the previous one is held or reopened. */
export function __resetStoredAddressesForTest(opts: { now?: () => number; maxRows?: number; maxUnsaved?: number } = {}): void {
  now = opts.now ?? Date.now;
  maxRows = opts.maxRows ?? MAX_ROWS_PER_FILE;
  maxUnsaved = opts.maxUnsaved ?? MAX_UNSAVED_FILES;
  runTag = newRunTag();
  part = 0;
  open = undefined;
  closed = [];
  chain = Promise.resolve();
  stats = { lostFiles: 0, droppedRows: 0 };
  dropReason = "";
}
