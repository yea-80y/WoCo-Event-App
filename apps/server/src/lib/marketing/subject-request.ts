/**
 * UK GDPR Art. 15 (access) and Art. 17 (erasure) over the marketing stores.
 *
 * The logic lives here rather than in `scripts/data-subject-request.ts` so it
 * can be unit-tested. The ordering rule below is the whole point of the module
 * and is not something to re-derive at 2am inside a statutory clock.
 */

import { consentsForEmailHash, forgetEmailHash, forgetEmailHashForOrg, type ConsentRecord } from "./consent-store.js";
import { listsContaining, removeFromLists } from "./list-store.js";
import { persistFailureCount } from "./persist.js";
import { marksFor, suppressGlobal, suppressOrg } from "./suppression-store.js";

export interface SubjectReport {
  emailHash: string;
  /** Consent records held, filtered to `organiser` when one is given. */
  consents: Array<{ org: string; record: ConsentRecord }>;
  /** Organisers whose stored list index contains this hash. */
  lists: string[];
  /** Every suppression mark held. Reported, never erased. */
  marks: ReturnType<typeof marksFor>;
}

export interface ErasureResult {
  consentsErased: number;
  listsRemovedFrom: string[];
  suppression: "global" | "organiser";
  /**
   * False if ANY store failed to write. The operator must know: an erasure that
   * only happened in memory reverts on the next restart, and by then they have
   * already told the subject it was actioned.
   */
  persisted: boolean;
}

/** Art. 15 — everything the marketing stores hold about one address. */
export function reportSubject(emailHash: string, organiser?: string): SubjectReport {
  const org = organiser?.toLowerCase();
  return {
    emailHash,
    consents: consentsForEmailHash(emailHash).filter((c) => !org || c.org === org),
    lists: listsContaining(emailHash).filter((o) => !org || o === org),
    marks: marksFor(emailHash),
  };
}

/**
 * Art. 17 — erase what we hold, then bar re-entry.
 *
 * ORDER IS LOAD-BEARING. Suppress FIRST. If this dies between the two steps, an
 * over-suppressed subject is a recoverable annoyance; an erased consent record
 * with no suppression mark leaves the person exposed to the organiser's next
 * contact upload — the exact harm the request was made to stop.
 *
 * Suppression marks themselves are NEVER erased: under Art. 17(3)(b) the record
 * of an objection is what lets the controller keep honouring it.
 *
 * @param organiser scope to one controller. An unscoped erasure would destroy
 *   every OTHER organiser's lawful-basis evidence for sends this subject never
 *   objected to, so a request naming one organiser must stay narrow.
 */
export function eraseSubject(emailHash: string, organiser?: string, at: string = new Date().toISOString()): ErasureResult {
  const org = organiser?.toLowerCase();
  const failuresBefore = persistFailureCount();

  if (org) {
    suppressOrg(emailHash, org, "manual", at);
  } else {
    suppressGlobal(emailHash, "manual");
  }

  const consentsErased = org
    ? (forgetEmailHashForOrg(emailHash, org) ? 1 : 0)
    : forgetEmailHash(emailHash);

  const listsRemovedFrom = removeFromLists(emailHash, org);

  return {
    consentsErased,
    listsRemovedFrom,
    suppression: org ? "organiser" : "global",
    persisted: persistFailureCount() === failuresBefore,
  };
}
