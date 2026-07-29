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
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
   *  a hash or paraphrase would not prove what was actually agreed to. */
  notice: string;
  /**
   * `MARKETING_CONSENT_VERSION` at capture time. The verbatim `notice` is the
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

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    Object.assign(consents, JSON.parse(raw) as Store);
    const n = Object.values(consents).reduce((a, o) => a + Object.keys(o).length, 0);
    console.log(`[consent] Loaded ${n} consent records from disk`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(consents), "utf-8");
  } catch (err) {
    console.error("[consent] Failed to persist to disk:", err);
  }
}

export function recordConsent(
  emailHash: string,
  organiserAddress: string,
  record: ConsentRecord,
): void {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  (consents[org] ??= {})[emailHash] = record;
  persistToDisk();
}

export function getConsent(emailHash: string, organiserAddress: string): ConsentRecord | null {
  ensureLoaded();
  return consents[organiserAddress.toLowerCase()]?.[emailHash] ?? null;
}

/**
 * Which of `hashes` hold a consent record for this organiser.
 *
 * Mirrors `suppressedSubset`. The two together give the audience UI its three
 * states — a contact with a record opted in and the evidence exists; one with
 * neither is on the list under the organiser's own import warranty; one in
 * suppression is never mailed. Those are very different legal positions and the
 * organiser cannot see which they are holding unless the UI tells them.
 */
export function consentedSubset(organiserAddress: string, hashes: string[]): string[] {
  ensureLoaded();
  const byHash = consents[organiserAddress.toLowerCase()];
  if (!byHash) return [];
  return hashes.filter((h) => byHash[h]);
}

/** Subject-access support: every organiser this address consented to. */
export function consentsForEmailHash(emailHash: string): Array<{ org: string; record: ConsentRecord }> {
  ensureLoaded();
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
