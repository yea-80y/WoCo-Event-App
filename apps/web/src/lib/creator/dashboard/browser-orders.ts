/**
 * The organiser's orders list, read by the browser (#965). The server used to
 * read every ticket - one chain read and one Swarm download each - on every load
 * and every poll that saw a sale. Now:
 *
 *   1. the server says which registration each series is on (once a page);
 *   2. the browser reads each slot (owner, orderRef) from the chain itself;
 *   3. it sends those order roots back, and the server answers which are erased,
 *      by root, plus paid times, refunds and paid orders not yet on Swarm;
 *   4. only then does it fetch, from our gateway, the sealed orders it has not
 *      fetched yet - never an erased one, and never kept beyond this page.
 *
 * The erasure answer for exactly the roots shown comes before any order is
 * fetched or opened: a load whose answer fails shows nothing new. A box fetched
 * earlier on this page is dropped as soon as an answer lists its root.
 *
 * Nothing here is persisted. A page open reads every slot again (owners move by
 * transfer and reissue); a poll reads only slots sold since, and retries any
 * slot whose read failed.
 */
import type { OrderEntry, OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { EventOrdersResponse } from "../../api/events.js";
import type { RequestSigningOptions } from "../../auth/request-session.js";

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
  /** The sealed order at `root`, or null when it could not be read. */
  fetchBox(root: string): Promise<SealedBoxV2 | null>;
}

/** Concurrent gateway reads: the same ceiling the server used for this. */
const BOX_CONCURRENCY = 8;

/** The orderRef as an order root (64 hex, no 0x); null for an empty slot ref. */
export function orderRoot(orderRef: string): string | null {
  const hex = orderRef.toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(hex) && !/^0+$/.test(hex) ? hex : null;
}

const ledgerKey = (l: OrdersSeriesLedger) => `${l.chainId}:${l.contract}:${l.onChainEventId}`.toLowerCase();

async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export class BrowserOrders {
  /** seriesId -> registration, from the latest answer. null until the first. */
  private ledgers: Map<string, OrdersSeriesLedger> | null = null;
  private readable = true;
  /** seriesId -> { which registration, its slots by index }. This page only. */
  private rows = new Map<string, { key: string; slots: Array<SlotRead | null> }>();
  /** root -> sealed order. This page only; an erased root is dropped. */
  private boxes = new Map<string, SealedBoxV2>();

  constructor(
    private readonly deps: BrowserOrdersDeps,
    private readonly canRead: (ledger: OrdersSeriesLedger) => boolean,
  ) {}

  /** Tickets sold across the event, from the chain. null = not known here yet: ask the server. */
  async count(): Promise<number | null> {
    if (!this.ledgers || !this.readable) return null;
    const ledgers = [...this.ledgers.values()];
    if (ledgers.length === 0) return 0;
    return (await this.deps.nextSlots(ledgers)).reduce((a, b) => a + b, 0);
  }

  /**
   * The full list, or null when a series sells on a registration this browser
   * cannot read (the caller then asks the server). Throws when a read failed;
   * nothing new is shown then.
   */
  async load(opts?: RequestSigningOptions): Promise<EventOrdersResponse | null> {
    if (this.ledgers === null) this.remember(await this.deps.status([], opts));
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
    const status = await this.deps.status([...roots], opts);
    this.remember(status);
    if (!this.readable) return null;
    const erased = new Set(status.erased);
    for (const root of erased) this.boxes.delete(root);
    const held = new Map(status.held.map((h) => [h.root, h.encryptedOrder]));

    const wanted = [...roots].filter((r) => !erased.has(r) && !held.has(r) && !this.boxes.has(r));
    await eachLimited(wanted, BOX_CONCURRENCY, async (root) => {
      const box = await this.deps.fetchBox(root);
      if (box) this.boxes.set(root, box);
    });

    return this.build(status, erased, held);
  }

  private remember(status: OrdersStatus): void {
    const ledgers = new Map<string, OrdersSeriesLedger>();
    for (const s of status.series) if (s.ledger) ledgers.set(s.seriesId, s.ledger);
    this.ledgers = ledgers;
    this.readable = [...ledgers.values()].every(this.canRead);
  }

  private build(status: OrdersStatus, erased: Set<string>, held: Map<string, SealedBoxV2>): EventOrdersResponse {
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
        const box = root && !isErased ? (held.get(root) ?? this.boxes.get(root)) : undefined;
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
