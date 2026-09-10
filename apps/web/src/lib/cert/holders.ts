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

/** A binding row from `/attendee-keys` — an edition the platform has a record for.
 *  It carries NO holder key: the ed25519 one is gone (#518) and the cert rail's
 *  secp256k1 replacement does not exist yet. */
export interface AttendeeCandidate {
  seriesId: string;
  edition: number;
  route: "email-link" | "claim";
}

/** One sold ticket, from `/orders` — the TRUE denominator. */
export interface TicketClaim {
  seriesId: string;
  edition: number;
}

/** Why an attendee cannot be awarded a badge right now.
 *
 *  Until the certificate rail migrates to secp256k1 (#518), EVERY attendee is
 *  one of these two: the platform holds no holder identity for anybody, so a
 *  bound ticket is `no-key` and an unbound one is `not-linked`. Both are kept,
 *  and they still get different copy, because they have different causes and
 *  different fixes for the organiser. */
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
  /** Distinct holders, first-seen order — the unit of issuance is the PERSON.
   *  ALWAYS EMPTY while no holder identity exists (#518); kept in the shape
   *  because the surface's arithmetic and copy are written against it, and the
   *  cert rail's secp256k1 migration fills it back in. */
  certifiable: HolderPubkey[];
  /** Everyone who cannot be awarded, and why. Counted and shown, never dropped. */
  withoutKey: UncertifiableAttendee[];
  /** Editions collapsed into a holder already counted — a multi-ticket buyer.
   *  Always 0 for the same reason `certifiable` is always empty. */
  duplicateEditions: number;
  /** Every ticket claim considered. `certifiable + withoutKey + duplicates`. */
  totalClaims: number;
}

/**
 * Split an event's ticket claims into who can be awarded a badge and who cannot.
 *
 * NOBODY IS CERTIFIABLE FROM PLATFORM DATA RIGHT NOW (#518). The rows this joins
 * against carry no holder identity — the ed25519 key they used to carry was
 * client-declared and unverified (#345) and is gone — so `certifiable` comes back
 * empty and every claim lands in `withoutKey`. The organiser's PASTE path is
 * unaffected; it supplies keys directly.
 *
 * That is a deliberate honest-empty, not a silent one: the shape is unchanged, so
 * the surface still counts and shows every attendee it cannot award and says why,
 * instead of quietly issuing fewer certificates than the organiser confirmed. The
 * cert rail's secp256k1 migration restores the join.
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
 */
export function splitAttendees(args: {
  claims: readonly TicketClaim[];
  bindings: readonly AttendeeCandidate[];
}): AttendeeSplit {
  const bound = new Set<string>();
  for (const b of args.bindings ?? []) bound.add(`${b.seriesId}\u0000${b.edition}`);

  const withoutKey: UncertifiableAttendee[] = [];

  const claims = args.claims ?? [];
  for (const claim of claims) {
    withoutKey.push({
      seriesId: claim.seriesId,
      edition: claim.edition,
      reason: bound.has(`${claim.seriesId}\u0000${claim.edition}`) ? "no-key" : "not-linked",
    });
  }

  return { certifiable: [], withoutKey, duplicateEditions: 0, totalClaims: claims.length };
}

/** Human copy for an un-certifiable attendee. */
export function uncertifiableLabel(reason: UncertifiableReason): string {
  return reason === "not-linked"
    ? "ticket not linked to an account"
    : "account has no badge identity";
}
