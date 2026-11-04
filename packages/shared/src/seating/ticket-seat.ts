/**
 * A ticket's seat as a buyer or a steward reads it (docs/SEATING.md "Door + tickets"):
 * PARTS, never a pre-rendered sentence, so the card, the ticket page, the scanner and
 * the passport each lay it out as labelled fields (Section / Row / Seat, or Table /
 * Seat), the way wallet passes do. One sentence form exists for email text and screen
 * readers (`ticketSeatText`).
 *
 * No import of the plan here: the static ticket page and the scanner use this module
 * and must not pull the plan format in. `ticketSeatOf` (plan.ts) makes one from a plan.
 */

import { hasExactKeys, isDisplayText, isIntIn, isPlainRecord } from "../validate.js";

export interface TicketSeat {
  /** The block's name ("Stalls"), or the table's ("Table 3") when `table`. */
  area: string;
  /** Row label; blocks of rows only. */
  row?: string;
  /** Seat number as printed. */
  seat: number;
  table?: true;
  /** A wheelchair space. */
  wheelchair?: true;
  /** A companion seat for a wheelchair space. */
  companion?: true;
}

/** Caps match the layout's own (`layout.ts`: names 80, row labels 12). */
const AREA_MAX = 80;
const ROW_MAX = 12;
const SEAT_MAX = 999_999;

/** A seat from anywhere not this code: a link someone may have edited, a pack. */
export function isTicketSeat(v: unknown): v is TicketSeat {
  if (!isPlainRecord(v) || !hasExactKeys(v, ["area", "seat"], ["row", "table", "wheelchair", "companion"])) return false;
  if (!isDisplayText(v.area, AREA_MAX) || !isIntIn(v.seat, 1, SEAT_MAX)) return false;
  if ("row" in v && !isDisplayText(v.row, ROW_MAX)) return false;
  return (["table", "wheelchair", "companion"] as const).every((k) => !(k in v) || v[k] === true);
}

/** "Stalls, Row D, seat 7" / "Table 3, seat 5". */
export function ticketSeatText(s: Pick<TicketSeat, "area" | "row" | "seat">): string {
  return s.row !== undefined ? `${s.area}, Row ${s.row}, seat ${s.seat}` : `${s.area}, seat ${s.seat}`;
}

/** Where in the room, without the seat number: "Stalls, Row D" / "Table 3". */
export function ticketSeatPlace(s: Pick<TicketSeat, "area" | "row">): string {
  return s.row !== undefined ? `${s.area}, Row ${s.row}` : s.area;
}

export interface TicketSeatField {
  label: "Section" | "Table" | "Row" | "Seat";
  value: string;
}

/**
 * The labelled fields, in reading order. A table named "Table 3" shows as Table 3,
 * not "Table Table 3"; any other table name is shown whole.
 */
export function ticketSeatFields(s: TicketSeat): TicketSeatField[] {
  if (s.table) {
    const short = /^table\s+(\S.*)$/i.exec(s.area)?.[1];
    return [{ label: "Table", value: short ?? s.area }, { label: "Seat", value: String(s.seat) }];
  }
  return [
    { label: "Section", value: s.area },
    ...(s.row !== undefined ? [{ label: "Row" as const, value: s.row }] : []),
    { label: "Seat", value: String(s.seat) },
  ];
}

/** The ticket-type line incumbents print for these seats; null for an ordinary one. */
export function ticketSeatNote(s: TicketSeat): string | null {
  if (s.wheelchair) return "Wheelchair space";
  if (s.companion) return "Companion seat";
  return null;
}
