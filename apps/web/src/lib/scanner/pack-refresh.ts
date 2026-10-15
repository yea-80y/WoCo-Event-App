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
export const NOT_FOUND_YET_MESSAGE = "Not found yet - scan again in a few seconds";

/**
 * A buyer gets the QR only AFTER the mint succeeded (fulfilment emails it last),
 * so a genuine ticket is already on chain when it is shown; the only lag is a
 * chain-read replica a few seconds behind. A pack requested this long after the
 * first miss that still lacks the slot is the answer: red.
 */
export const NOT_FOUND_LAG_MS = 5_000;
/** And past this, red whatever was fetched: a never-sold edition cannot hold a queue up. */
export const NOT_FOUND_BOUND_MS = 20_000;

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

export type RecheckResult =
  | { kind: "refreshed" }
  | { kind: "settled" }
  /** The newer pack could not be fetched (and the pass is not dead). */
  | { kind: "failed" }
  | { kind: "cant-confirm"; message: string };

export interface MissContext {
  /** `ticketKey` of the scanned ticket. */
  key: string;
  /** ticketKey → when that ticket was first found missing on this scanner. Never pruned while the pass is held. */
  firstSeen: Map<string, number>;
  now: () => number;
  /** onPackMiss, then the fetch it allows. */
  recheck: () => Promise<RecheckResult>;
  reverify: () => Promise<VerifyVerdict>;
  /** When the pack now held was requested. */
  packAsOf: () => number;
}

export type MissOutcome = { kind: "verdict"; verdict: VerifyVerdict } | { kind: "cant-confirm"; message: string };

/**
 * A ticket the pack could not place. Never green on its own: a verdict comes back
 * only from verifying against a pack. A slot with no owner reads grey ONCE - the
 * first miss for that ticket - and red as soon as a pack requested at least
 * NOT_FOUND_LAG_MS after that still lacks it, or NOT_FOUND_BOUND_MS after it
 * whatever the fetches did. Offline, a dead pass and a claim in flight stay
 * "couldn't confirm". Ticket types and editions the event does not have are red
 * once the re-check is done, as are signatures that do not match.
 */
export async function resolveMiss(verdict: VerifyVerdict, c: MissContext): Promise<MissOutcome> {
  const step = await c.recheck();
  if (step.kind === "cant-confirm") return step;
  const v = step.kind === "refreshed" ? await c.reverify() : verdict;
  const noOwner = v.status === "invalid" && v.code === "no-owner";
  if (!noOwner) {
    // A newer pack could still place it, but none could be fetched: not a verdict.
    if (step.kind === "failed" && ticketNewerThanPack(v)) return { kind: "cant-confirm", message: MISS_FAILED_MESSAGE };
    return { kind: "verdict", verdict: v };
  }
  const now = c.now();
  const first = c.firstSeen.get(c.key);
  if (first === undefined) {
    c.firstSeen.set(c.key, now);
    return { kind: "cant-confirm", message: step.kind === "failed" ? MISS_FAILED_MESSAGE : NOT_FOUND_YET_MESSAGE };
  }
  if (c.packAsOf() >= first + NOT_FOUND_LAG_MS || now - first > NOT_FOUND_BOUND_MS) return { kind: "verdict", verdict: v };
  return { kind: "cant-confirm", message: step.kind === "failed" ? MISS_FAILED_MESSAGE : NOT_FOUND_YET_MESSAGE };
}
