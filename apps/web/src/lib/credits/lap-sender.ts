/**
 * The lap sender: drains the journal to the network, one step at a time.
 *
 * Everything that touches storage, keys or Swarm is INJECTED, so the ordering
 * rules below run under test with fakes — they are the rules a phone in a park
 * cannot be made to exercise on demand, and getting one wrong writes a wrong
 * number into a feed that cannot be corrected.
 *
 * THE ORDER, and why each step is where it is:
 *
 *  1. A PREPARED write is always resolved first, by RE-SENDING IT UNCHANGED.
 *     Never rebuilt: an upload can land while its reply is lost, and a rebuilt
 *     statement would count those laps again on top of the landed one. The same
 *     bytes at the same address are deduped, and the read-back says `verified`.
 *  2. Only then is the next group of waiting taps bound to a new write — and
 *     the journal holding that write is SAVED BEFORE THE UPLOAD STARTS, so there
 *     is no moment at which an upload is in the air with nothing on the phone
 *     recording exactly what it was.
 *  3. Times are sealed LAST. They never block or fail a lap: the count is the
 *     product, and the journal keeps the times until the sealed copy lands.
 *
 * One run at a time. A tap during a run is simply picked up by the next pass.
 */

import type { VerifiedWriteResult } from "../swarm/verified-write.js";
import type { CreditHead } from "./credits.js";
import {
  beginPrepared,
  holdBefore,
  markAccepted,
  markAttempted,
  markSealed,
  nextGroup,
  nextUnsealed,
  preparedLanded,
  preparedLost,
  type CountedLaps,
  type LapJournal,
  type PreparedRide,
  type PreparedRideDraft,
} from "./lap-journal.js";

export type PrepareResult =
  | { ok: true; prepared: PreparedRideDraft }
  /** The live head is already on a later date than these taps. */
  | { ok: false; kind: "held"; heldBefore: string }
  /** Could not read or build right now — try again later. */
  | { ok: false; kind: "retry"; error: string };

export type SendResult =
  | { ok: true; version: number; band: number; settled: Promise<VerifiedWriteResult> }
  | { ok: false; error: string };

/** For a write that had to PROBE for its version (a first lap): it cannot be
 *  replayed at a known address, so whether it landed is read instead. */
export type ReconcileResult =
  | { status: "landed"; version: number; band: number }
  | { status: "absent" }
  | { status: "different" }
  | { status: "unavailable" };

export interface LapSenderDeps {
  read(): LapJournal;
  write(j: LapJournal): void;
  prepare(times: number[], warm: CreditHead | null): Promise<PrepareResult>;
  send(prepared: PreparedRide): Promise<SendResult>;
  reconcile(prepared: PreparedRide): Promise<ReconcileResult>;
  /** Seal one landed group's times. True once the sealed copy exists. */
  seal(laps: CountedLaps): Promise<boolean>;
  /** Anything the card renders from may have changed. */
  onChange(): void;
  /** Schedule a background retry. Injected so tests do not wait on timers. */
  retryLater(attempt: number): void;
}

/** Times could not be sealed this run. Distinct so it is never shown as a
 *  failure: nothing the rider did failed, and the count is already right. */
class SealPending extends Error {}

/** Consecutive lost races before the rider is told, rather than retried for. */
const MAX_SUPERSEDED_RUNS = 2;

export const ANOTHER_DEVICE = "Another device is recording laps at the same moment.";

export interface LapSender {
  /** Start draining if not already. Resolves when the current run ends. */
  kick(): Promise<void>;
  /** A head the caller read CLEANLY. Ignored while a write is in doubt: that
   *  write's own outcome decides the head, not a read that may predate it. */
  offerHead(head: CreditHead | null): void;
  /** Forget the warm head — the next prepare reads everything fresh. */
  dropHead(): void;
  readonly head: CreditHead | null;
  readonly running: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}

export function createLapSender(deps: LapSenderDeps): LapSender {
  let head: CreditHead | null = null;
  let running = false;
  let again = false;
  let error: string | null = null;
  let notice: string | null = null;
  let failures = 0;
  let current: Promise<void> = Promise.resolve();

  const mutate = (fn: (j: LapJournal) => LapJournal): void => {
    // Re-read, never reuse a journal held across an await: the rider may have
    // tapped in the meantime, and writing back a stale copy would erase the tap.
    deps.write(fn(deps.read()));
    deps.onChange();
  };

  /** One pass. Returns true when something was done and another pass is due. */
  async function step(supersededRuns: { n: number }): Promise<boolean> {
    const j = deps.read();

    if (j.prepared) {
      const prepared = j.prepared;

      // A probing write that was already attempted has no address to replay at.
      if (prepared.version === null && prepared.attempted) {
        const r = await deps.reconcile(prepared);
        if (r.status === "unavailable") throw new Error("Couldn't reach your collection just now.");
        if (r.status === "different") {
          head = null;
          mutate(preparedLost);
          return true;
        }
        if (r.status === "landed") {
          head = { statement: prepared.statement, visibility: prepared.visibility, version: r.version, band: r.band };
          mutate(preparedLanded);
          return true;
        }
        // absent: it never landed — send it.
      }

      mutate(markAttempted);
      const sent = await deps.send(prepared);
      if (!sent.ok) throw new Error(sent.error);

      // Accepted: the signed entry durably exists, so the count moves now. It
      // stays `prepared` until the read-back settles — a reload in between then
      // replays it and still learns of a `superseded`.
      head = { statement: prepared.statement, visibility: prepared.visibility, version: sent.version, band: sent.band };
      mutate(markAccepted);

      const settlement = await sent.settled;
      if (settlement.status === "superseded") {
        head = null;
        mutate(preparedLost);
        supersededRuns.n += 1;
        if (supersededRuns.n >= MAX_SUPERSEDED_RUNS) throw new Error(ANOTHER_DEVICE);
        return true;
      }
      supersededRuns.n = 0;
      // `unconfirmed` is accepted-but-not-read-back, which is routine (freshly
      // relayed chunks are whitelisted asynchronously) and NOT a failure.
      notice = settlement.status === "unconfirmed" ? "Saved - still settling on the network." : null;
      mutate(preparedLanded);
      return true;
    }

    const group = nextGroup(j);
    if (group) {
      const r = await deps.prepare(group.times, head);
      if (!r.ok) {
        if (r.kind === "held") {
          mutate((x) => holdBefore(x, r.heldBefore));
          return true;
        }
        throw new Error(r.error);
      }
      // SAVED BEFORE ANY UPLOAD. The next pass sends it.
      mutate((x) => beginPrepared(x, { ...r.prepared, attempted: false, accepted: false }));
      return true;
    }

    const unsealed = nextUnsealed(j);
    if (unsealed) {
      const ok = await deps.seal(unsealed).catch(() => false);
      // Not an error the rider can act on, and never one that touches the
      // count: the times stay in the journal and the next run tries again.
      if (!ok) throw new SealPending();
      mutate((x) => markSealed(x, unsealed.seq));
      return true;
    }

    return false;
  }

  async function run(): Promise<void> {
    running = true;
    error = null;
    deps.onChange();
    const supersededRuns = { n: 0 };
    try {
      do {
        again = false;
        while (await step(supersededRuns)) {
          /* keep draining */
        }
      } while (again);
      failures = 0;
    } catch (e) {
      failures += 1;
      if (!(e instanceof SealPending)) {
        error = e instanceof Error ? e.message : "Could not save that ride.";
      }
      deps.retryLater(failures);
    } finally {
      running = false;
      deps.onChange();
    }
  }

  return {
    kick() {
      if (running) {
        again = true;
        return current;
      }
      current = run();
      return current;
    },
    offerHead(h) {
      if (deps.read().prepared) return;
      // `seq` only ever rises for a (holder, subject), across publication too,
      // so a lower one is a read that started before a write of ours landed.
      // Building on it would only collide and retry — but it is avoidable.
      if (h && head && h.statement.seq < head.statement.seq) return;
      head = h;
    },
    dropHead() {
      head = null;
    },
    get head() {
      return head;
    },
    get running() {
      return running;
    },
    get error() {
      return error;
    },
    get notice() {
      return notice;
    },
  };
}
