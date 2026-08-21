/**
 * Turning what an organiser typed, pasted or imported into a holder list.
 *
 * Pure, and separated from the surface for the reason this whole rail keeps
 * relearning: a list that quietly loses an entry looks exactly like a list that
 * never had it. Every rejection here is REPORTED with the line it came from,
 * never dropped, because the alternative is an organiser who believes they
 * awarded a badge to someone who never received one — and the run is permanent.
 */

import type { Hex32 } from "@woco/shared";

const ED25519_PUB_RE = /^[0-9a-f]{64}$/;

export interface HolderReject {
  /** 1-indexed line as the organiser sees it in the box. */
  line: number;
  /** What was on that line, trimmed and truncated for display. */
  text: string;
  reason: "not-a-key" | "duplicate";
}

export interface ParsedHolders {
  /** Valid, lowercased, de-duplicated, in first-seen order. */
  keys: Hex32[];
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
  const keys: Hex32[] = [];
  const rejects: HolderReject[] = [];
  const seen = new Set<string>();

  const lines = (text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue; // a blank line is not a mistake worth naming

    const bare = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
    const display = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;

    if (!ED25519_PUB_RE.test(bare)) {
      rejects.push({ line: i + 1, text: display, reason: "not-a-key" });
      continue;
    }
    if (seen.has(bare)) {
      rejects.push({ line: i + 1, text: display, reason: "duplicate" });
      continue;
    }
    seen.add(bare);
    keys.push(bare as Hex32);
  }

  return { keys, rejects };
}

/** Human copy for a rejected line. */
export function holderRejectLabel(reason: HolderReject["reason"]): string {
  return reason === "duplicate" ? "already on this list" : "not a badge key";
}

/** One attendee as the picker shows them. */
export interface AttendeeCandidate {
  seriesId: string;
  edition: number;
  podPubKey?: string;
  route: "email-link" | "claim";
}

export interface AttendeeSplit {
  /** Distinct holders, first-seen order — the unit of issuance is the PERSON. */
  certifiable: Hex32[];
  /**
   * Attendees with no badge key on file. Counted and shown, never dropped.
   * There is no path today that turns one of these into a certifiable
   * attendee — the gate binding's nullifier is already spent and nothing
   * backfills a key onto an existing binding — so a surface must not imply one.
   */
  withoutKey: AttendeeCandidate[];
  /**
   * Editions collapsed into an existing holder — a multi-ticket buyer. Reported
   * so "N of M" arithmetic is explicable rather than mysterious.
   */
  duplicateEditions: number;
}

/**
 * Split attendee rows into who can be certified and who cannot.
 *
 * THE UNIT IS THE PERSON, not the edition. A buyer who bought three tickets is
 * one holder and gets one certificate — `planCertIssuance` would dedupe them
 * regardless, so collapsing here is what makes the number the organiser
 * confirms mean the same thing as the number that lands.
 *
 * A malformed key is treated as ABSENT rather than passed through. The server
 * already filters these at serve time; doing it again costs one regex and means
 * this function is correct on its own terms rather than on a promise.
 */
export function splitAttendees(rows: readonly AttendeeCandidate[]): AttendeeSplit {
  const certifiable: Hex32[] = [];
  const withoutKey: AttendeeCandidate[] = [];
  const seen = new Set<string>();
  let duplicateEditions = 0;

  for (const row of rows ?? []) {
    const key = typeof row.podPubKey === "string" ? row.podPubKey.toLowerCase() : "";
    if (!ED25519_PUB_RE.test(key)) {
      withoutKey.push(row);
      continue;
    }
    if (seen.has(key)) {
      duplicateEditions++;
      continue;
    }
    seen.add(key);
    certifiable.push(key as Hex32);
  }

  return { certifiable, withoutKey, duplicateEditions };
}
