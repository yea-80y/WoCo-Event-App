/**
 * Marketing consent record — the evidence side of the suppression store.
 *
 * UK GDPR Art. 7(1) requires the controller to *demonstrate* that consent was
 * given, not merely to act on it. PECR reg. 22 additionally allows the "soft
 * opt-in" only where an opt-out was offered when the address was collected.
 * Neither is satisfiable from the sealed order blob: that is encrypted to the
 * organiser, so WoCo could never produce evidence, and an organiser could
 * assert whatever it liked after the fact.
 *
 * So the decision is recorded here, keyed by HMAC email hash (never plaintext),
 * with what the person was actually shown at the time. A DECLINE is not stored
 * here — it is written straight into the suppression store, which is already
 * checked on every send. That way "no" needs no new enforcement path and cannot
 * be bypassed by re-uploading a CSV.
 *
 * MUST survive server restarts — losing this loses the lawful basis for every
 * soft opt-in send that depends on it.
 *
 * One store for both bases (2026-10-14): a CONSENT record (ticked "Email me")
 * and a SOFT-OPT-IN record (bought a ticket, shown "Don't email me", left it
 * unticked). The basis is fixed when the choice is made and never re-read from
 * the organiser's current mode, so switching modes needs no re-permissioning.
 *
 * PRESENT BUT UNREADABLE (#882): never written over, which would destroy every
 * other record's evidence; reads answer from an empty store, so "no record" then
 * means UNKNOWN, never absent (`consentStoreReadable`), the subject-access read
 * throws, and `/api/health` `marketingConsent` alarms until an operator restores
 * it and restarts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketingBasis, MarketingSurface } from "@woco/shared";
import { recordRefusedWrite, writeJsonAtomic } from "./persist.js";
import { suppressedSince } from "./suppression-store.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-consent.json");

/** Where the consent decision was captured. */
export type ConsentSource = "checkout" | "csv-import" | "signup";

export interface ConsentRecord {
  ts: string;
  source: ConsentSource;
  /** Event the person was buying when asked — scopes what they agreed to. */
  eventId?: string;
  /** Verbatim wording shown at the point of collection. Art. 7(1) evidence:
   *  a hash or paraphrase would not prove what was actually agreed to. For a
   *  soft opt-in, the sentence above the box; the box's own label is `control`. */
  notice: string;
  /** The checkbox label, when it is not `notice` itself (soft opt-in: "Don't email me..."). */
  control?: string;
  /** Absent on records written before the soft opt-in existed, which were all consent. */
  basis?: MarketingBasis;
  /** Which checkout showed the control. */
  surface?: MarketingSurface;
  /**
   * The wording version for the record's mode at capture time (consent:
   * `MARKETING_CONSENT_VERSION`; soft opt-in: `MARKETING_OWN_EVENTS_VERSION`). The verbatim `notice` is the
   * evidence; this is the cheap index for "which wording did this cohort agree
   * to" once the text has changed more than once. Optional because records
   * written before this field existed do not carry it.
   */
  version?: number;
}

/** organiserAddress → emailHash → record */
type Store = Record<string, Record<string, ConsentRecord>>;

const consents: Store = {};
let loaded = false;
let fileUnreadable: string | null = null;

function refuseFile(why: string): void {
  fileUnreadable = why;
  console.error(
    `[consent] ALARM: marketing-consent.json ${why} - consent records read as unknown, and the file ` +
      "will NOT be written until it is restored and the server restarted (/api/health marketingConsent)",
  );
}

/** Thrown by the subject-access read: an Art. 15 answer of "none" from an unreadable file would be false. */
export class ConsentStoreUnavailableError extends Error {
  constructor() {
    super("The marketing consent records cannot be read right now - restore marketing-consent.json first");
    this.name = "ConsentStoreUnavailableError";
  }
}

const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(STORE_FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return; // first boot
    return refuseFile(`exists but could not be read (${code ?? "unknown error"})`);
  }
  try {
    const obj = JSON.parse(raw) as unknown;
    // A wrong shape must refuse here, not throw on every read later.
    const orgs = isObject(obj) ? Object.values(obj as Store) : null;
    if (!orgs || !orgs.every((byHash) => isObject(byHash) && Object.values(byHash).every(isObject))) {
      throw new Error("unexpected shape");
    }
    Object.assign(consents, obj as Store);
    const n = Object.values(consents).reduce((a, o) => a + Object.keys(o).length, 0);
    console.log(`[consent] Loaded ${n} consent records from disk`);
  } catch {
    refuseFile("could not be parsed");
  }
}

function persistToDisk(): boolean {
  // Writing now would replace the operator's only copy.
  if (fileUnreadable) return recordRefusedWrite(STORE_FILE, "consent");
  return writeJsonAtomic(STORE_FILE, consents, "consent");
}

/**
 * False while the file is present but unreadable. Every read then answers from
 * an empty store, so a caller that would ERASE or REPORT on "no record" must ask
 * this first: unknown is not absent.
 */
export function consentStoreReadable(): boolean {
  ensureLoaded();
  return fileUnreadable === null;
}

/** @returns whether the record reached disk - false while the file is unreadable or the write failed. */
export function recordConsent(
  emailHash: string,
  organiserAddress: string,
  record: ConsentRecord,
): boolean {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  (consents[org] ??= {})[emailHash] = record;
  return persistToDisk();
}

export function getConsent(emailHash: string, organiserAddress: string): ConsentRecord | null {
  ensureLoaded();
  return consents[organiserAddress.toLowerCase()]?.[emailHash] ?? null;
}

/** A record's basis. Records from before the soft opt-in carry none and were all consent. */
export function consentBasis(record: Pick<ConsentRecord, "basis">): MarketingBasis {
  return record.basis === "soft-opt-in" ? "soft-opt-in" : "consent";
}

/** The basis this organiser holds for one address, or null when there is no record. */
export function basisFor(emailHash: string, organiserAddress: string): MarketingBasis | null {
  const r = getConsent(emailHash, organiserAddress);
  return r ? consentBasis(r) : null;
}

/**
 * Which of `hashes` hold a record for this organiser - of `basis` only, when given.
 *
 * Mirrors `suppressedSubset`. Together they give the audience UI its four
 * states — opted in (consent, the evidence exists); bought a ticket and did not
 * opt out (soft opt-in, the evidence exists); neither, on the list under the
 * organiser's own import warranty; in suppression, never mailed. Those are very
 * different legal positions and the organiser cannot see which they are holding
 * unless the UI tells them.
 */
export function consentedSubset(organiserAddress: string, hashes: string[], basis?: MarketingBasis): string[] {
  ensureLoaded();
  const byHash = consents[organiserAddress.toLowerCase()];
  if (!byHash) return [];
  return hashes.filter((h) => byHash[h] && (!basis || consentBasis(byHash[h]) === basis));
}

/** Subject-access support: every organiser this address consented to. */
export function consentsForEmailHash(emailHash: string): Array<{ org: string; record: ConsentRecord }> {
  ensureLoaded();
  if (fileUnreadable) throw new ConsentStoreUnavailableError();
  const out: Array<{ org: string; record: ConsentRecord }> = [];
  for (const [org, byHash] of Object.entries(consents)) {
    const record = byHash[emailHash];
    if (record) out.push({ org, record });
  }
  return out;
}

/** Erasure support — drops the record for one address across all organisers. */
export function forgetEmailHash(emailHash: string): number {
  ensureLoaded();
  let removed = 0;
  for (const byHash of Object.values(consents)) {
    if (byHash[emailHash]) {
      delete byHash[emailHash];
      removed++;
    }
  }
  if (removed) persistToDisk();
  return removed;
}

/**
 * How long consent evidence outlives the basis it supports - Privacy Policy
 * §10, "while the organiser can still mail you on that basis, plus 6 months".
 */
export const CONSENT_KEPT_AFTER_BASIS_MS = 183 * 24 * 60 * 60 * 1000;

/** A sweep's drops are already gone from memory, so a failed write must be retried by flag. */
let sweepUnpersisted = false;

/**
 * Drop consent records whose basis ended more than six months ago (#547).
 *
 * The basis ends when the address becomes unmailable for that organiser: an
 * unsubscribe, a decline, a complaint or a bounce, dated by its suppression
 * mark. Not being on the organiser's contact list is NOT an end - a checkout
 * opt-in is usually added to a list later. A record whose basis still stands is
 * kept however old, which is what the policy says. A record made AFTER the mark
 * (a renewed opt-in the mark still blocks) is dated from itself, not the mark.
 *
 * @returns how many records were dropped.
 */
export function sweepExpiredConsents(
  basisEndedAt: (emailHash: string, organiserAddress: string) => string | null = suppressedSince,
  now: number = Date.now(),
): number {
  ensureLoaded();
  let dropped = 0;
  for (const [org, byHash] of Object.entries(consents)) {
    for (const hash of Object.keys(byHash)) {
      const ended = basisEndedAt(hash, org);
      if (!ended) continue;
      const endedMs = Math.max(Date.parse(ended), Date.parse(byHash[hash].ts) || 0);
      if (now - endedMs > CONSENT_KEPT_AFTER_BASIS_MS) {
        delete byHash[hash];
        dropped++;
      }
    }
    if (Object.keys(byHash).length === 0) delete consents[org];
  }
  if (dropped || sweepUnpersisted) {
    sweepUnpersisted = !persistToDisk();
    if (sweepUnpersisted) console.warn(`[consent] sweep write failed; retrying on the next sweep`);
  }
  return dropped;
}

/**
 * Erasure scoped to one controller. An Art. 17 request usually names the
 * organiser the person actually dealt with, and erasing their record with every
 * OTHER organiser would destroy those organisers' lawful-basis evidence for
 * sends the subject never objected to.
 */
export function forgetEmailHashForOrg(emailHash: string, organiserAddress: string): boolean {
  ensureLoaded();
  const byHash = consents[organiserAddress.toLowerCase()];
  if (!byHash?.[emailHash]) return false;
  delete byHash[emailHash];
  persistToDisk();
  return true;
}

/** `/api/health` → `marketingConsent`. `ok: false` = present but unreadable (see the header). */
export function consentStoreHealth(): { ok: boolean; unreadable: boolean } {
  ensureLoaded();
  return { ok: fileUnreadable === null, unreadable: fileUnreadable !== null };
}

/** Tests only: forget memory so the next call reloads from disk. */
export function __resetConsentStoreForTest(): void {
  for (const org of Object.keys(consents)) delete consents[org];
  fileUnreadable = null;
  sweepUnpersisted = false;
  loaded = false;
}
