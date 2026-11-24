/**
 * Keeping one sale's ticket receipts (woco-ops/spec-receipt-note-20261123.md 5.2-5.3):
 * seal them to the order's pickup key, record them, and store the sealed box on the
 * erasable attendee batch (kind "holding").
 *
 * The box's /bytes root is computed locally before any upload (as a held order's), so
 * a guest's email link can name it even while the upload is still being retried. The
 * local copy in the record is dropped once the box is on the batch; until then
 * `retryUnstoredHoldings` keeps trying, and `/api/health` `holdingReceipts` is red after
 * an hour.
 *
 * A guest's secret arrives here only to build the email link, and goes nowhere else:
 * never in the record, never in a log.
 */

import { holdingBoxSealContext, sealBoxJson } from "@woco/shared/crypto/sealed-box";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import { holdingKeepFragment } from "@woco/shared/holding/pickup";
import type { HoldingTarget, TicketHolding } from "@woco/shared/holding/receipt";
import { HOLDING_RETENTION_MONTHS } from "@woco/shared/holding/request";
import { orderRefOf, storeAttendeePayload } from "../attendee-batch/writer.js";
import { erasureStarted } from "../attendee-batch/order-gateway.js";
import { errorClass } from "../http/error-class.js";
import { APP_BASE } from "../../routes/tickets.js";
import { getHolding, markHoldingStored, recordHoldingIssued, setHoldingBoxStoring, unstoredHoldings } from "./store.js";

export interface SignedReceipt {
  holding: TicketHolding;
  sig: string;
}

export interface KeepHoldingInput {
  sessionId: string;
  eventId: string;
  seriesId: string;
  target: HoldingTarget;
  receipts: SignedReceipt[];
  /** The order's pickup id and X-Wing public key (hex). */
  pickupId: string;
  pickupPub: string;
  emailHash?: string;
  /**
   * A guest order (option A): the public values to record, and the secret, used ONLY to
   * build the link. Absent for a signed-in buyer, whose request is already recorded.
   */
  guest?: {
    r: Uint8Array;
    holders: string[];
    answerKeys: string[];
    nkCommit: string;
    pickupSigner: string;
  };
}

export interface KeepHoldingDeps {
  store: typeof storeAttendeePayload;
  now(): number;
  /** How long the ticket email waits for the first store; the retry worker finishes it. */
  storeWaitMs?: number;
}

const STORE_WAIT_MS = 5_000;
const liveDeps: KeepHoldingDeps = { store: storeAttendeePayload, now: () => Date.now() };

/** Boxes being stored right now, so the retry worker never stores the same one twice at once. */
const storing = new Set<string>();
let retrying = false;

function boxOf(input: KeepHoldingInput): HoldingBoxV1 {
  return {
    v: 1,
    receipts: input.receipts.map(({ holding, sig }) => ({
      ...holding,
      chainId: input.target.chainId,
      ledger: input.target.ledger,
      wocoEventId: input.eventId,
      seriesId: input.seriesId,
      edition: holding.slot + 1,
      sig,
    })),
  };
}

async function storeBox(sessionId: string, box: SealedBoxV2, meta: { eventId: string; seriesId: string; emailHash?: string }, boxRoot: string, deps: KeepHoldingDeps): Promise<boolean> {
  storing.add(sessionId);
  setHoldingBoxStoring(boxRoot, true);
  try {
    const json = JSON.stringify(box);
    // Before any upload: a box that does not hash to the root its record (and a guest's
    // link) names is never stored.
    if ((await orderRefOf(json)) !== boxRoot) throw new Error("the box does not hash to its recorded root");
    const stored = await deps.store(json, {
      kind: "holding",
      eventId: meta.eventId,
      seriesId: meta.seriesId,
      ...(meta.emailHash ? { emailHash: meta.emailHash } : {}),
      retainMonths: HOLDING_RETENTION_MONTHS,
    });
    if (stored !== boxRoot) throw new Error("attendee batch stored the box under another root");
    return markHoldingStored(sessionId, deps.now());
  } finally {
    storing.delete(sessionId);
    setHoldingBoxStoring(boxRoot, false);
  }
}

/** Wait for `p` at most `ms`; true if it finished in time. Its failure is logged, never thrown. */
function settledWithin(p: Promise<unknown>, ms: number, sessionId: string): Promise<boolean> {
  const done = p.then(
    () => true,
    (err) => {
      console.error(`[holding] ${sessionId}: box not stored yet, the retry worker will (${errorClass(err)})`);
      return true;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([done, late]).finally(() => clearTimeout(timer));
}

/**
 * Seal, record and store one sale's receipts. Returns the box root, plus the email link
 * for a guest, or null when nothing could be recorded (no link then: a link to a box
 * nobody can find would be worse than none). Never throws.
 */
export async function keepHoldingReceipts(
  input: KeepHoldingInput,
  deps: KeepHoldingDeps = liveDeps,
): Promise<{ boxRoot: string; keepUrl?: string } | null> {
  try {
    if (input.receipts.length === 0) return null;
    const sealed = await sealBoxJson(input.pickupPub, boxOf(input), holdingBoxSealContext(input.pickupId));
    const boxRoot = await orderRefOf(JSON.stringify(sealed));
    const g = input.guest;
    const recorded = recordHoldingIssued({
      sessionId: input.sessionId,
      eventId: input.eventId,
      seriesId: input.seriesId,
      ...(g
        ? {
            guest: {
              holders: g.holders,
              answerKeys: g.answerKeys,
              nkCommit: g.nkCommit,
              pickupId: input.pickupId,
              pickupSigner: g.pickupSigner,
              pickupPub: input.pickupPub,
            },
          }
        : {}),
      issued: {
        chainId: input.target.chainId,
        ledger: input.target.ledger,
        onChainEventId: input.receipts[0]!.holding.eventId,
        slots: input.receipts.map((x) => x.holding.slot),
        boxRoot,
        box: sealed,
        ...(input.emailHash ? { emailHash: input.emailHash } : {}),
      },
      now: deps.now(),
    });
    if (!recorded) return null;
    // The record and the link need no upload, so the ticket email never waits long on
    // the batch: a store still running after the wait finishes on its own, or the retry
    // worker takes it over once it has given up.
    const inTime = await settledWithin(storeBox(input.sessionId, sealed, input, boxRoot, deps), deps.storeWaitMs ?? STORE_WAIT_MS, input.sessionId);
    if (!inTime) console.warn(`[holding] ${input.sessionId}: box store still running; the email goes now`);
    return g ? { boxRoot, keepUrl: `${APP_BASE}/${holdingKeepFragment(g.r, boxRoot)}` } : { boxRoot };
  } catch (err) {
    console.error(`[holding] ${input.sessionId}: receipts not kept (${errorClass(err)})`);
    return null;
  }
}

/**
 * Store boxes whose first upload failed. Run on an interval; never throws. One pass at
 * a time (a long bee outage must not stack a pass a minute), never a box already being
 * stored, and never one whose erasure has started (the sweep drops those). Each box is
 * read again just before its store: an erasure may have reached it while the previous
 * one uploaded.
 */
export async function retryUnstoredHoldings(limit = 20, deps: KeepHoldingDeps = liveDeps): Promise<{ stored: number; failed: number }> {
  let stored = 0;
  let failed = 0;
  if (retrying) return { stored, failed };
  retrying = true;
  try {
    const due = unstoredHoldings().filter((r) => !storing.has(r.sessionId) && !erasureStarted(r.issued!.boxRoot));
    for (const listed of due.slice(0, limit)) {
      const r = getHolding(listed.sessionId);
      if (!r?.issued?.box || r.issued.storedAt || r.erasedAt || storing.has(r.sessionId) || erasureStarted(r.issued.boxRoot)) continue;
      try {
        if (await storeBox(r.sessionId, r.issued.box, { eventId: r.eventId, seriesId: r.seriesId, emailHash: r.issued.emailHash }, r.issued.boxRoot, deps)) stored++;
        else failed++;
      } catch (err) {
        failed++;
        console.error(`[holding] ${r.sessionId}: retry store failed (${errorClass(err)})`);
      }
    }
  } finally {
    retrying = false;
  }
  return { stored, failed };
}
