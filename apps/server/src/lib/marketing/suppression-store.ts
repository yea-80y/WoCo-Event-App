/**
 * Marketing suppression list — the enforcement layer for unsubscribes.
 *
 * Keyed by HMAC email hash (hashEmail), never plaintext. Checked on EVERY
 * marketing/broadcast send, so an unsubscribe survives the organiser
 * re-uploading the same CSV. Per-organiser scope by default (the organiser is
 * the data controller under GDPR); global scope for "block all marketing via
 * WoCo", bounces and spam complaints.
 *
 * MUST survive server restarts — same rule as consumed-tx-hashes.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-suppression.json");

// "declined" = opted out at the point of collection (checkout). Recorded as a
// suppression rather than an absent consent so the refusal is enforced by the
// same check as an unsubscribe, and survives a later CSV re-upload.
export type SuppressSource = "unsub" | "unsub_all" | "bounce" | "complaint" | "manual" | "declined";

interface SuppressionMark {
  ts: string;
  source: SuppressSource;
  /**
   * Set when a LATER affirmative decision superseded this mark (see
   * `liftDeclineOnConsent`). The mark is kept rather than deleted: it is the
   * record that a refusal was once made and honoured, which is exactly what an
   * Art. 7(1) / PECR audit would ask to see. A lifted mark does not suppress.
   */
  liftedAt?: string;
  liftedBy?: "consent";
}

/** A mark only suppresses while it has not been superseded. */
function suppresses(mark: SuppressionMark | undefined): boolean {
  return Boolean(mark && !mark.liftedAt);
}

interface SuppressionEntry {
  global?: SuppressionMark;
  orgs: Record<string, SuppressionMark>;
}

const entries = new Map<string, SuppressionEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, SuppressionEntry>;
    for (const [hash, entry] of Object.entries(obj)) entries.set(hash, entry);
    console.log(`[suppression] Loaded ${entries.size} suppressed addresses from disk`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(entries)), "utf-8");
  } catch (err) {
    console.error("[suppression] Failed to persist to disk:", err);
  }
}

function getOrCreate(emailHash: string): SuppressionEntry {
  let entry = entries.get(emailHash);
  if (!entry) {
    entry = { orgs: {} };
    entries.set(emailHash, entry);
  }
  return entry;
}

/**
 * Suppress this address for one organiser's marketing (unsubscribe default scope).
 *
 * @param ts ISO timestamp of the DECISION, when the caller knows it. Defaults to
 *   now. It matters because `liftDeclineOnConsent` orders a decline against a
 *   later consent: stamping the write time instead of the decision time would
 *   make a card sale (recorded in the Stripe webhook, minutes later) look newer
 *   than it is and silently swallow a genuine opt-in.
 */
export function suppressOrg(
  emailHash: string,
  organiserAddress: string,
  source: SuppressSource,
  ts: string = new Date().toISOString(),
): void {
  ensureLoaded();
  const entry = getOrCreate(emailHash);
  const org = organiserAddress.toLowerCase();
  // First ACTIVE mark wins — an earlier unsub isn't downgraded by a later
  // re-mark. A lifted mark is not active: once an affirmative consent has
  // superseded a decline, a subsequent refusal is a genuinely new decision and
  // must be able to suppress again, or the person is stuck opted-in.
  if (!suppresses(entry.orgs[org])) {
    entry.orgs[org] = { ts, source };
    persistToDisk();
  }
}

/** Suppress this address for ALL marketing via the platform (opt-all, bounce, complaint). */
export function suppressGlobal(emailHash: string, source: SuppressSource): void {
  ensureLoaded();
  const entry = getOrCreate(emailHash);
  if (!suppresses(entry.global)) {
    entry.global = { ts: new Date().toISOString(), source };
    persistToDisk();
  }
}

/**
 * Lift a per-organiser suppression that was created by a checkout REFUSAL,
 * because the same person later gave that same organiser an affirmative opt-in.
 *
 * Deliberately narrow. Only `"declined"` marks can be lifted, and only by
 * evidence of the same class that created them (a point-of-collection decision
 * captured in the consent store). `unsub` / `unsub_all` / `bounce` / `complaint`
 * are NEVER lifted here — an unsubscribe outranks a later checkbox, and
 * resubscribe is a double-opt-in flow (#60), not a side effect of buying a
 * ticket. Global marks are never touched at all.
 *
 * Without this, the refusal was permanent: `ClaimButton` records a shown-but-
 * untouched box as an explicit decline, so ignoring the checkbox once locked the
 * buyer out of that organiser's mail forever, while `recordConsent` went on
 * writing Art. 7(1) evidence that every send silently contradicted.
 *
 * @param consentTs ISO timestamp of the affirmative decision. Must be strictly
 *   newer than the mark — an older consent cannot undo a newer refusal.
 * @returns true if a mark was actually lifted.
 */
export function liftDeclineOnConsent(
  emailHash: string,
  organiserAddress: string,
  consentTs: string,
): boolean {
  ensureLoaded();
  const entry = entries.get(emailHash);
  if (!entry) return false;
  const org = organiserAddress.toLowerCase();
  const mark = entry.orgs[org];
  if (!suppresses(mark) || mark!.source !== "declined") return false;
  if (!(Date.parse(consentTs) > Date.parse(mark!.ts))) return false;

  mark!.liftedAt = consentTs;
  mark!.liftedBy = "consent";
  persistToDisk();
  return true;
}

/** Is this address suppressed for this organiser (globally or per-org)? */
export function isSuppressed(emailHash: string, organiserAddress: string): boolean {
  ensureLoaded();
  const entry = entries.get(emailHash);
  if (!entry) return false;
  return suppresses(entry.global) || suppresses(entry.orgs[organiserAddress.toLowerCase()]);
}

/** Subset of the given hashes that are suppressed for this organiser. */
export function suppressedSubset(organiserAddress: string, emailHashes: string[]): string[] {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  return emailHashes.filter((h) => {
    const entry = entries.get(h);
    return Boolean(entry) && (suppresses(entry!.global) || suppresses(entry!.orgs[org]));
  });
}
