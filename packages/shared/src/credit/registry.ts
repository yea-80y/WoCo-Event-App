/**
 * The subject registry — what a `subject` hash MEANS.
 *
 * NOT FROZEN, and deliberately so. `CreditStatementV1` is permanent because
 * rider feeds are write-once; this is the opposite kind of object. The plan
 * classifies the registry and authorisation layer as "disposable machinery"
 * (docs/COASTER_CREDITS_PLAN.md, "What handover does not yet cover"), because
 * a wrong name is fixed by editing a lookup table while a wrong schema is
 * inherited by every credit ever written. Only the hash <-> id binding below
 * is permanent.
 *
 * Why the id is opaque rather than the name or an RCDB id: a subject hash can
 * never change, so anything mutable hashed into it is a future orphan. Coasters
 * are re-themed, relocated and re-tracked, and RCDB id semantics under those
 * events are unverified. An opaque WoCo-minted id keeps identity immutable and
 * pushes every mutable fact — including the name — into this table, where it
 * can be corrected. External ids live on as ALIASES so import and export by
 * RCDB id still work.
 *
 * v1 SHIPS ONE ISSUER. The eventual shape is per-issuer signed definitions on
 * each issuer's own feed, resolved at the view layer by a stated policy — a
 * single platform-owned feed would make WoCo permanently the authority on what
 * things are called, which is the opposite of handover. Until an issuer
 * registry exists the honest statement is "WoCo is the naming and authorisation
 * authority", not "parks can take over". {@link SubjectCatalogue} is the seam:
 * a Swarm-published source produces the same map and replaces the bundle.
 */

import type { Hex0x } from "../types.js";
import { creditSubject } from "./types.js";

export interface SubjectDefinition {
  /** The opaque WoCo-minted id this subject hashes from. Retained so an entry
   *  can be checked against its own hash rather than trusted — see
   *  {@link buildSubjectCatalogue}. PERMANENT: changing it is a new subject. */
  id: string;
  /** "Rita" — the coaster, in the community's own name for it. */
  name: string;
  /** "Alton Towers". */
  park: string;
  /** IANA zone. Declares what the statement's UTC `session.date` means when
   *  displayed for this subject; the signed field stays UTC precisely so it
   *  never depends on this mutable table. */
  timezone: string;
  /**
   * Minimum gap between counted rides, for THIS subject. Never a global
   * constant: a global five minutes would rate-limit the pilot it exists to
   * serve, since 109 laps x 5 min is over nine hours of pure cycle time
   * against a park day of about that length.
   *
   * Honest about what it is — an accidental-double-tap guard. At tier 1 it
   * polices self-declared data, so it stops a fumbled tap and nothing else.
   * Only tiers 2/3, where timing is attested, make it enforceable.
   */
  cadenceMinutes: number;
  /** Mutable interop, never hash input. */
  aliases?: {
    rcdb?: string;
    captainCoaster?: string;
    park?: string;
  };
}

/** subject hash -> what it means. Whatever produces it, bundle or feed. */
export type SubjectCatalogue = Readonly<Record<Hex0x, SubjectDefinition>>;

/**
 * Index definitions by their subject hash, recomputing each hash from the
 * definition's own `id` rather than accepting a supplied one.
 *
 * Recomputing is the point: an entry keyed by a hash that does not derive from
 * its `id` would render one coaster's name against another's count, and every
 * signature involved would still verify. Duplicate ids throw for the same
 * reason — two entries claiming one subject is not a mergeable state.
 */
export function buildSubjectCatalogue(definitions: readonly SubjectDefinition[]): SubjectCatalogue {
  const out: Record<string, SubjectDefinition> = {};
  for (const def of definitions) {
    if (!def.id) throw new Error(`subject definition for "${def.name}" has no id`);
    if (!Number.isFinite(def.cadenceMinutes) || def.cadenceMinutes < 0) {
      throw new Error(`subject "${def.name}" has an invalid cadenceMinutes: ${def.cadenceMinutes}`);
    }
    const subject = creditSubject(def.id);
    if (out[subject]) {
      throw new Error(`duplicate subject id ${def.id}: "${out[subject]!.name}" and "${def.name}"`);
    }
    out[subject] = def;
  }
  return Object.freeze(out);
}

/** What this subject is, or null if nothing in the catalogue defines it. */
export function lookupSubject(catalogue: SubjectCatalogue, subject: Hex0x): SubjectDefinition | null {
  return catalogue[subject] ?? null;
}

/**
 * Display name for a subject. Falls back to a short form of the HASH, never to
 * an empty string or a fabricated name — an unknown subject is a real state
 * (a definition from an issuer we have not loaded), and showing it as blank
 * would read as a bug while showing a guess would be a lie.
 */
export function subjectDisplayName(catalogue: SubjectCatalogue, subject: Hex0x): string {
  const def = lookupSubject(catalogue, subject);
  return def ? def.name : `Unknown coaster (${subject.slice(0, 10)}…)`;
}

// ---------------------------------------------------------------------------
// The v1 bundle — WoCo as sole issuer
// ---------------------------------------------------------------------------

/**
 * PERMANENT ids. Each one is hashed into a subject that riders sign statements
 * against, so an id here may be corrected only while nothing has been written
 * for it — after that it is a different coaster with a different history.
 * Everything else in the entry is freely editable.
 */
export const WOCO_SUBJECT_DEFINITIONS: readonly SubjectDefinition[] = [
  {
    // Minted 2026-08-14 for the Rita 100 pilot.
    // subject = 0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b
    id: "mstisnru-cjt0ipv",
    name: "Rita",
    park: "Alton Towers",
    timezone: "Europe/London",
    // PROVISIONAL. The plan requires this be set from the actual planned
    // cadence rather than a default, and that number comes from the rider —
    // a launch coaster's cycle plus re-ride arrangement, not a guess here.
    cadenceMinutes: 2,
  },
];

/** The catalogue the app ships with. Replaced, not extended, once definitions
 *  are published per-issuer on Swarm. */
export const WOCO_SUBJECTS: SubjectCatalogue = buildSubjectCatalogue(WOCO_SUBJECT_DEFINITIONS);

/** The Rita 100 pilot subject, by name, so call sites do not paste a hash. */
export const RITA_SUBJECT: Hex0x = creditSubject(WOCO_SUBJECT_DEFINITIONS[0]!.id);
