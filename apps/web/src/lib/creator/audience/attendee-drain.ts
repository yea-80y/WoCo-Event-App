/**
 * Turning ticket buyers into marketing contacts — pure, so the merge rule can
 * be tested without a browser.
 *
 * Only buyers who said yes at checkout get here: they ticked the opt-in, or
 * (in own-events mode) were shown "Don't email me" and left it alone - the soft
 * opt-in. The caller decrypts claim data in the organiser's browser (the server
 * holds no plaintext) and asks `/api/marketing/check` which of those addresses
 * carry a record of either basis; this module does the shaping and the merge.
 */

import { isKeptOnList, orderFieldKind, type MarketingContact, type OrderField } from "@woco/shared";

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

export interface DrainOptions {
  /**
   * The event's questions. Only answers to those the organiser ticked "Keep on
   * mailing list" are copied (owner 2026-10-13): everything else stays with the
   * booking and is deleted with it, and a health answer never moves.
   */
  orderFields: readonly OrderField[];
  eventTitle: string;
  eventDate?: string;
  addedAt: string;
  /** Lowercased addresses holding a checkout record for this organiser: consent or soft opt-in. */
  recorded: ReadonlySet<string>;
}

/**
 * Build contacts from decrypted claims, keeping only those with a record.
 *
 * De-duplicated on the lowercased address: one person buying four tickets to
 * the same event is one contact, not four.
 */
export function buildAttendeeContacts(
  claims: readonly DecryptedClaim[],
  { orderFields, eventTitle, eventDate, addedAt, recorded }: DrainOptions,
): MarketingContact[] {
  const byEmail = new Map<string, MarketingContact>();

  for (const claim of claims) {
    const email = claim.claimerEmail?.trim().toLowerCase();
    if (!email || !recorded.has(email) || byEmail.has(email)) continue;

    const kept = keptAnswers(claim.fields, orderFields);
    byEmail.set(email, {
      email,
      ...kept,
      lastEventName: eventTitle,
      ...(eventDate ? { lastEventDate: eventDate } : {}),
      source: `event:${eventTitle}`,
      addedAt,
    });
  }

  return [...byEmail.values()];
}

type KeptFields = Pick<MarketingContact, "firstName" | "lastName" | "postcode" | "city" | "phone" | "answers">;

/**
 * A buyer's kept answers, placed by what each question asks: names, postcode,
 * town and phone into the contact's own fields (so the list can be searched by
 * area), anything else under its label. Answers are keyed by question id, so
 * the label is read from the event's own form.
 */
function keptAnswers(fields: Record<string, string> | undefined, orderFields: readonly OrderField[]): KeptFields {
  const out: KeptFields = {};
  const answers: Record<string, string> = {};
  for (const field of orderFields) {
    if (!isKeptOnList(field)) continue;
    const value = fields?.[field.id]?.trim();
    const label = field.label.trim();
    if (!value || !label) continue;
    const slot = orderFieldKind(label).slot;
    // A single name field goes to firstName whole: this is a greeting line, and
    // an invented surname reads worse than a full name.
    if (slot === "fullName") out.firstName ??= value;
    else if (slot) out[slot] ??= value;
    else answers[label] ??= value;
  }
  if (Object.keys(answers).length) out.answers = answers;
  return out;
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
  const incomingWins = outranks(incoming, existing);
  const merged: MarketingContact = { ...existing };

  for (const [key, value] of Object.entries(incoming) as Array<[keyof MarketingContact, string]>) {
    if (key === "email" || key === "addedAt" || key === "source" || key === "answers") continue;
    if (!value) continue;
    if (!merged[key] || incomingWins) (merged[key] as string) = value;
  }

  // Kept answers merge question by question under the same two rules.
  if (incoming.answers) {
    const answers = { ...existing.answers };
    for (const [label, value] of Object.entries(incoming.answers)) {
      if (value && (!answers[label] || incomingWins)) answers[label] = value;
    }
    merged.answers = answers;
  }

  // `addedAt` records when this person entered the audience, so the EARLIER one
  // is the true answer — a re-import must not make a two-year contact look new.
  merged.addedAt = existing.addedAt < incoming.addedAt ? existing.addedAt : incoming.addedAt;
  if (incomingWins && incoming.source) merged.source = incoming.source;

  return merged;
}

/**
 * Equal rank falls to the incoming record, the newer of the two - except between two
 * checkouts, where the later EVENT is the fresher record whichever was read last. The
 * automatic sync re-reads an older event whenever its orders change, and must not turn
 * a contact's last event back to it. An unparseable date never decides (NaN < x is false).
 */
function outranks(incoming: MarketingContact, existing: MarketingContact): boolean {
  const rank = provenanceRank(incoming.source);
  if (rank !== provenanceRank(existing.source)) return rank > provenanceRank(existing.source);
  const older = Date.parse(incoming.lastEventDate ?? "") < Date.parse(existing.lastEventDate ?? "");
  return !(rank === 2 && older);
}

export interface DrainReport {
  /** The list to commit — existing contacts, merged and extended. */
  contacts: MarketingContact[];
  added: number;
  updated: number;
}

/** Fold attendees with a checkout record into the stored list. */
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
