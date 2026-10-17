/**
 * Adding opted-in ticket buyers to the organiser's list automatically (owner
 * decision 2026-10-14) - the decisions, kept pure so every rule can be tested
 * with fakes. The live wiring is `audience-sync.svelte.ts`.
 *
 * It runs in the organiser's browser because it has to: the server holds buyer
 * emails only inside order boxes sealed to the organiser, and consent only as
 * hashes. So the browser opens the orders it already has the key for, asks
 * `/api/marketing/check` which of those addresses carry a checkout record, and
 * merges the answer into the sealed list. Nothing new crosses the trust boundary.
 *
 * A buyer's email lives only in their order, and order answers are deleted some
 * months after the event (#547) - so this runs whenever the organiser uses WoCo,
 * and never asks for anything: a locked account is simply skipped.
 *
 * Rules, each pinned by `test/audience-sync.test.ts`:
 *   - an address in `suppressed` (unsubscribed, declined, bounced, complained,
 *     removed by hand) is never added, whatever else it holds;
 *   - an address the organiser deleted (the list's `removed`) is not re-added,
 *     unless it ticked "Email me" AFTER the deletion - a soft opt-in is not enough
 *     (Fable sign-off 2026-10-14 recommendation);
 *   - the write merges onto the list as re-read and opened just before it, so it
 *     never replaces an edit made elsewhere with a stale copy - no re-read, no write -
 *     and the server refuses it if the list was saved again after that re-read;
 *   - who said yes is asked again after the re-read, so someone who unsubscribed
 *     while the orders were being read is not added;
 *   - the seal key is taken at write time and checked unchanged before the upload;
 *   - one unreadable order, event or check costs only itself;
 *   - nothing is written when nothing changed.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { NOTICE_RETENTION_MONTHS, addCalendarMonthsUtc } from "@woco/shared";
import type {
  EventDirectoryEntry,
  MarketingCheckResult,
  MarketingContact,
  MarketingListMeta,
  MarketingListPayload,
  MarketingListTombstone,
  OrderEntry,
  OrderField,
} from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { applyDrain, buildAttendeeContacts, type DecryptedClaim } from "./attendee-drain.js";

/**
 * At most one run per organiser per hour on this device - the last start is kept
 * in localStorage, so a reload does not start another - unless the organiser
 * presses "Check now". Each run asks the server about every recent event.
 */
export const SYNC_INTERVAL_MS = 60 * 60_000;

/**
 * An event that ended longer ago than the longest order retention an organiser
 * can pick, plus a month, has no order answers left to add from (#547): skipped
 * without a single request.
 */
export const RETENTION_HORIZON_MONTHS = Math.max(...NOTICE_RETENTION_MONTHS) + 1;

export function pastRetention(ev: Pick<EventDirectoryEntry, "startDate" | "endDate">, now: number): boolean {
  const end = Date.parse(ev.endDate || ev.startDate);
  return Number.isFinite(end) && addCalendarMonthsUtc(end, RETENTION_HORIZON_MONTHS) < now;
}

/**
 * An event is skipped only once it has been read with the same order count at
 * least this long after that count first appeared. A sale shows on the ledger a
 * moment before its marketing choice is recorded, so the first read of a new
 * count can miss a buyer who said yes; the second read, a run later, cannot.
 */
export const SETTLE_MS = 5 * 60_000;

/** "Last checked" older than this reads as a while ago. */
export const STALE_MS = 24 * 60 * 60_000;

// ── Tombstones ──────────────────────────────────────────────────────────────

/**
 * Which contact a tombstone is for: SHA-256 over the organiser's address and the
 * lowercased email, under its own label - never a plain email hash, so it matches
 * nothing outside this organiser's own list.
 */
export function removedId(organiser: string, email: string): string {
  const input = `woco/audience-removed/v1\n${organiser.trim().toLowerCase()}\n${email.trim().toLowerCase()}`;
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** The deleted-contact list as stored, cleaned: well-formed entries only, one per contact, the latest deletion kept. */
export function normaliseRemoved(removed: unknown): MarketingListTombstone[] {
  if (!Array.isArray(removed)) return [];
  const byId = new Map<string, MarketingListTombstone>();
  for (const t of removed) {
    if (!t || typeof t !== "object") continue;
    const { h, at } = t as Record<string, unknown>;
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) continue;
    const prev = byId.get(h);
    if (!prev || Date.parse(at) > Date.parse(prev.at)) byId.set(h, { h, at });
  }
  return [...byId.values()];
}

/** The organiser deleted this contact at `at`: not added back automatically. */
export function addRemoved(
  removed: readonly MarketingListTombstone[],
  organiser: string,
  email: string,
  at: string,
): MarketingListTombstone[] {
  return normaliseRemoved([...removed, { h: removedId(organiser, email), at }]);
}

/** The organiser added these on purpose (CSV import): the automatic add may keep them again. */
export function clearRemoved(
  removed: readonly MarketingListTombstone[],
  organiser: string,
  emails: readonly string[],
): MarketingListTombstone[] {
  const back = new Set(emails.map((e) => removedId(organiser, e)));
  return normaliseRemoved(removed).filter((t) => !back.has(t.h));
}

/** The one shape every writer seals. `removed` only when there is one, so an empty list stays byte-identical to before. */
export function listPayload(contacts: MarketingContact[], removed: readonly MarketingListTombstone[]): MarketingListPayload {
  const clean = normaliseRemoved(removed);
  return { version: 1, contacts, ...(clean.length ? { removed: clean } : {}) };
}

// ── The Audience screen's own saves ─────────────────────────────────────────

/** The sealed list as an editor sees it: the contacts, and who was deleted. */
export interface ListState {
  contacts: MarketingContact[];
  removed: MarketingListTombstone[];
}

export interface ListSaveDeps {
  /** The stored list right now. Null = none yet; throws when it cannot be read. */
  readList(): Promise<{ sealedList: SealedBoxV2; updatedAt: string } | null>;
  openList(box: SealedBoxV2): Promise<MarketingListPayload>;
  sealList(payload: MarketingListPayload): Promise<SealedBoxV2>;
  writeList(sealed: SealedBoxV2, emails: string[], ifUpdatedAt: string | null): Promise<MarketingListMeta>;
}

/**
 * One edit (add, change, delete) applied to the list as it is stored NOW, not to
 * whatever copy the screen opened earlier, and written only if nothing else saved
 * in between (`ifUpdatedAt`). So a stale tab can never bring back a contact deleted
 * elsewhere, or wipe its tombstone (Fable sign-off 2026-10-14). Throws the
 * server's LIST_CHANGED when it lost that race; the caller reloads and says so.
 */
export async function saveListChange(
  deps: ListSaveDeps,
  change: (list: ListState) => ListState,
): Promise<{ payload: MarketingListPayload; meta: MarketingListMeta }> {
  const stored = await deps.readList();
  const base = stored ? await deps.openList(stored.sealedList) : { version: 1 as const, contacts: [] };
  const next = change({ contacts: base.contacts, removed: normaliseRemoved(base.removed) });
  const payload = listPayload(next.contacts, next.removed);
  const meta = await deps.writeList(
    await deps.sealList(payload),
    payload.contacts.map((c) => c.email),
    stored?.updatedAt ?? null,
  );
  return { payload, meta };
}

// ── Watermark ───────────────────────────────────────────────────────────────

/**
 * Per event: sold-slot count, when that count was first seen, when it was last
 * read in full, and how many of its orders would not open on this device - kept
 * so a permanently unreadable order does not make the event be read every run.
 */
export interface EventMark {
  n: number;
  seen: number;
  scanned: number;
  unopened?: number;
}

/**
 * What the last run already covered. `list` is the stored list's `updatedAt`
 * after that run: if the list has changed since (another tab, another device, a
 * stale copy saved over it), the event marks are not trusted and every event is
 * read again - so additions lost to someone else's save come back.
 */
export interface Watermark {
  list?: string | null;
  events: Record<string, EventMark>;
}

export interface WatermarkStore {
  read(): Watermark;
  write(w: Watermark): void;
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

const watermarkKey = (parent: string) => `woco:audience-sync:${parent.toLowerCase()}`;

function isMark(m: unknown): m is EventMark {
  if (!m || typeof m !== "object") return false;
  const { n, seen, scanned, unopened } = m as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return [n, seen, scanned].every(finite) && (unopened === undefined || finite(unopened));
}

/**
 * Per organiser, in localStorage. An optimisation only: empty, unreadable or
 * blocked storage reads as "nothing covered yet", which is a full scan.
 */
export function watermarkStore(storage: KeyValue | undefined, parent: string): WatermarkStore {
  return {
    read() {
      try {
        const raw = storage?.getItem(watermarkKey(parent));
        if (!raw) return { events: {} };
        const parsed = JSON.parse(raw) as { v?: unknown; list?: unknown; events?: unknown };
        if (parsed.v !== 1 || !parsed.events || typeof parsed.events !== "object") return { events: {} };
        const events: Record<string, EventMark> = {};
        for (const [id, m] of Object.entries(parsed.events as Record<string, unknown>)) if (isMark(m)) events[id] = m;
        const list = typeof parsed.list === "string" || parsed.list === null ? parsed.list : undefined;
        return { ...(list !== undefined ? { list } : {}), events };
      } catch {
        return { events: {} };
      }
    },
    write(w) {
      try {
        storage?.setItem(watermarkKey(parent), JSON.stringify({ v: 1, ...w }));
      } catch {
        /* best effort - the next run reads everything again */
      }
    },
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

/** Opening needs any key this device holds for the account. */
export interface OpenKeys {
  openOrder(box: SealedBoxV2, eventId: string, seriesId: string): Promise<DecryptedClaim>;
  openList(box: SealedBoxV2): Promise<MarketingListPayload>;
}

/** Sealing needs the CONFIRMED current generation (#186). */
export interface SealKeys {
  sealList(payload: MarketingListPayload): Promise<SealedBoxV2>;
  /** Still the confirmed current key, asked again: false = the key ring moved on (a passkey removal), so no upload. */
  unchanged(): Promise<boolean>;
}

export interface SyncDeps {
  /** The organiser's address - what the list's tombstones are keyed under. */
  organiser: string;
  /** Null = locked or not set up on this device: skip, never ask. */
  openKeys(): Promise<OpenKeys | null>;
  /** Taken at write time. Null = the current generation is not confirmed without asking: write nothing. */
  sealKeys(): Promise<SealKeys | null>;
  listEvents(): Promise<EventDirectoryEntry[]>;
  /** The stored list's `updatedAt`, null when there is none. Throws when it cannot say. */
  listStamp(): Promise<string | null>;
  /** Sold slots for the event - the cheap call. Throws when it cannot say. */
  orderCount(eventId: string): Promise<number>;
  getOrders(eventId: string): Promise<OrderEntry[]>;
  /** The event's questions. Throws when unreadable. */
  getOrderFields(ev: EventDirectoryEntry): Promise<readonly OrderField[]>;
  check(emails: string[]): Promise<MarketingCheckResult>;
  /** The stored list right now. Null = none yet; throws when it cannot be read. */
  readList(): Promise<{ sealedList: SealedBoxV2; updatedAt: string } | null>;
  /** `ifUpdatedAt` = the stamp of the list this was merged onto; the server refuses if it moved since. */
  writeList(sealed: SealedBoxV2, emails: string[], ifUpdatedAt: string | null): Promise<MarketingListMeta>;
  /** Still the same signed-in organiser - never write one account's buyers into another's list. */
  stillCurrent(): boolean;
  /** One writer at a time in this tab: the screen's own saves take the same lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Called inside the lock right after a write, so a screen showing the list takes it before anything else saves. */
  published?(payload: MarketingListPayload, meta: MarketingListMeta): void;
  watermark: WatermarkStore;
  now(): number;
  /** Give the page a frame between batches of order opening. */
  pause?(): Promise<void>;
}

export type SyncStatus = "ok" | "partial" | "failed" | "locked";

export interface SyncResult {
  status: SyncStatus;
  added: number;
  updated: number;
  /** Events that could not be read this time. They are read again next run. */
  failedEvents: number;
  /** Orders that would not open on this device. Their event is read again only once it sells again. */
  unreadableOrders: number;
  /** The list as this run wrote it. */
  written?: { payload: MarketingListPayload; meta: MarketingListMeta };
  error?: string;
}

const result = (status: SyncStatus, rest: Partial<SyncResult> = {}): SyncResult => ({
  status,
  added: 0,
  updated: 0,
  failedEvents: 0,
  unreadableOrders: 0,
  ...rest,
});

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((e) => e.trim().toLowerCase());

/**
 * One full pass. Never throws: every failure comes back as a status, and a
 * failed or locked run writes neither the list nor the watermark, so the next
 * run starts from where this one did.
 */
export async function runAudienceSync(deps: SyncDeps): Promise<SyncResult> {
  try {
    return await run(deps);
  } catch (err) {
    return result("failed", { error: message(err, "Could not check your events.") });
  }
}

async function run(deps: SyncDeps): Promise<SyncResult> {
  const keys = await deps.openKeys();
  if (!keys) return result("locked");

  let events: EventDirectoryEntry[];
  try {
    events = await deps.listEvents();
  } catch (err) {
    return result("failed", { error: message(err, "Could not load your events.") });
  }

  let stamp: string | null | undefined;
  try {
    stamp = await deps.listStamp();
  } catch {
    stamp = undefined; // cannot say whether the list moved: trust no mark
  }
  const prior = deps.watermark.read();
  const trusted = stamp !== undefined && prior.list !== undefined && prior.list === stamp;

  const now = deps.now();
  const addedAt = new Date(now).toISOString();
  const marks: Record<string, EventMark> = {};
  const incoming: MarketingContact[] = [];
  let failedEvents = 0;
  let unreadableOrders = 0;

  for (const ev of events) {
    if (pastRetention(ev, now)) continue;

    let n: number;
    try {
      n = await deps.orderCount(ev.eventId);
    } catch {
      failedEvents++;
      continue;
    }
    const was = prior.events[ev.eventId];
    if (trusted && was && was.n === n && was.scanned - was.seen >= SETTLE_MS) {
      marks[ev.eventId] = was;
      unreadableOrders += was.unopened ?? 0;
      continue;
    }
    const mark = (unopened: number): EventMark => ({
      n,
      seen: was?.n === n ? was.seen : now,
      scanned: now,
      ...(unopened > 0 ? { unopened } : {}),
    });
    if (n === 0) {
      marks[ev.eventId] = mark(0);
      continue;
    }

    let orders: OrderEntry[];
    try {
      orders = await deps.getOrders(ev.eventId);
    } catch {
      failedEvents++;
      continue;
    }
    // A slot the server could not read, or an order it could not download, is read
    // again next run. One that downloads but will not open here is not (`unopened`).
    const incomplete = orders.length < n || orders.some((o) => !o.encryptedOrder && !o.erased);
    const sealed = orders.filter((o) => o.encryptedOrder);

    let orderFields: readonly OrderField[];
    try {
      orderFields = await deps.getOrderFields(ev);
    } catch {
      // Without the questions nothing beyond the email could be placed: read it next time rather than add less.
      failedEvents++;
      continue;
    }

    const claims: DecryptedClaim[] = [];
    let unopened = 0;
    for (const [i, order] of sealed.entries()) {
      try {
        claims.push(await keys.openOrder(order.encryptedOrder!, ev.eventId, order.seriesId));
      } catch {
        unopened++; // sealed to a key this device lacks, or damaged - never the whole event
      }
      if (i % 16 === 15) await deps.pause?.();
    }
    unreadableOrders += unopened;

    const emails = [...new Set(lower(claims.map((c) => c.claimerEmail ?? "")).filter(Boolean))];
    if (emails.length > 0) {
      let answer: MarketingCheckResult;
      try {
        answer = await deps.check(emails);
      } catch {
        failedEvents++;
        continue;
      }
      // A record of either basis, and never anyone suppressed - a later "no" outranks an earlier yes.
      const suppressed = new Set(lower(answer.suppressed));
      const recorded = new Set(
        [...lower(answer.consented), ...lower(answer.softOptIn)].filter((e) => !suppressed.has(e)),
      );
      // A record names the questions of the event it was made at: another event's ids keep nothing here.
      const kept = new Map<string, readonly string[]>();
      for (const [email, scope] of Object.entries(answer.keptFields ?? {})) {
        if (scope && scope.eventId === ev.eventId && Array.isArray(scope.fieldIds)) kept.set(email.trim().toLowerCase(), scope.fieldIds);
      }
      incoming.push(
        ...buildAttendeeContacts(claims, {
          orderFields,
          eventTitle: ev.title,
          eventDate: ev.startDate,
          addedAt,
          recorded,
          kept,
        }),
      );
    }
    if (!incomplete) marks[ev.eventId] = mark(unopened);
  }

  const partial = failedEvents > 0 || unreadableOrders > 0;
  const done = (rest: Partial<SyncResult>, list: string | null | undefined): SyncResult => {
    deps.watermark.write({ ...(list !== undefined ? { list } : {}), events: marks });
    return result(partial ? "partial" : "ok", { failedEvents, unreadableOrders, ...rest });
  };

  // One person across several events is one candidate, merged by the same rule as the list.
  const candidates = applyDrain([], incoming).contacts;
  if (candidates.length === 0) return done({}, stamp);

  const mergeAndWrite = async (fail: (error: string) => SyncResult): Promise<SyncResult | typeof LIST_CHANGED> => {
    if (!deps.stillCurrent()) return fail("You switched accounts, so nothing was added.");

    let stored: { sealedList: SealedBoxV2; updatedAt: string } | null;
    let base: MarketingListPayload;
    try {
      stored = await deps.readList();
      base = stored ? await keys.openList(stored.sealedList) : { version: 1, contacts: [] };
    } catch (err) {
      return fail(message(err, "Could not open your list to add new buyers."));
    }

    const stamp = stored?.updatedAt ?? null;

    // Asked again, now: anyone who unsubscribed (or was suppressed any other way)
    // while the orders were being read is not added. No answer, no write.
    let latest: MarketingCheckResult;
    try {
      latest = await deps.check(candidates.map((c) => c.email));
    } catch (err) {
      return fail(message(err, "Could not check who said yes."));
    }
    const nowSuppressed = new Set(lower(latest.suppressed));
    const consentedNow = new Set(lower(latest.consented).filter((e) => !nowSuppressed.has(e)));
    const stillYes = new Set([...consentedNow, ...lower(latest.softOptIn).filter((e) => !nowSuppressed.has(e))]);
    const consentedAt = new Map(Object.entries(latest.consentedAt ?? {}).map(([e, t]) => [e.trim().toLowerCase(), t]));

    // Deleted by the organiser, per the list as it stands now: back only on an
    // "Email me" ticked after the deletion, which also clears the tombstone. A soft
    // opt-in after it is not enough.
    const tombstones = new Map(normaliseRemoved(base.removed).map((t) => [t.h, t]));
    const cleared = new Set<string>();
    const allowed = candidates.filter((c) => {
      const email = c.email.trim().toLowerCase();
      if (!stillYes.has(email)) return false;
      const tombstone = tombstones.get(removedId(deps.organiser, email));
      if (!tombstone) return true;
      const consented = consentedNow.has(email) ? Date.parse(consentedAt.get(email) ?? "") : NaN;
      if (!(consented > Date.parse(tombstone.at))) return false;
      cleared.add(tombstone.h);
      return true;
    });
    const report = applyDrain(base.contacts, allowed);
    if (report.added === 0 && report.updated === 0) return done({}, stamp);

    // The seal key is taken now, at write time, never at the start of the run.
    const seal = await deps.sealKeys();
    if (!seal) return result("locked", { failedEvents, unreadableOrders });
    if (!deps.stillCurrent()) return fail("You switched accounts, so nothing was added.");

    const payload = listPayload(report.contacts, [...tombstones.values()].filter((t) => !cleared.has(t.h)));
    let meta: MarketingListMeta;
    try {
      const sealed = await seal.sealList(payload);
      if (!(await seal.unchanged())) return result("locked", { failedEvents, unreadableOrders });
      meta = await deps.writeList(sealed, payload.contacts.map((c) => c.email), stamp);
    } catch (err) {
      if (isListChanged(err)) return LIST_CHANGED;
      return fail(message(err, "Could not save new buyers to your list."));
    }
    deps.published?.(payload, meta);
    return done({ added: report.added, updated: report.updated, written: { payload, meta } }, meta.updatedAt);
  };

  return deps.withLock(async () => {
    const fail = (error: string) => result("failed", { failedEvents, unreadableOrders, error });
    // Someone saved the list between the re-read and the write (the server refused
    // it): once more from a fresh re-read - merge, second check and seal again.
    for (let attempt = 1; ; attempt++) {
      const out = await mergeAndWrite(fail);
      if (out !== LIST_CHANGED) return out;
      if (attempt === 2) return fail("Your list kept changing while new buyers were being added.");
    }
  });
}

/** The server's answer when the list was saved after the caller's re-read (409). */
export const LIST_CHANGED = "LIST_CHANGED";

export function isListChanged(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === LIST_CHANGED;
}

// ── Throttle and lock ───────────────────────────────────────────────────────

export interface SyncGate<T> {
  /** The run in flight if there is one, else a new run if allowed, else null. */
  run(force: boolean, fn: () => Promise<T>): Promise<T> | null;
  readonly running: boolean;
}

/** Where the last run's start is kept so a reload honours the interval. Reads null when it cannot say. */
export interface StartStamp {
  read(): number | null;
  write(t: number | null): void;
}

/**
 * Never two runs at once, and at most one per `minIntervalMs` unless forced. A
 * run that `counts` returns false for (the account was locked, so nothing was
 * read) does not use up the window: unlocking should not wait an hour. The last
 * start is also kept in `stamp`, so a reload or another tab honours it; a stamp
 * that cannot be read, or lies in the future, is ignored - absent means run.
 */
export function createSyncGate<T>(opts: {
  minIntervalMs: number;
  now: () => number;
  counts: (r: T) => boolean;
  stamp?: StartStamp;
}): SyncGate<T> {
  let inFlight: Promise<T> | null = null;
  let lastStart: number | null = null;
  const stored = (): number | null => {
    let t: number | null = null;
    try {
      t = opts.stamp?.read() ?? null;
    } catch {
      return null;
    }
    return t !== null && Number.isFinite(t) && t <= opts.now() + 60_000 ? t : null;
  };
  const keep = (t: number | null) => {
    try {
      opts.stamp?.write(t);
    } catch {
      /* this tab still remembers it */
    }
  };
  return {
    run(force: boolean, fn: () => Promise<T>): Promise<T> | null {
      if (inFlight) return inFlight;
      const persisted = stored();
      const last = Math.max(lastStart ?? -Infinity, persisted ?? -Infinity);
      if (!force && last > -Infinity && opts.now() - last < opts.minIntervalMs) return null;
      const previous = lastStart;
      lastStart = opts.now();
      keep(lastStart);
      const p = fn().then((r) => {
        if (!opts.counts(r)) {
          lastStart = previous;
          keep(persisted);
        }
        return r;
      });
      inFlight = p.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get running() {
      return inFlight !== null;
    },
  };
}

/** A tab-wide mutex: each `fn` starts after the previous one settles, whatever it did. */
export function createLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

// ── What the Audience screen says ───────────────────────────────────────────

/** The last run, as the Audience screen shows it. */
export interface SyncRecord {
  at: number;
  status: SyncStatus;
  added: number;
  failedEvents: number;
  unreadableOrders: number;
  error?: string;
  /** The organiser pressed Check now (and so was asked to confirm it's them). */
  manual?: boolean;
}

export function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One plain line, and whether it needs the organiser's attention. */
export function describeSync(rec: SyncRecord | null, running: boolean, now: number): { text: string; warn: boolean } {
  if (running) return { text: "Checking your events for new buyers…", warn: false };
  if (!rec) return { text: "Not checked on this device yet.", warn: false };
  const ago = agoText(now - rec.at);
  if (rec.status === "locked") {
    // In the background nothing is asked, so the buyers wait for a tap; after a tap, the confirm did not happen.
    return rec.manual
      ? { text: "Couldn't confirm it's you, so no one was added yet. Press Check now to try again.", warn: true }
      : { text: "New buyers are waiting - press Check now to confirm it's you and add them.", warn: true };
  }
  if (rec.status === "failed") {
    const why = rec.error ? ` ${rec.error.trim().replace(/\.?$/, ".")}` : "";
    // One piece of advice: an error that already says what to do next is not followed by a second.
    const advice = /try again/i.test(why) ? "" : " Press Check now to try again.";
    return { text: `Couldn't finish checking ${ago}.${why}${advice}`, warn: true };
  }
  const parts = [`Last checked ${ago} - ${rec.added > 0 ? `${rec.added.toLocaleString()} added` : "no one new"}.`];
  if (rec.failedEvents > 0) {
    parts.push(`${plural(rec.failedEvents, "event", "events")} couldn't be read, so we'll try again next time.`);
  }
  if (rec.unreadableOrders > 0) {
    parts.push(`${plural(rec.unreadableOrders, "order", "orders")} couldn't be opened on this device.`);
  }
  const stale = now - rec.at >= STALE_MS;
  if (stale) parts.push("Press Check now to look for new buyers.");
  return { text: parts.join(" "), warn: stale || rec.status === "partial" };
}
