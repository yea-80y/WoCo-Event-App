/**
 * Changing a ticket's seat (docs/SEATING.md S6): the organiser key signs `reseatBearer`
 * moves - every card ticket is a bearer ticket, so the organiser's signature alone is
 * the authority - and WoCo's relay submits them all or nothing.
 *
 * S6 consult (Fable, 2026-11-04), on top of the step-1 relay design:
 *   - only the FIRST move can be checked against the ledger's `reseatBearerDigest` view
 *     (later moves of a sequence commit to the nonces the earlier ones leave); the
 *     shared encoder's golden vectors and the relay's own recover cover the rest;
 *   - a revoke at the same terms nonce goes with EVERY request as its abort: a batch that
 *     reverts on chain publishes its signatures, and a dependent sequence (a swap) could
 *     otherwise be landed part way by anyone until the nonce moves;
 *   - an unconfirmed answer is settled from the chain (`seatOf` of the moved tickets)
 *     before anything is written or emailed.
 *
 * Moves stop at the sales cutoff (`_reseat`), and only while the ticket is not held by a
 * holder's own key (`reseat` needs their signature too; no such ticket exists before
 * resale).
 */

import { LEDGER2_NO_SEAT, type Ledger2RelayItem, type Ledger2RelayRequest, type Ledger2RelayResult } from "@woco/shared/ticket/ledger2-terms";
import { Ledger2ChangeError, isTransient, type Ledger2ClientIO, type Ledger2EventView } from "./organiser-changes.js";

/** What the organiser asked for: one ticket to a seat (or out of its seat), or two tickets swapped. */
export type SeatMoveRequest =
  | { kind: "move"; slot: number; to: number | "none" }
  | { kind: "swap"; a: number; b: number };

export interface PlannedMoves {
  seriesId: string;
  onChainEventId: string;
  moves: Array<{ slot: number; toSeat: bigint }>;
  /** Each moved ticket's seat before and after. */
  before: Map<number, bigint>;
  after: Map<number, bigint>;
  /** Seats the moves leave empty: what "put back on sale" would confirm. */
  emptied: bigint[];
}

/** The moves `req` is, from the seats the chain holds now. */
export function planMoves(req: SeatMoveRequest, seats: ReadonlyMap<number, bigint>): Array<{ slot: number; toSeat: bigint }> {
  if (req.kind === "move") return [{ slot: req.slot, toSeat: req.to === "none" ? LEDGER2_NO_SEAT : BigInt(req.to) }];
  const sa = seats.get(req.a);
  const sb = seats.get(req.b);
  if (sa === undefined || sb === undefined || sa === LEDGER2_NO_SEAT || sb === LEDGER2_NO_SEAT || req.a === req.b) {
    throw new Ledger2ChangeError("Both tickets need a seat to swap.", "seat_move_invalid");
  }
  // a out of its seat, b into a's, a into b's: one dependent sequence, all or nothing.
  return [{ slot: req.a, toSeat: LEDGER2_NO_SEAT }, { slot: req.b, toSeat: sa }, { slot: req.a, toSeat: sb }];
}

/**
 * Read, plan and sign. `view` must be fresh (its terms nonce is what the moves and the
 * abort commit to). Throws `Ledger2ChangeError` with the relay's codes.
 */
export async function signSeatMoves(
  view: Ledger2EventView,
  seriesId: string,
  req: SeatMoveRequest,
  io: Ledger2ClientIO,
): Promise<{ request: Ledger2RelayRequest; planned: PlannedMoves }> {
  const { planSeatMoveNonces, ledger2SignatureWindow, ledger2Digest, signLedger2Action } = await import("@woco/shared/ticket/ledger2-terms");
  const s = view.series.find((x) => x.seriesId === seriesId);
  if (!s || !s.seated) throw new Ledger2ChangeError("This ticket type has no seats.", "not_seated");
  if (s.cancelled) throw new Ledger2ChangeError("This event has been cancelled.", "event_cancelled");
  if (view.chainNow >= s.eventEndTs) throw new Ledger2ChangeError("Ticket sales have ended, so seats can't be changed.", "sales_closed");

  const involved = req.kind === "move" ? [req.slot] : [req.a, req.b];
  const slots = await io.slots(view.target.address, s.onChainEventId, involved);
  const seats = new Map([...slots].map(([k, v]) => [k, v.seat]));
  const moves = planMoves(req, seats);
  const targets = [...new Set(moves.map((m) => m.toSeat).filter((t) => t !== LEDGER2_NO_SEAT))];
  const nonces = targets.length ? await io.seatNonces(view.target.address, s.onChainEventId, targets) : new Map<bigint, bigint>();
  const plan = planSeatMoveNonces(s.termsNonce, slots, nonces, moves);
  if (!plan) throw new Ledger2ChangeError("That seat can't be chosen for this ticket.", "seat_move_invalid");

  const window = ledger2SignatureWindow(await io.chainNow());
  const actions = moves.map((m, i) => ({
    kind: "reseatBearer" as const,
    eventId: s.onChainEventId,
    slot: m.slot,
    toSeat: m.toSeat,
    ...plan[i]!,
    ...window,
  }));
  const abort = { kind: "revoke" as const, eventId: s.onChainEventId, nonce: s.termsNonce, ...window };
  const [first, revokeDigest] = await Promise.all([
    io.chainDigest(view.target.address, actions[0]!),
    io.chainDigest(view.target.address, abort),
  ]);
  if (
    ledger2Digest(view.target, actions[0]!).toLowerCase() !== first.toLowerCase() ||
    ledger2Digest(view.target, abort).toLowerCase() !== revokeDigest.toLowerCase()
  ) {
    throw new Ledger2ChangeError(
      "Refusing to sign: this app and your event's ticket record disagree on what a change looks like. Nothing was signed. Please report this.",
      "digest_mismatch",
    );
  }

  const key = await io.organiserKey();
  try {
    if (key.address.toLowerCase() !== s.organiserKey) {
      throw new Ledger2ChangeError("This device's key for your events isn't the current one. Sign in again, then retry.", "key_moved");
    }
    const items: Ledger2RelayItem[] = actions.map((a) => ({
      kind: "reseatBearer",
      seriesId,
      slot: a.slot,
      toSeat: a.toSeat === LEDGER2_NO_SEAT ? "none" : Number(a.toSeat),
      issuedAt: a.issuedAt,
      deadline: a.deadline,
      sig: signLedger2Action(view.target, a, key.privateKey),
    }));
    const request: Ledger2RelayRequest = {
      items,
      aborts: [{ seriesId, issuedAt: abort.issuedAt, deadline: abort.deadline, sig: signLedger2Action(view.target, abort, key.privateKey) }],
    };
    const after = new Map(seats);
    for (const m of moves) after.set(m.slot, m.toSeat);
    const filled = new Set(after.values());
    const emptied = [...new Set(seats.values())].filter((seat) => seat !== LEDGER2_NO_SEAT && !filled.has(seat));
    return { request, planned: { seriesId, onChainEventId: s.onChainEventId, moves, before: seats, after, emptied } };
  } finally {
    key.privateKey.fill(0);
  }
}

export type SeatMoveOutcome =
  | { phase: "moved" }
  /** Sent; the chain does not show it yet. Nothing is written or emailed. */
  | { phase: "unconfirmed" }
  | { phase: "failed"; code: string; message: string; seats?: number[] };

const BACKOFF = [2_000, 5_000, 10_000];
const WATCH_MS = 120_000;
/** A send that failed may still have been broadcast: how long the chain is watched for it. */
const FAILED_SEND_WATCH_MS = 30_000;

/** Whether the moved tickets sit where `planned` put them now. */
async function landedOnChain(planned: PlannedMoves, io: Ledger2ClientIO, ledger: string): Promise<boolean> {
  const now = await io.slots(ledger, planned.onChainEventId, [...planned.after.keys()]).catch(() => null);
  return !!now && [...planned.after].every(([slot, seat]) => now.get(slot)?.seat === seat);
}

/** Send, retrying what never got a verdict, then settle from the chain. */
export async function sendSeatMoves(
  eventId: string,
  ledger: string,
  signed: { request: Ledger2RelayRequest; planned: PlannedMoves },
  io: Ledger2ClientIO,
  message: (err: unknown) => string,
): Promise<SeatMoveOutcome> {
  let result: Ledger2RelayResult | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await io.relay(eventId, signed.request);
      break;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "network";
      if (isTransient(err) && attempt < BACKOFF.length) {
        await io.sleep(BACKOFF[attempt]!);
        continue;
      }
      // A send that failed after it may have been broadcast: the chain decides, given a
      // little time to mine it (S6 sign-off change 7).
      if (code === "relay_failed") {
        const until = Date.now() + FAILED_SEND_WATCH_MS;
        while (true) {
          if (await landedOnChain(signed.planned, io, ledger)) return { phase: "moved" };
          if (Date.now() >= until) break;
          await io.sleep(5_000);
        }
      }
      const seats = (err as { body?: { seats?: unknown } })?.body?.seats;
      return { phase: "failed", code, message: message(err), ...(Array.isArray(seats) ? { seats: seats as number[] } : {}) };
    }
  }
  if (result.status === "landed" && result.landed?.every(Boolean)) return { phase: "moved" };
  if (result.status === "reverted_on_chain") {
    // The reverted batch published the move signatures, live for up to an hour: if the
    // relay's own abort did not land, revoke them from here (S6 sign-off change 5). Best effort.
    const abort = signed.request.aborts?.[0];
    if (result.aborted === false && abort) {
      await io.relay(eventId, { items: [{ kind: "revoke", ...abort }] }).catch(() => undefined);
    }
    return { phase: "failed", code: "reverted", message: "The change didn't go through - the seats were changed meanwhile. Nothing was moved." };
  }
  const until = Date.now() + WATCH_MS;
  while (Date.now() < until) {
    if (await landedOnChain(signed.planned, io, ledger)) return { phase: "moved" };
    await io.sleep(5_000);
  }
  return { phase: "unconfirmed" };
}
