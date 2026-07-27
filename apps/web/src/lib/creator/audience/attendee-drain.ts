/**
 * Turning ticket buyers into marketing contacts — pure, so the merge rule can
 * be tested without a browser.
 *
 * Only buyers who ticked the opt-in themselves get here. The caller decrypts
 * claim data in the organiser's browser (the server holds no plaintext) and
 * asks `/api/marketing/check` which of those addresses carry a consent record;
 * this module does the shaping and the merge.
 */

import type { MarketingContact } from "@woco/shared";

/** The subset of a decrypted claim blob this needs. */
export interface DecryptedClaim {
  fields?: Record<string, string>;
  claimerEmail?: string;
}

/**
 * How much to trust a value, by where it came from.
 *
 * Blanket "newest wins" is wrong: a name the attendee typed at their own
 * checkout is first-party, while a name in a third-party CSV is unverified and
 * may be stale, mis-keyed, or a different person on a shared household inbox.
 * Letting a later import overwrite self-reported data by timestamp alone makes
 * the record worse, and Art. 5(1)(d) asks for accurate, not merely recent.
 */
export function provenanceRank(source: string | undefined): number {
  if (source?.startsWith("event:")) return 2;
  if (source === "manual") return 1;
  return 0; // csv: import, or unrecorded
}

/**
 * Common order-form field ids that hold a name. Order forms are organiser-
 * defined, so this is a guess over their ids — and a guess that only ever
 * ADDS a name to a contact that has none, never overwrites one.
 */
const FIRST_KEYS = ["firstname", "first_name", "first", "givenname", "forename"];
const LAST_KEYS = ["lastname", "last_name", "last", "surname", "familyname"];
const FULL_KEYS = ["name", "fullname", "full_name", "attendeename", "yourname"];

function pick(fields: Record<string, string> | undefined, keys: string[]): string | undefined {
  if (!fields) return undefined;
  for (const [k, v] of Object.entries(fields)) {
    const norm = k.toLowerCase().replace(/[\s_-]/g, "");
    if (keys.some((want) => norm === want.replace(/[\s_-]/g, "")) && v?.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

export interface DrainOptions {
  eventTitle: string;
  eventDate?: string;
  addedAt: string;
  /** Lowercased addresses holding a consent record for this organiser. */
  consented: ReadonlySet<string>;
}

/**
 * Build contacts from decrypted claims, keeping only those who opted in.
 *
 * De-duplicated on the lowercased address: one person buying four tickets to
 * the same event is one contact, not four.
 */
export function buildAttendeeContacts(
  claims: readonly DecryptedClaim[],
  { eventTitle, eventDate, addedAt, consented }: DrainOptions,
): MarketingContact[] {
  const byEmail = new Map<string, MarketingContact>();

  for (const claim of claims) {
    const email = claim.claimerEmail?.trim().toLowerCase();
    if (!email || !consented.has(email) || byEmail.has(email)) continue;

    let firstName = pick(claim.fields, FIRST_KEYS);
    let lastName = pick(claim.fields, LAST_KEYS);
    if (!firstName && !lastName) {
      const full = pick(claim.fields, FULL_KEYS);
      // No splitting here — a single name field goes to firstName whole, for
      // the same reason splitFullName exists but is not reached for: this is a
      // greeting line, and an invented surname reads worse than a full name.
      if (full) firstName = full;
    }

    byEmail.set(email, {
      email,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      lastEventName: eventTitle,
      ...(eventDate ? { lastEventDate: eventDate } : {}),
      source: `event:${eventTitle}`,
      addedAt,
    });
  }

  return [...byEmail.values()];
}

/**
 * Merge one incoming contact over an existing one, field by field.
 *
 * Two rules, both of which "newest wins" gets wrong:
 *   - Absence is not an update. A record that omits a field must never blank a
 *     field an earlier one filled.
 *   - A lower-trust source does not overwrite a higher-trust one. Equal rank
 *     falls back to the incoming value, which is the newer of the two.
 *
 * Consent is NOT merged here and must never be: it lives in the suppression and
 * consent stores, where a refusal already survives any re-upload.
 */
export function mergeContact(existing: MarketingContact, incoming: MarketingContact): MarketingContact {
  const incomingWins = provenanceRank(incoming.source) >= provenanceRank(existing.source);
  const merged: MarketingContact = { ...existing };

  for (const [key, value] of Object.entries(incoming) as Array<[keyof MarketingContact, string]>) {
    if (key === "email" || key === "addedAt" || key === "source") continue;
    if (!value) continue;
    if (!merged[key] || incomingWins) (merged[key] as string) = value;
  }

  // `addedAt` records when this person entered the audience, so the EARLIER one
  // is the true answer — a re-import must not make a two-year contact look new.
  merged.addedAt = existing.addedAt < incoming.addedAt ? existing.addedAt : incoming.addedAt;
  if (incomingWins && incoming.source) merged.source = incoming.source;

  return merged;
}

export interface DrainReport {
  /** The list to commit — existing contacts, merged and extended. */
  contacts: MarketingContact[];
  added: number;
  updated: number;
}

/** Fold opted-in attendees into the stored list. */
export function applyDrain(
  existing: readonly MarketingContact[],
  incoming: readonly MarketingContact[],
): DrainReport {
  const byEmail = new Map(existing.map((c) => [c.email.toLowerCase(), c]));
  let added = 0;
  let updated = 0;

  for (const c of incoming) {
    const key = c.email.toLowerCase();
    const prev = byEmail.get(key);
    if (!prev) {
      byEmail.set(key, c);
      added++;
      continue;
    }
    const merged = mergeContact(prev, c);
    // Only count a real change — "updated 400 contacts" on a re-run where
    // nothing moved is a lie the organiser would reasonably act on.
    if (JSON.stringify(merged) !== JSON.stringify(prev)) {
      byEmail.set(key, merged);
      updated++;
    }
  }

  return { contacts: [...byEmail.values()], added, updated };
}
