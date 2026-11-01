/**
 * The organiser's orders list, read by the browser (#965). The server used to
 * read every ticket - one chain read and one Swarm download each - on every load
 * and every poll that saw a sale. Now:
 *
 *   1. the server says which registration each series is on (once a page);
 *   2. the browser reads each slot (owner, orderRef) from the chain itself;
 *   3. it sends those order roots back, and the server answers which are erased,
 *      by root, plus paid times, refunds and paid orders not yet on Swarm;
 *   4. the rows go on screen at once; `detail-queue.ts` then fetches the sealed
 *      orders in the background - only roots this answer covers and does not
 *      list as erased, and never kept beyond this page.
 *
 * The erasure answer for exactly the roots shown comes before any order is
 * fetched or opened: a load whose answer fails shows nothing new, and its
 * `Coverage` is the only thing that lets the queue fetch at all.
 *
 * Nothing here is persisted. A page open reads every slot again (owners move by
 * transfer and reissue); a poll reads only slots sold since, and retries any
 * slot whose read failed.
 */
import type { OrderEntry, OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { EventOrdersResponse } from "../../api/events.js";
import type { RequestSigningOptions } from "../../auth/request-session.js";
import type { Coverage } from "./detail-queue.js";

export interface SlotRead {
  owner: string;
  /** bytes32, 0x-prefixed. */
  orderRef: string;
}

export interface BrowserOrdersDeps {
  /** `opts.establish: false` for a poll: never starts a sign-in. */
  status(roots: string[], opts?: RequestSigningOptions): Promise<OrdersStatus>;
  /** `nextSlot` of each registration, in order. */
  nextSlots(ledgers: OrdersSeriesLedger[]): Promise<number[]>;
  /** Slots [from, to) of one registration, in order; null where a read failed. */
  slots(ledger: OrdersSeriesLedger, from: number, to: number): Promise<Array<SlotRead | null>>;
}

export interface RowsRead {
  /** Every row, held boxes attached; boxes from the gateway come later, through `build`. */
  rows: EventOrdersResponse;
  coverage: Coverage;
}

/**
 * The server could not give its answer. Its full read would fail the same way, so
 * the caller shows nothing new instead of asking it (Fable sign-off S5).
 */
export class OrdersStatusUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "the orders' status is unavailable");
    this.name = "OrdersStatusUnavailable";
  }
}

/** A sale this recent may not be stored yet: its 404 gets one more look (detail-queue.ts). */
export const RECENT_SALE_MS = 10 * 60_000;

/** The orderRef as an order root (64 hex, no 0x); null for an empty slot ref. */
export function orderRoot(orderRef: string): string | null {
  const hex = orderRef.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) && !/^0+$/.test(hex) ? hex : null;
}

const ledgerKey = (l: OrdersSeriesLedger) => `${l.chainId}:${l.contract}:${l.onChainEventId}`.toLowerCase();

export class BrowserOrders {
  /** seriesId -> registration, from the latest answer. null until the first. */
  private ledgers: Map<string, OrdersSeriesLedger> | null = null;
  private readable = true;
  /** seriesId -> { which registration, its slots by index }. This page only. */
  private rows = new Map<string, { key: string; slots: Array<SlotRead | null> }>();
  /** The latest answer for the rows read, as `build` needs it. */
  private answer: { status: OrdersStatus; erased: Set<string>; held: Map<string, SealedBoxV2> } | null = null;
  private epoch = 0;

  constructor(
    private readonly deps: BrowserOrdersDeps,
    private readonly canRead: (ledger: OrdersSeriesLedger) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Tickets sold across the event, from the chain. null = not known here yet: ask the server. */
  async count(): Promise<number | null> {
    if (!this.ledgers || !this.readable) return null;
    const ledgers = [...this.ledgers.values()];
    if (ledgers.length === 0) return 0;
    return (await this.deps.nextSlots(ledgers)).reduce((a, b) => a + b, 0);
  }

  /**
   * Every row and the erasure answer that covers them, or null when a series sells
   * on a registration this browser cannot read (the caller then asks the server).
   * Throws when a read failed; nothing new is shown then. No sealed order is
   * fetched here: that is the queue's, under the returned `coverage`.
   */
  async loadRows(opts?: RequestSigningOptions): Promise<RowsRead | null> {
    if (this.ledgers === null) this.remember(await this.askStatus([], opts));
    if (!this.readable) return null;

    const series = [...this.ledgers!.entries()];
    const next = await this.deps.nextSlots(series.map(([, l]) => l));
    for (const [i, [seriesId, ledger]] of series.entries()) {
      const key = ledgerKey(ledger);
      const have = this.rows.get(seriesId);
      const slots = have && have.key === key ? have.slots : [];
      const gap = slots.indexOf(null);
      const from = Math.min(gap === -1 ? slots.length : gap, next[i]);
      const fresh = from < next[i] ? await this.deps.slots(ledger, from, next[i]) : [];
      this.rows.set(seriesId, { key, slots: [...slots.slice(0, from), ...fresh] });
    }

    const roots = new Set<string>();
    for (const { slots } of this.rows.values()) {
      for (const s of slots) {
        const root = s ? orderRoot(s.orderRef) : null;
        if (root) roots.add(root);
      }
    }

    // The erasure answer for exactly these roots, before any order is fetched or opened.
    const status = await this.askStatus([...roots], opts);
    this.remember(status);
    if (!this.readable) return null;
    const erased = new Set(status.erased);
    const held = new Map(status.held.map((h) => [h.root, h.encryptedOrder]));
    this.answer = { status, erased, held };

    const now = this.now();
    const recent = new Set<string>();
    for (const s of status.series) {
      const read = s.ledger ? this.rows.get(s.seriesId) : undefined;
      if (!read || read.key !== ledgerKey(s.ledger!)) continue;
      read.slots.forEach((slot, i) => {
        const root = slot ? orderRoot(slot.orderRef) : null;
        const paid = Date.parse(s.paidAt[String(i)] ?? "");
        if (root && now - paid < RECENT_SALE_MS) recent.add(root);
      });
    }
    const fetchable = new Set([...roots].filter((r) => !erased.has(r) && !held.has(r)));
    return { rows: this.build(() => undefined), coverage: { epoch: ++this.epoch, at: now, fetchable, recent } };
  }

  /** The order root behind a row, if its slot was read and carries one. */
  rootOf(order: { seriesId: string; edition: number }): string | null {
    const slot = this.rows.get(order.seriesId)?.slots[order.edition - 1];
    return slot ? orderRoot(slot.orderRef) : null;
  }

  private async askStatus(roots: string[], opts?: RequestSigningOptions): Promise<OrdersStatus> {
    try {
      return await this.deps.status(roots, opts);
    } catch (err) {
      throw new OrdersStatusUnavailable(err);
    }
  }

  private remember(status: OrdersStatus): void {
    const ledgers = new Map<string, OrdersSeriesLedger>();
    for (const s of status.series) if (s.ledger) ledgers.set(s.seriesId, s.ledger);
    this.ledgers = ledgers;
    this.readable = [...ledgers.values()].every(this.canRead);
  }

  /**
   * The rows under the latest answer, each with its box: held from the answer, else
   * whatever `boxFor` has (the queue's). An erased root never gets one.
   */
  build(boxFor: (root: string) => SealedBoxV2 | undefined): EventOrdersResponse {
    if (!this.answer) throw new Error("build before any rows were read");
    const { status, erased, held } = this.answer;
    const orders: OrderEntry[] = [];
    for (const s of status.series) {
      if (!s.ledger) continue;
      // Rows read from another registration than the answer names are not shown; the next load reads them.
      const read = this.rows.get(s.seriesId);
      const slots = read && read.key === ledgerKey(s.ledger) ? read.slots : [];
      slots.forEach((slot, i) => {
        if (!slot) return;
        const root = orderRoot(slot.orderRef);
        const isErased = root !== null && erased.has(root);
        const box = root && !isErased ? (held.get(root) ?? boxFor(root)) : undefined;
        const refund = s.refund[String(i)];
        orders.push({
          seriesId: s.seriesId,
          seriesName: s.seriesName,
          edition: i + 1,
          ...(refund ? { refund } : {}),
          ...(isErased ? { erased: true as const } : {}),
          claimerAddress: slot.owner,
          claimedAt: s.paidAt[String(i)] ?? "",
          via: "stripe" as const,
          ...(box ? { encryptedOrder: box } : {}),
        });
      });
    }
    return { eventId: status.eventId, eventTitle: status.eventTitle, orders };
  }
}
