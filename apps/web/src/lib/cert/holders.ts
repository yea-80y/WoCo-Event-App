/**
 * Turning what an organiser typed, pasted or imported into a holder list.
 *
 * Pure, and separated from the surface for the reason this whole rail keeps
 * relearning: a list that quietly loses an entry looks exactly like a list that
 * never had it. Every rejection here is REPORTED with the line it came from,
 * never dropped, because the alternative is an organiser who believes they
 * awarded a badge to someone who never received one — and the run is permanent.
 */

import { isHolderPubkey } from "@woco/shared";
import type { HolderPubkey } from "@woco/shared";

export interface HolderReject {
  /** 1-indexed line as the organiser sees it in the box. */
  line: number;
  /** What was on that line, trimmed and truncated for display. */
  text: string;
  reason: "not-a-key" | "duplicate";
}

export interface ParsedHolders {
  /** Valid, lowercased, de-duplicated, in first-seen order. */
  keys: HolderPubkey[];
  /** Everything that did not make it, and why. Never silently discarded. */
  rejects: HolderReject[];
}

/**
 * Parse a pasted block of holder keys — one per line.
 *
 * Tolerant of the shapes a real paste arrives in: blank lines, surrounding
 * whitespace, an `0x` prefix (the schema says bare, but every other hex value
 * in this product carries one, so accepting it is kindness rather than
 * looseness), and mixed case.
 *
 * DUPLICATES ARE REPORTED, not merely collapsed. `planCertIssuance` would
 * dedupe them anyway, so this changes no bytes — but an organiser who pasted
 * the same person twice has a list that does not mean what they think it means,
 * and the count they are about to confirm would silently disagree with the
 * count they typed.
 */
export function parseHolderKeys(text: string): ParsedHolders {
  const keys: HolderPubkey[] = [];
  const rejects: HolderReject[] = [];
  const seen = new Set<string>();

  const lines = (text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue; // a blank line is not a mistake worth naming

    const bare = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
    const display = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;

    if (!isHolderPubkey(bare)) {
      rejects.push({ line: i + 1, text: display, reason: "not-a-key" });
      continue;
    }
    if (seen.has(bare)) {
      rejects.push({ line: i + 1, text: display, reason: "duplicate" });
      continue;
    }
    seen.add(bare);
    keys.push(bare);
  }

  return { keys, rejects };
}

/** Human copy for a rejected line. */
export function holderRejectLabel(reason: HolderReject["reason"]): string {
  return reason === "duplicate" ? "already on this list" : "not a badge key";
}

/** A binding row from `/attendee-keys` — an edition the platform has a record for. */
export interface AttendeeCandidate {
  seriesId: string;
  edition: number;
  podPubKey?: string;
  route: "email-link" | "claim";
}

/** One sold ticket, from `/orders` — the TRUE denominator. */
export interface TicketClaim {
  seriesId: string;
  edition: number;
}

/** Why an attendee cannot be awarded a badge right now. */
export type UncertifiableReason =
  /** Bound to an account, but that account has no badge identity on file. */
  | "no-key"
  /** Never linked to an account at all — no binding exists for this ticket. */
  | "not-linked";

export interface UncertifiableAttendee {
  seriesId: string;
  edition: number;
  reason: UncertifiableReason;
}

export interface AttendeeSplit {
  /** Distinct holders, first-seen order — the unit of issuance is the PERSON. */
  certifiable: HolderPubkey[];
  /** Everyone who cannot be awarded, and why. Counted and shown, never dropped. */
  withoutKey: UncertifiableAttendee[];
  /** Editions collapsed into a holder already counted — a multi-ticket buyer. */
  duplicateEditions: number;
  /** Every ticket claim considered. `certifiable + withoutKey + duplicates`. */
  totalClaims: number;
}

/**
 * Split an event's ticket claims into who can be awarded a badge and who cannot.
 *
 * THE DENOMINATOR IS `claims`, NOT BINDINGS, and that is the whole point of this
 * signature. Bindings exist only for attendees who checked out signed in (first
 * edition of a group buy only) or redeemed the email-CTA link — most attendees
 * have none. Counting bindings would let the surface say "6 of 10 attendees"
 * about an event with 100 tickets sold, at the moment an organiser confirms a
 * PERMANENT run, and they would reasonably believe everyone had been covered.
 *
 * So every claim is accounted for, and an attendee with no binding at all is a
 * FIRST-CLASS un-certifiable row (`not-linked`) rather than an absence. That is
 * a different situation from a bound account with no badge identity (`no-key`),
 * and the two get different copy because they have different causes.
 *
 * THE UNIT IS THE PERSON, not the edition. A buyer with three tickets is one
 * holder and one certificate — `planCertIssuance` would dedupe them anyway, so
 * collapsing here is what makes the number the organiser confirms mean the same
 * thing as the number that lands.
 */
export function splitAttendees(args: {
  claims: readonly TicketClaim[];
  bindings: readonly AttendeeCandidate[];
}): AttendeeSplit {
  const byEdition = new Map<string, AttendeeCandidate>();
  for (const b of args.bindings ?? []) byEdition.set(`${b.seriesId}\u0000${b.edition}`, b);

  const certifiable: HolderPubkey[] = [];
  const withoutKey: UncertifiableAttendee[] = [];
  const seen = new Set<string>();
  let duplicateEditions = 0;

  const claims = args.claims ?? [];
  for (const claim of claims) {
    const binding = byEdition.get(`${claim.seriesId}\u0000${claim.edition}`);
    const key = typeof binding?.podPubKey === "string" ? binding.podPubKey.toLowerCase() : "";

    if (!binding) {
      withoutKey.push({ seriesId: claim.seriesId, edition: claim.edition, reason: "not-linked" });
      continue;
    }
    // A malformed key counts as absent. The server already filters these at
    // serve time; repeating it costs one regex and makes this function correct
    // on its own terms rather than on a promise.
    if (!isHolderPubkey(key)) {
      withoutKey.push({ seriesId: claim.seriesId, edition: claim.edition, reason: "no-key" });
      continue;
    }
    if (seen.has(key)) {
      duplicateEditions++;
      continue;
    }
    seen.add(key);
    certifiable.push(key);
  }

  return { certifiable, withoutKey, duplicateEditions, totalClaims: claims.length };
}

/** Human copy for an un-certifiable attendee. */
export function uncertifiableLabel(reason: UncertifiableReason): string {
  return reason === "not-linked"
    ? "ticket not linked to an account"
    : "account has no badge identity";
}
