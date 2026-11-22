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
 * ADDRESSES ONLY (owner, 2026-11-22). No account, no IP, no time of day. A signed
 * chunk's owner and identifier are in the chunk itself, so they are not repeated
 * here. What is LIVE is not recorded either: it is read from the users' own
 * signed feeds when a batch change is planned (`stored-plan.ts`). The honest
 * limit: a signed chunk names its signer to anyone who reads it, so this list
 * can be tied to signers through public data. It is no index of its own.
 *
 * THE PLATFORM BATCH ONLY. An account's own Etherna batch is theirs to replace,
 * and its id would mark every row with its owner.
 *
 * WRITTEN, NEVER READ BACK. Each run of the server writes its own files and
 * opens no earlier one, so a file from an older build or a damaged one is never
 * overwritten and nothing here can fail at boot. A row repeated across files is
 * the reader's to fold. A file is rewritten whole on each new row, so it is
 * closed at `MAX_ROWS_PER_FILE` and at midnight UTC to keep that write small.
 *
 * NEVER A GATE ON A SAVE. A row is noted after the store took the bytes: failing
 * the save then would leave a chunk the user was told had failed. A write that
 * does not land stays in memory and is retried each minute; `/api/health`
 * `storedAddresses` is red until it lands. A crash in between loses those rows:
 * a signed chunk is still in the gateway whitelist, and a file is still named by
 * the feed that points to it, which is what the plan reads.
 *
 * MUST SURVIVE RESTARTS (`.data/stored-addresses/`). Losing it loses nothing
 * that is stored. The next batch change then has to carry everything it can
 * find instead of only what is live.
 */

import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

/** Rows per file before the next one is opened: the size of the rewrite a save pays for. */
export const MAX_ROWS_PER_FILE = 2000;
/** Past this the repeat check starts again. It only saves rows, it guards nothing. */
const MAX_SEEN = 200_000;
/** Closed files that could not be written, kept for the retry. Past this the oldest go. */
const MAX_UNSAVED_FILES = 50;

export const STORED_ADDRESSES_VERSION = 1 as const;

/** `[root, level asked for, size in bytes]`. The level is the one ASKED: the root says what was built. */
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
}

const HEX64 = /^[0-9a-f]{64}$/;

let now: () => number = Date.now;
let maxRows = MAX_ROWS_PER_FILE;
let dirOverride: string | undefined;
let runTag = newRunTag();
let part = 0;
let open: OpenFile | undefined;
let closedUnsaved: OpenFile[] = [];
let seen = new Set<string>();
let stats = { rows: 0, files: 0, lostFiles: 0 };
let lastError: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function newRunTag(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
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
  return dirOverride ?? join(process.cwd(), ".data", "stored-addresses");
}

function write(f: OpenFile): boolean {
  const ok = writeJsonAtomic(f.path, f.body, "stored-addresses");
  f.dirty = !ok;
  if (!ok) lastError = `could not write ${f.path.slice(dir().length + 1)}`;
  return ok;
}

function close(f: OpenFile): void {
  if (!f.dirty) return;
  closedUnsaved.push(f);
  while (closedUnsaved.length > MAX_UNSAVED_FILES) {
    closedUnsaved.shift();
    stats.lostFiles++;
  }
}

function fileFor(day: string): OpenFile {
  if (open && (open.body.day !== day || open.rows >= maxRows)) {
    close(open);
    open = undefined;
  }
  if (!open) {
    open = {
      path: join(dir(), `${day}.${runTag}.${part++}.json`),
      body: { v: STORED_ADDRESSES_VERSION, day, batches: {} },
      rows: 0,
      dirty: false,
    };
    stats.files++;
  }
  return open;
}

/**
 * Note one item a store has just taken. Only the Etherna platform batch is
 * listed; anything else returns at once. Never throws: the list is never the
 * reason a save fails.
 */
export function noteStored(item: StoredItem): void {
  try {
    const batchId = norm(item.batchId);
    if (batchId !== platformBatch()) return;
    const address = norm(item.address);
    if (!HEX64.test(address)) return;
    const key = item.kind === "soc" ? `s:${address}` : `b:${address}:${item.level}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);

    const f = fileFor(new Date(now()).toISOString().slice(0, 10));
    const rows = (f.body.batches[batchId] ??= { soc: [], bytes: [] });
    if (item.kind === "soc") rows.soc.push(address);
    else rows.bytes.push([address, item.level, item.size]);
    f.rows++;
    stats.rows++;
    write(f);
  } catch (err) {
    lastError = `note failed: ${(err as Error)?.message ?? String(err)}`;
    console.error("[stored-addresses] could not note a stored address:", err);
  }
}

/** Write again whatever has not landed. Called each minute; cheap when nothing is waiting. */
export function retryStoredAddresses(): void {
  closedUnsaved = closedUnsaved.filter((f) => !write(f));
  if (open?.dirty) write(open);
  if (unsavedFiles() === 0 && stats.lostFiles === 0) lastError = undefined;
}

function unsavedFiles(): number {
  return closedUnsaved.length + (open?.dirty ? 1 : 0);
}

export function startStoredAddresses(): void {
  if (timer) return;
  timer = setInterval(retryStoredAddresses, 60_000);
  timer.unref();
}

/**
 * For `/api/health`. RED while a file has not reached the disk, or after closed
 * files had to be given up (`lostFiles`, until restart): rows in those are not on
 * the list, so the next batch change must not trust it to be complete.
 * `recording` false = no platform batch configured, nothing to list.
 */
export function storedAddressesHealth(): Record<string, unknown> {
  const unsaved = unsavedFiles();
  return {
    ok: unsaved === 0 && stats.lostFiles === 0,
    recording: platformBatch() !== undefined,
    rowsThisRun: stats.rows,
    filesThisRun: stats.files,
    unsavedFiles: unsaved,
    ...(stats.lostFiles ? { lostFiles: stats.lostFiles } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

/** A new run, as after a restart: nothing of the previous one is held or reopened. */
export function __resetStoredAddressesForTest(opts: { now?: () => number; maxRows?: number; dir?: string } = {}): void {
  now = opts.now ?? Date.now;
  maxRows = opts.maxRows ?? MAX_ROWS_PER_FILE;
  dirOverride = opts.dir;
  runTag = newRunTag();
  part = 0;
  open = undefined;
  closedUnsaved = [];
  seen = new Set();
  stats = { rows: 0, files: 0, lostFiles: 0 };
  lastError = undefined;
}
