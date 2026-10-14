/**
 * Keeping the scanner's pack current, so a ticket sold after the scanner was set
 * up scans green with nothing for the organiser to do. Kept apart from the store
 * (runes + IndexedDB) so each rule is testable in node:
 * `apps/web/test/scanner-pack-refresh.test.ts`.
 *
 * The pack holds the chain's slot owners as of when it was made. Without a
 * refresh, a buyer who paid after that was turned away as "No ticket issued".
 */
import type { TicketQr } from "@woco/shared";
import type { VerifyVerdict } from "./verify.js";
import { IN_FLIGHT_MESSAGE } from "./admission.js";

/** Background refresh while the scanner is open and online. */
export const PACK_REFRESH_MS = 60_000;
/** Coming back to the scanner (screen on, tab focused) refreshes once this much has passed. */
export const RETURN_REFRESH_MS = 15_000;
/**
 * A ticket still missing from a pack fetched this recently is not fetched for
 * again. Short, because the usual reason is a sale seconds old whose mint the
 * chain read has not caught up with: the guest scans again moments later.
 */
export const MISS_RECHECK_MS = 5_000;

export const MISS_OFFLINE_MESSAGE =
  "This ticket may have been bought after this scanner last updated - scan again when connected";
export const MISS_FAILED_MESSAGE = "Couldn't check for newly sold tickets - scan again";
export const NOT_FOUND_YET_MESSAGE = "Not found yet - if they've just bought, scan again in a few seconds";

/** The ticket a newer pack might know about, or null when no pack could change this verdict. */
export function ticketNewerThanPack(v: VerifyVerdict): TicketQr | null {
  return v.status === "invalid" && v.code !== undefined && v.ticket ? v.ticket : null;
}

export type MissStep =
  | { kind: "refresh" }
  /** The pack was fetched for this very ticket moments ago: it is as fresh as it gets. */
  | { kind: "settled" }
  /** Not admitted and not refused: the scanner could not look. */
  | { kind: "cant-confirm"; message: string };

export interface MissInput {
  online: boolean;
  passDead: string | null;
  claimInFlight: boolean;
  /** When a pack was last fetched because of THIS ticket. */
  lastRecheckAt: number | undefined;
  now: number;
}

/**
 * A ticket the pack does not know: fetch a newer pack, unless one was fetched
 * for it moments ago. Without a fetch it is "couldn't confirm", because red at
 * the door for a ticket that is merely newer than the pack turns a paying guest
 * away.
 */
export function onPackMiss(i: MissInput): MissStep {
  if (i.lastRecheckAt !== undefined && i.now - i.lastRecheckAt < MISS_RECHECK_MS) return { kind: "settled" };
  if (i.passDead) return { kind: "cant-confirm", message: i.passDead };
  if (!i.online) return { kind: "cant-confirm", message: MISS_OFFLINE_MESSAGE };
  if (i.claimInFlight) return { kind: "cant-confirm", message: IN_FLIGHT_MESSAGE };
  return { kind: "refresh" };
}

export interface AutoRefreshInput {
  ready: boolean;
  online: boolean;
  passDead: boolean;
  claimInFlight: boolean;
  /** A scan or another refresh is running. */
  busy: boolean;
  visible: boolean;
  sinceLastMs: number;
  minGapMs: number;
}

export function shouldAutoRefresh(i: AutoRefreshInput): boolean {
  return i.ready && i.online && !i.passDead && !i.claimInFlight && !i.busy && i.visible && i.sinceLastMs >= i.minGapMs;
}

/**
 * What a fresh pack's "no ticket for this slot" means at the door. Straight after
 * a sale the chain read can lag the mint, so a genuine ticket looks exactly like
 * this for a few seconds: grey, not admitted, scan again - never red. A ticket
 * type or edition the event does not have still reads red, as does a signature
 * that does not match (which never reaches here).
 */
export function notFoundYet(v: VerifyVerdict): string | null {
  return v.status === "invalid" && v.code === "no-owner" ? NOT_FOUND_YET_MESSAGE : null;
}
