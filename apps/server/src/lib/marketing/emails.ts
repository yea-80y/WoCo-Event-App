/**
 * Address normalisation for the marketing endpoints.
 *
 * The rule this module encodes: a marketing list is the organiser's OWN data,
 * held as ciphertext the server cannot open. The `emails` array that comes with
 * it exists only to be hashed — for dedupe, suppression matching and broadcast
 * membership. Nothing downstream reads it as a mailbox.
 *
 * So content is never grounds for refusing a write. The previous normaliser
 * returned null if ANY entry failed the format check, and because every list
 * change re-uploads the WHOLE list, one unmailable row would have frozen every
 * later edit — delete, rename, add — behind a message naming neither the
 * address nor the rule (#136). Worse, the same all-or-nothing check on
 * `/check` is reached today: a single buyer whose claim address passed the
 * looser gate at `claims.ts` (`includes("@")`) 400s the entire "Add from your
 * events" scan.
 *
 * What replaces it: every string entry is kept and hashed, so the server's hash
 * index keeps mirroring the sealed blob the organiser can see — the property
 * that subject-access (`listsContaining`) and erasure (`removeFromLists`)
 * depend on. Entries that cannot be mailed are reported, not dropped, so the
 * organiser learns about them instead of losing them.
 *
 * Format is still enforced, but where it belongs: at send time, on the
 * broadcast chunk endpoint. That gate must stay strict — `drain-worker.ts`
 * classifies provider stop-reasons on the fact that a recipient address admits
 * no whitespace, so relaxing it there would quietly break something else.
 */

import { MAILABLE_EMAIL_RE } from "@woco/shared";

/** Enough for the organiser to recognise the rows; not a full echo of the list. */
const SAMPLE_SIZE = 10;

export interface NormalizedEmails {
  /** Every string entry, trimmed and lowercased, order and duplicates preserved. */
  emails: string[];
  /** Sample of entries that are stored but cannot be mailed. */
  unmailable: string[];
  unmailableCount: number;
  /**
   * Entries that were not strings at all. Counted, never echoed: a well-formed
   * sealed payload cannot produce one, so this is malformed input rather than
   * organiser data worth quoting back.
   */
  droppedCount: number;
}

/**
 * @returns null ONLY for shape or size — not an array, or longer than `max`.
 *          Those are the caller's mistakes; content never is.
 */
export function normalizeEmails(raw: unknown, max: number): NormalizedEmails | null {
  if (!Array.isArray(raw) || raw.length > max) return null;

  const emails: string[] = [];
  const unmailable: string[] = [];
  let unmailableCount = 0;
  let droppedCount = 0;

  for (const entry of raw) {
    if (typeof entry !== "string") {
      droppedCount++;
      continue;
    }
    const norm = entry.trim().toLowerCase();
    emails.push(norm);
    if (!MAILABLE_EMAIL_RE.test(norm)) {
      unmailableCount++;
      if (unmailable.length < SAMPLE_SIZE) unmailable.push(norm);
    }
  }

  return { emails, unmailable, unmailableCount, droppedCount };
}
