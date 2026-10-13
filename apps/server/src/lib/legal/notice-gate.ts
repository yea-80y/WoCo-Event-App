/**
 * No ticket sale until the organiser has confirmed their privacy notice (owner
 * decision 2026-10-11, docs/legal/ORGANISER_PRIVACY_NOTICE.md).
 *
 * "Confirmed" means exactly what a public page shows as the organiser's notice:
 * a notice that validates for their account on their own feed
 * (`woco/legal/privacy-notice/{account}`), read under the SAME carrier the
 * public route uses - `eventKeys` (the ring's signer once the account has one,
 * else the #670 record), never the event feed's own description of itself. So
 * "this event sells" and "an attendee sees a confirmed notice for it" cannot
 * disagree about whose notice, or under which signer.
 *
 * Verdicts:
 *   - confirmed:   a valid notice is there.
 *   - missing:     the feed is absent, or its latest version does not validate.
 *   - unavailable: the read could not answer. Sales refuse (fail closed);
 *                  browsing never calls this.
 *
 * Cost on the money path: a confirmed verdict is answered from memory. It is
 * re-read in the background once older than `NOTICE_FRESH_MS`, single-flight,
 * so a rush of buyers costs one feed read; a background read that cannot answer
 * keeps the last definitive verdict only until `NOTICE_STALE_CEILING_MS` after
 * it was read, and past that a request waits for a fresh read and refuses if it
 * cannot get one. A missing verdict is kept for `NOTICE_MISSING_TTL_MS`, and the
 * organiser's own successful write drops it at once (`forgetMissingNotice`, from
 * the relay), so confirming opens sales immediately. Unavailable is never kept.
 *
 * The public notice route reads through this same cache (`organiserNoticeRead`),
 * so the page an attendee opens and the checkout that takes their details see
 * the same notice: during a partial outage both show the last confirmed one, and
 * past the ceiling both say it cannot be loaded and nothing sells.
 */

import { readContentFeedJsonResult } from "../swarm/soc-upload.js";
import { PRIVACY_NOTICE_REQUIRED, type OrganiserNoticeV1 } from "@woco/shared";
import { readOrganiserNotice, type NoticeFeedReader, type NoticeRead } from "./organiser-notice.js";

export type NoticeVerdict = "confirmed" | "missing" | "unavailable";

export const NOTICE_FRESH_MS = 10 * 60_000;
export const NOTICE_STALE_CEILING_MS = 60 * 60_000;
export const NOTICE_MISSING_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

/** A definitive read: the confirmed notice, or none. `at` = when it was read. */
type Entry = { notice: OrganiserNoticeV1 | null; at: number };

const cache = new Map<string, Entry>();
/** creator -> when they last wrote their notice (the relay). Bounded below. */
const lastWrite = new Map<string, number>();
/** How long after a write a "missing" read is not kept: the feed cache below us may
 *  still answer the pre-write state for a few seconds. */
const WRITE_SETTLE_MS = 10_000;
const inflight = new Map<string, Promise<NoticeRead>>();

const defaultReader: NoticeFeedReader = (ownerHex, topic) =>
  readContentFeedJsonResult(ownerHex, topic, "privacyNotice", { skipLegacy: true });

let reader: NoticeFeedReader = defaultReader;
let clock: () => number = Date.now;

const keyOf = (creator: string, signer: string) => `${creator.toLowerCase()}:${signer.toLowerCase()}`;

function remember(key: string, notice: OrganiserNoticeV1 | null): void {
  const before = cache.get(key);
  if (before?.notice && !notice) {
    // A notice that was there is gone or no longer validates: that organiser's
    // sales stop here, so leave a trace (an expired batch is the usual cause).
    console.error(`[notice-gate] ${key}: confirmed privacy notice no longer readable as valid - sales refused`);
  }
  cache.delete(key); // re-insert at the end: the Map's order is the eviction order
  cache.set(key, { notice, at: clock() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function readNow(key: string, creator: string, signer: string): Promise<NoticeRead> {
  const running = inflight.get(key);
  if (running) return running;
  const account = creator.toLowerCase();
  const startedAt = clock();
  const p = (async (): Promise<NoticeRead> => {
    try {
      const r = await readOrganiserNotice(creator, signer, reader);
      // A read that began before the organiser's latest write may describe the
      // feed before it, and a "missing" just after one may come from a cache
      // that has not caught up: answer it, but never keep it.
      const wrote = lastWrite.get(account);
      const raced = wrote !== undefined && (wrote >= startedAt || (r.status === "absent" && clock() - wrote < WRITE_SETTLE_MS));
      if (r.status !== "unavailable" && !raced) remember(key, r.status === "found" ? r.notice : null);
      return r;
    } catch (err) {
      return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const fromEntry = (e: Entry): NoticeRead => (e.notice ? { status: "found", notice: e.notice } : { status: "absent" });

/**
 * `creator`'s notice read under `signer`, through the cache. Never throws. Both
 * the sale paths (via `organiserNoticeVerdict`) and the public notice route use it.
 */
export async function organiserNoticeRead(creator: string, signer: string): Promise<NoticeRead> {
  const key = keyOf(creator, signer);
  const e = cache.get(key);
  if (e) {
    const age = clock() - e.at;
    if (!e.notice && age < NOTICE_MISSING_TTL_MS) return fromEntry(e);
    if (e.notice && age < NOTICE_FRESH_MS) return fromEntry(e);
    if (e.notice && age < NOTICE_STALE_CEILING_MS) {
      void readNow(key, creator, signer);
      return fromEntry(e);
    }
  }
  return readNow(key, creator, signer);
}

/** Whether `creator`'s notice, read under `signer`, is confirmed. Never throws. */
export async function organiserNoticeVerdict(creator: string, signer: string): Promise<NoticeVerdict> {
  const r = await organiserNoticeRead(creator, signer);
  return r.status === "found" ? "confirmed" : r.status === "absent" ? "missing" : "unavailable";
}

/**
 * The organiser just wrote their notice (the relay, after a successful upload of
 * their OWN account's notice). A cached "missing" is dropped, so confirming opens
 * sales at once; a cached notice is marked stale, so it is still served while the
 * new version is read in the background - an edit shows up on the next request,
 * and a write never makes the seller's own checkout wait on a cold read. Never
 * extends how long an entry may be trusted.
 */
export function noticeWritten(creator: string): void {
  const prefix = `${creator.toLowerCase()}:`;
  const t = clock();
  lastWrite.delete(creator.toLowerCase());
  lastWrite.set(creator.toLowerCase(), t);
  for (const [k, at] of lastWrite) {
    if (lastWrite.size <= MAX_ENTRIES && t - at < WRITE_SETTLE_MS) break;
    lastWrite.delete(k); // oldest first; only ever drops writes past the settle window or over the cap
  }
  const staleAt = t - NOTICE_FRESH_MS;
  for (const [k, e] of cache) {
    if (!k.startsWith(prefix)) continue;
    if (!e.notice) cache.delete(k);
    else e.at = Math.min(e.at, staleAt);
  }
}

export { PRIVACY_NOTICE_REQUIRED };
export const PRIVACY_NOTICE_UNAVAILABLE = "PRIVACY_NOTICE_UNAVAILABLE";

/** The refusal a sale path returns for a verdict, or null when it may sell. */
export function noticeRefusal(
  verdict: NoticeVerdict,
): { status: 409 | 503; body: { ok: false; error: string; code: string } } | null {
  if (verdict === "confirmed") return null;
  if (verdict === "missing") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Tickets aren't on sale yet - the organiser needs to confirm their privacy notice first.",
        code: PRIVACY_NOTICE_REQUIRED,
      },
    };
  }
  return {
    status: 503,
    body: { ok: false, error: "Ticket sales are temporarily unavailable. Please try again in a minute.", code: PRIVACY_NOTICE_UNAVAILABLE },
  };
}

export function __setNoticeGateForTests(opts: { reader?: NoticeFeedReader; now?: () => number } = {}): void {
  reader = opts.reader ?? defaultReader;
  clock = opts.now ?? Date.now;
  cache.clear();
  inflight.clear();
  lastWrite.clear();
}
