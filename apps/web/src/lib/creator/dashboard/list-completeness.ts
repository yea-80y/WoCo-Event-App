/**
 * Whether the organiser's attendee list is complete enough to act on as a whole
 * (#965): a CSV export, an email to every attendee, the door list.
 *
 * Details now arrive in the background (detail-queue.ts), so at any moment some
 * rows may have none yet. Acting on that partial set without saying so would send
 * a cancellation notice to most of the room, or hand the door a list missing
 * names. So each whole-list action asks `listGate` first:
 *   - "loading": details are still arriving - wait (with progress);
 *   - "gaps": nothing more is coming on its own - go ahead only after a confirm
 *     that names how many are missing and why;
 *   - "ready": every row that should have details has them.
 *
 * A row that keeps being refused (`retrying`) counts as a gap, not as loading, so
 * one stuck order can never block an export for good. Erased rows are left out of
 * every list on purpose and never count as missing.
 */
import type { OrderEntry } from "@woco/shared";
import type { DetailState } from "./detail-queue.js";

export type RowDetail = "details" | "erased" | "loading" | "locked" | "not-found" | "unavailable" | "unreadable" | "unopened";

/** Where one row's attendee details stand. */
export function rowDetail(
  order: Pick<OrderEntry, "erased" | "encryptedOrder">,
  opened: boolean,
  queueState: DetailState | undefined,
  opening: boolean,
  locked = false,
): RowDetail {
  if (order.erased) return "erased";
  if (opened) return "details";
  // The box is here: being opened, waiting for the keys, or it would not open.
  if (order.encryptedOrder) return opening ? "loading" : locked ? "locked" : "unopened";
  switch (queueState) {
    case "queued":
    case "fetching":
    case "ready": // fetched, not merged into the rows yet
      return "loading";
    case "retrying":
      return "unavailable";
    case "unreadable":
      return "unreadable";
    default:
      // A 404, or no order stored for this ticket at all.
      return "not-found";
  }
}

export type ListGate =
  | { kind: "ready"; total: number }
  | { kind: "loading"; done: number; total: number }
  | { kind: "gaps"; missing: number; total: number; why: string };

const WHY: Array<[Exclude<RowDetail, "details" | "erased" | "loading">, string]> = [
  ["locked", "locked - unlock to include them"],
  ["not-found", "not found"],
  ["unavailable", "unavailable right now"],
  ["unreadable", "unreadable"],
  ["unopened", "could not be opened"],
];

export function listGate(rows: readonly RowDetail[]): ListGate {
  const count = new Map<RowDetail, number>();
  for (const r of rows) count.set(r, (count.get(r) ?? 0) + 1);
  const total = rows.length - (count.get("erased") ?? 0);
  const done = count.get("details") ?? 0;
  if ((count.get("loading") ?? 0) > 0) return { kind: "loading", done, total };
  const missing = total - done;
  if (missing === 0) return { kind: "ready", total };
  const why = WHY.filter(([k]) => count.get(k)).map(([k, label]) => `${count.get(k)} ${label}`).join(", ");
  return { kind: "gaps", missing, total, why };
}

/** "12 of 1,340" - the shortfall, for a confirm. */
export function shortfall(g: { missing: number; total: number }): string {
  return `${g.missing.toLocaleString("en-GB")} of ${g.total.toLocaleString("en-GB")}`;
}

/** The CSV's Details column: empty when the row has its details. */
export const DETAIL_CSV: Record<RowDetail, string> = {
  details: "",
  erased: "Erased on request",
  loading: "Still loading",
  locked: "Locked",
  "not-found": "Not found",
  unavailable: "Unavailable",
  unreadable: "Unreadable",
  unopened: "Could not be opened",
};
