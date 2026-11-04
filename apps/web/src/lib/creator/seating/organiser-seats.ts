/**
 * The organiser's seat map (dashboard Seats tab, docs/SEATING.md S6): what each seat is
 * now, what a selection can do, and the seat-state change each action saves. Pure, so
 * every rule is tested without a page; `SeatsPanel.svelte` draws it.
 *
 * Rules from the S6 consult (Fable, 2026-11-04): a sold seat is selected on its own
 * (it is one ticket, and only "Change seat" applies to it) and is never pulled into a
 * hold or a release; a seat in someone's basket cannot be selected; a hold on a sold
 * seat stays (a house seat returns to the house when its ticket moves on).
 */

import type { SeatHoldKind } from "@woco/shared/seating/state";
import type { SeatMark } from "@woco/seatmap/draw";
import type { SeatStateDelta } from "./seat-state.js";

/** What organisers read for each kind of hold. */
export const HOLD_KIND_NAMES: Record<SeatHoldKind, string> = {
  house: "House seats",
  guest: "Guests",
  press: "Press",
  access: "Access",
  unavailable: "Not usable",
  other: "Other",
};

/** One seat of each kind, in a sentence: "This is a house seat". */
export const HOLD_KIND_SEAT: Record<SeatHoldKind, string> = {
  house: "a house seat",
  guest: "a guest seat",
  press: "a press seat",
  access: "an access seat",
  unavailable: "a seat marked not usable",
  other: "a held seat",
};

export type OrgSeat =
  | { status: "free" }
  | { status: "held"; kind: SeatHoldKind }
  /** A ticket sits in it. `slot` when known (edition = slot + 1); `held` when it is also a held seat. */
  | { status: "sold"; slot: number | null; held: SeatHoldKind | null }
  /** In a buyer's basket, or paid for and on its way. */
  | { status: "basket" }
  /** Emptied by a change, not back on sale yet (`nonce`: what putting it back confirms). */
  | { status: "offsale"; nonce: number }
  /** The ledger has not answered yet. */
  | { status: "unknown" };

export interface OrgInputs {
  /** The seat's taken bit; null while unread. */
  taken(k: number): boolean | null;
  holds: ReadonlyMap<number, SeatHoldKind>;
  /** Seats in a basket (the live holds list). */
  onHold: ReadonlySet<number>;
  /** Seats a change emptied, with the nonce they need confirmed at; confirmed ones left out. */
  emptied: ReadonlyMap<number, number>;
  /** Seat -> the slot sitting in it. */
  slotOf: ReadonlyMap<number, number>;
}

export function orgSeat(k: number, x: OrgInputs): OrgSeat {
  const taken = x.taken(k);
  if (taken === null) return { status: "unknown" };
  if (taken) return { status: "sold", slot: x.slotOf.get(k) ?? null, held: x.holds.get(k) ?? null };
  if (x.onHold.has(k)) return { status: "basket" };
  const kind = x.holds.get(k);
  if (kind) return { status: "held", kind };
  const n = x.emptied.get(k);
  if (n !== undefined) return { status: "offsale", nonce: n };
  return { status: "free" };
}

export interface OrgSummary {
  sold: number;
  held: Map<SeatHoldKind, number>;
  heldTotal: number;
  basket: number;
  offsale: number;
  free: number;
  unknown: number;
}

export function orgSummary(seats: number, x: OrgInputs): OrgSummary {
  const s: OrgSummary = { sold: 0, held: new Map(), heldTotal: 0, basket: 0, offsale: 0, free: 0, unknown: 0 };
  for (let k = 0; k < seats; k++) {
    const st = orgSeat(k, x);
    if (st.status === "held") {
      s.held.set(st.kind, (s.held.get(st.kind) ?? 0) + 1);
      s.heldTotal++;
    } else s[st.status]++;
  }
  return s;
}

/** What the map is showing: everything, or one group with the rest dimmed. */
export type OrgFilter = null | "sold" | "held" | "basket" | "offsale" | "free" | { held: SeatHoldKind };

function inFilter(st: OrgSeat, f: OrgFilter): boolean {
  if (f === null) return true;
  if (typeof f === "object") return st.status === "held" && st.kind === f.held;
  return st.status === f;
}

/** How the map draws a seat: null = the band's own fill (free), else its mark. */
export function orgMark(st: OrgSeat, filter: OrgFilter): SeatMark | null {
  if (!inFilter(st, filter)) return "dim";
  switch (st.status) {
    case "free": return null;
    case "held": return "held";
    case "sold": return "sold";
    case "basket": return "basket";
    case "offsale": return "offsale";
    case "unknown": return "dim";
  }
}

/** Whether a tap on the seat selects it. */
export function orgSelectable(st: OrgSeat): boolean {
  return st.status === "free" || st.status === "held" || st.status === "offsale" || (st.status === "sold" && st.slot !== null);
}

/**
 * A tap on seat `k` with `picks` selected. A sold seat is a selection of its own; any
 * other seat leaves a sold one's selection; anything else toggles.
 */
export function orgToggle(picks: readonly number[], k: number, x: OrgInputs): number[] {
  const st = orgSeat(k, x);
  if (!orgSelectable(st)) return [...picks];
  if (picks.includes(k)) return picks.filter((p) => p !== k);
  if (st.status === "sold") return [k];
  const kept = picks.filter((p) => orgSeat(p, x).status !== "sold");
  return [...kept, k].sort((a, b) => a - b);
}

/** Add `seats` (a row, a section) to a selection of seats; sold and basket seats are skipped. */
export function orgAddAll(picks: readonly number[], seats: readonly number[], x: OrgInputs): number[] {
  const out = new Set(picks.filter((p) => orgSeat(p, x).status !== "sold"));
  for (const k of seats) {
    const st = orgSeat(k, x);
    if (orgSelectable(st) && st.status !== "sold") out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

export interface OrgActions {
  /** Seats a hold applies to (free, or held as another kind). */
  hold: number[];
  /** Held seats a release applies to. */
  release: number[];
  /** Emptied seats "Put back on sale" applies to. */
  putBack: number[];
  /** One sold seat: its ticket. */
  ticket: { seat: number; slot: number } | null;
}

export function orgActions(picks: readonly number[], x: OrgInputs): OrgActions {
  const a: OrgActions = { hold: [], release: [], putBack: [], ticket: null };
  for (const k of picks) {
    const st = orgSeat(k, x);
    if (st.status === "sold" && st.slot !== null && picks.length === 1) a.ticket = { seat: k, slot: st.slot };
    if (st.status === "free" || st.status === "held" || st.status === "offsale") a.hold.push(k);
    if (st.status === "held") a.release.push(k);
    if (st.status === "offsale") a.putBack.push(k);
  }
  return a;
}

/** The save for "Hold as {kind}". */
export function holdDelta(seats: readonly number[], kind: SeatHoldKind): SeatStateDelta {
  return { hold: new Map(seats.map((k) => [k, kind])) };
}

export function releaseDelta(seats: readonly number[]): SeatStateDelta {
  return { release: [...seats] };
}

/** The save for "Put back on sale": each seat confirmed at the nonce it was emptied at. */
export function putBackDelta(seats: readonly number[], x: Pick<OrgInputs, "emptied">): SeatStateDelta {
  const confirm = new Map<number, number>();
  for (const k of seats) {
    const n = x.emptied.get(k);
    if (n !== undefined) confirm.set(k, n);
  }
  return { confirm };
}

/** Two deltas as one save, the later winning per seat (a hold then a release of one seat = released). */
export function mergeDeltas(a: SeatStateDelta, b: SeatStateDelta): SeatStateDelta {
  const hold = new Map(a.hold ?? []);
  const release = new Set(a.release ?? []);
  for (const k of b.release ?? []) {
    hold.delete(k);
    release.add(k);
  }
  for (const [k, kind] of b.hold ?? []) {
    release.delete(k);
    hold.set(k, kind);
  }
  const confirm = new Map([...(a.confirm ?? []), ...(b.confirm ?? [])]);
  return {
    ...(hold.size ? { hold } : {}),
    ...(release.size ? { release: [...release].sort((x, y) => x - y) } : {}),
    ...(confirm.size ? { confirm } : {}),
  };
}

/** Apply a not-yet-saved delta to what the map shows, so a tap shows at once. */
export function withDelta(holds: ReadonlyMap<number, SeatHoldKind>, emptied: ReadonlyMap<number, number>, d: SeatStateDelta) {
  const h = new Map(holds);
  for (const k of d.release ?? []) h.delete(k);
  for (const [k, kind] of d.hold ?? []) h.set(k, kind);
  const e = new Map(emptied);
  for (const k of d.confirm?.keys() ?? []) e.delete(k);
  return { holds: h, emptied: e };
}
