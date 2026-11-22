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
 * signed feeds. The honest limit: a signed chunk names its signer to anyone who
 * reads it, so this list can be tied to signers through public data. It is no
 * index of its own.
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
 * the reader's to fold. A file is rewritten whole on each new row, so it is
 * closed at `MAX_ROWS_PER_FILE` and at midnight UTC to keep that write small.
 *
 * NEVER A GATE ON A SAVE. Failing a save over the list would leave a chunk the
 * user was told had failed. A write that does not land stays in memory and is
 * retried each minute; `/api/health` `storedAddresses` is red until it lands,
 * and stays red until restart once a row could not be noted at all.
 *
 * WHAT IT DOES NOT HOLD, silently: anything stored before this list existed,
 * by a build without it (a rollback), or by another process with the same
 * Etherna account (a dev server lists into its own `.data`); and rows still in
 * memory when the server is restarted while red. A batch change that needs
 * those finds them from the gateway whitelist and from what the feeds point to.
 *
 * MUST SURVIVE RESTARTS (`.data/stored-addresses/`). Losing it loses nothing
 * that is stored. The next batch change then has to carry everything it can
 * find instead of only what is live.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

/** Rows per file before the next one is opened: the size of the rewrite a save pays for (about 35 KB). */
export const MAX_ROWS_PER_FILE = 500;
/** Closed files that could not be written, kept for the retry. Past this the oldest go, and health stays red. */
export const MAX_UNSAVED_FILES = 50;

export const STORED_ADDRESSES_VERSION = 1 as const;

/** `[root, level asked for, size in bytes]`. */
export type StoredBytesRow = [address: string, level: 0 | 1, size: number];

/** One file. No field names an account or a time of day. */
export interface StoredAddressesFile {
  v: typeof STORED_ADDRESSES_VERSION;
  /** UTC day the rows were noted, `YYYY-MM-DD`. */
  day: string;
  batches: Record<string, { soc: string[]; bytes: StoredBytesRow[] }>;
}

export type StoredItem =
  | { kind: "soc"; address: string; batchId: string }
  | { kind: "bytes"; address: string; batchId: string; level: 0 | 1; size: number };

interface OpenFile {
  path: string;
  body: StoredAddressesFile;
  rows: number;
  dirty: boolean;
  /** Rows already in THIS file. A repeat in another file is the reader's to fold. */
  seen: Set<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

let now: () => number = Date.now;
let maxRows = MAX_ROWS_PER_FILE;
let maxUnsaved = MAX_UNSAVED_FILES;
let runTag = newRunTag();
let part = 0;
let open: OpenFile | undefined;
let closedUnsaved: OpenFile[] = [];
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

function dir(): string {
  return join(process.cwd(), ".data", "stored-addresses");
}

function write(f: OpenFile): boolean {
  // Sorted, so the order rows arrived in is not on disk.
  for (const rows of Object.values(f.body.batches)) {
    rows.soc.sort();
    rows.bytes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  }
  const ok = writeJsonAtomic(f.path, f.body, "stored-addresses");
  f.dirty = !ok;
  return ok;
}

function close(f: OpenFile): void {
  if (!f.dirty) return;
  closedUnsaved.push(f);
  while (closedUnsaved.length > maxUnsaved) {
    closedUnsaved.shift();
    stats.lostFiles++;
  }
}

function fileFor(day: string): OpenFile {
  if (open && (open.body.day !== day || open.rows >= maxRows)) {
    close(open);
    open = undefined;
  }
  open ??= {
    path: join(dir(), `${day}.${runTag}.${part++}.json`),
    body: { v: STORED_ADDRESSES_VERSION, day, batches: {} },
    rows: 0,
    dirty: false,
    seen: new Set(),
  };
  return open;
}

/**
 * Note one item on the list. Only the Etherna platform batch is listed; anything
 * else returns at once. Never throws: the list is never the reason a save fails.
 * A row that cannot be noted at all turns health red until restart.
 */
export function noteStored(item: StoredItem): void {
  try {
    const batchId = norm(item.batchId);
    if (batchId !== platformBatch()) return;
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
    write(f);
  } catch (err) {
    stats.droppedRows++;
    dropReason = (err as Error)?.message ?? String(err);
    console.error("[stored-addresses] ALARM: a stored address could not be noted:", err);
  }
}

/** Write again whatever has not landed. Called each minute; cheap when nothing is waiting. */
export function retryStoredAddresses(): void {
  closedUnsaved = closedUnsaved.filter((f) => !write(f));
  if (open?.dirty) write(open);
}

function unsavedFiles(): number {
  return closedUnsaved.length + (open?.dirty ? 1 : 0);
}

/** Why the list cannot be taken as complete, worst first; undefined when it can. */
function fault(): string | undefined {
  if (stats.lostFiles) return "unwritten files of the list were given up";
  if (stats.droppedRows) return `a stored address could not be noted: ${dropReason}`;
  if (unsavedFiles()) return "a file of the list could not be written";
  return undefined;
}

export function startStoredAddresses(): void {
  if (timer) return;
  timer = setInterval(retryStoredAddresses, 60_000);
  timer.unref();
}

/**
 * For `/api/health`, which is public: no counts of what was listed. RED while a
 * file has not reached the disk (do not restart: its rows are only in memory),
 * and until restart after files were given up (`lostFiles`) or a row could not
 * be noted (`droppedRows`): the next batch change must not take the list as
 * complete. `recording` false = no platform batch configured, nothing to list.
 */
export function storedAddressesHealth(): Record<string, unknown> {
  const reason = fault();
  return {
    ok: reason === undefined,
    recording: platformBatch() !== undefined,
    unsavedFiles: unsavedFiles(),
    ...(stats.lostFiles ? { lostFiles: stats.lostFiles } : {}),
    ...(stats.droppedRows ? { droppedRows: stats.droppedRows } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** A new run, as after a restart: nothing of the previous one is held or reopened. */
export function __resetStoredAddressesForTest(opts: { now?: () => number; maxRows?: number; maxUnsaved?: number } = {}): void {
  now = opts.now ?? Date.now;
  maxRows = opts.maxRows ?? MAX_ROWS_PER_FILE;
  maxUnsaved = opts.maxUnsaved ?? MAX_UNSAVED_FILES;
  runTag = newRunTag();
  part = 0;
  open = undefined;
  closedUnsaved = [];
  stats = { lostFiles: 0, droppedRows: 0 };
  dropReason = "";
}
