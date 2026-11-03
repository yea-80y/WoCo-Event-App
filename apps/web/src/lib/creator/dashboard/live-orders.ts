/**
 * The organiser dashboard picks up new sales while it is open - the rules; the
 * wiring is in `Dashboard.svelte`.
 *
 * A full orders read costs one chain read per sold ticket and one Swarm download
 * per order, so the dashboard polls the cheap count instead (one ledger read per
 * series, `GET /orders/count`) and reads the full list only when the count moves
 * - the same gate the audience sync uses. Polling runs only while the page is
 * visible: a hidden tab costs nothing, and coming back checks at once. Failed
 * checks back off (doubling to five minutes), so an RPC outage is not hammered
 * from every open tab. A poll never signs in: with no stored session it stops,
 * and its requests are sent with `establish: false` (Fable sign-off 2026-10-14).
 *
 * New orders are opened as they arrive when the account's keys are already open,
 * and only the new ones: an order already opened is reused for as long as its
 * sealed box is the same box. Nothing here ever asks for the keys.
 */
import type { OrderEntry } from "@woco/shared";

/** Visible-tab cadence. A sale shows within this; each check is one ledger read per series. */
export const ORDERS_POLL_MS = 30_000;

/** The longest wait between checks after repeated failures. */
export const ORDERS_POLL_MAX_MS = 5 * 60_000;

/** The wait before the next check: the cadence, doubled per failure in a row, capped. */
export function pollDelay(intervalMs: number, failures: number): number {
  return Math.min(intervalMs * 2 ** Math.min(failures, 16), ORDERS_POLL_MAX_MS);
}

/** A focus event right after a visibility change (or a tick) is the same return: one check. */
export const RECHECK_GAP_MS = 5_000;

/** One sold ticket. Stable across reads; positions in the list are not. */
export function orderSlotKey(order: { seriesId: string; edition: number }): string {
  return `${order.seriesId}\0${order.edition}`;
}

/** The sealed box's own identity - its KEM ciphertext, fresh for every seal. */
function boxId(order: OrderEntry): string | null {
  const box = order.encryptedOrder as { enc?: unknown } | undefined;
  return box && typeof box.enc === "string" ? box.enc : null;
}

/**
 * What this page has already opened, keyed by ticket. An order is reused only
 * while it carries the SAME box: an erased order (no box) or a re-sealed one is
 * never shown from an earlier opening.
 *
 * A row with no box has nothing opened, so it gets no entry - not an empty one.
 * Rows now arrive before their boxes (#965): an empty entry would read as "opened,
 * no details" and hide where the row's details actually stand.
 */
export class OpenedOrders<T> {
  private byTicket = new Map<string, { box: string; data: T }>();
  /** ticket -> the box that would not open: not tried again until the box changes or the keys lock. */
  private failed = new Map<string, string>();
  /** Set once orders were opened with the account's keys. */
  private opened = false;
  /** `nextUnopened`'s place in the list it last walked. */
  private pending: { from: OrderEntry[]; todo: Array<{ idx: number; order: OrderEntry }>; at: number } | null = null;

  /** The display map for `orders` (by position), from what is already open - no keys, no work. */
  remap(orders: OrderEntry[]): Map<number, T> {
    const out = new Map<number, T>();
    if (!this.opened) return out;
    orders.forEach((order, idx) => {
      const box = boxId(order);
      if (!box) return;
      const hit = this.byTicket.get(orderSlotKey(order));
      if (hit && hit.box === box) out.set(idx, hit.data);
    });
    return out;
  }

  /** Orders with a box this page has not opened yet, nor failed to open. */
  unopened(orders: OrderEntry[]): Array<{ idx: number; order: OrderEntry }> {
    const out: Array<{ idx: number; order: OrderEntry }> = [];
    orders.forEach((order, idx) => {
      if (this.wants(order)) out.push({ idx, order });
    });
    return out;
  }

  /**
   * The next `n` of `unopened(orders)`, without walking the whole list each step (#1061:
   * at 24k rows, one walk per 50-order step held the page for most of a load). The list
   * is walked again only when `orders` is a different array: the page never changes a
   * list in place, so a new array is how an erased or re-sealed order arrives. Entries
   * come back until they are opened or failed, so a step abandoned midway is offered again.
   */
  nextUnopened(orders: OrderEntry[], n: number): Array<{ idx: number; order: OrderEntry }> {
    if (this.pending?.from !== orders) this.pending = { from: orders, todo: this.unopened(orders), at: 0 };
    const p = this.pending;
    while (p.at < p.todo.length && !this.wants(p.todo[p.at].order)) p.at++;
    const out: Array<{ idx: number; order: OrderEntry }> = [];
    for (let i = p.at; i < p.todo.length && out.length < n; i++) {
      if (this.wants(p.todo[i].order)) out.push(p.todo[i]);
    }
    return out;
  }

  /** Has a box, and it is neither open nor one that would not open. */
  private wants(order: OrderEntry): boolean {
    const box = boxId(order);
    if (!box) return false;
    const key = orderSlotKey(order);
    if (this.failed.get(key) === box) return false;
    return this.byTicket.get(key)?.box !== box;
  }

  put(order: OrderEntry, data: T): void {
    const box = boxId(order);
    if (box) this.byTicket.set(orderSlotKey(order), { box, data });
  }

  /** This order's box would not open with the keys here. */
  fail(order: OrderEntry): void {
    const box = boxId(order);
    if (box) this.failed.set(orderSlotKey(order), box);
  }

  /** Boxes on screen that would not open. */
  get failures(): number {
    return this.failed.size;
  }

  /**
   * Forget everything no row carries any more - an order erased (its box gone) or
   * re-sealed: opened details never outlive the box they came from.
   */
  prune(orders: OrderEntry[]): void {
    const live = new Map(orders.map((o) => [orderSlotKey(o), boxId(o)]));
    for (const [key, hit] of this.byTicket) if (live.get(key) !== hit.box) this.byTicket.delete(key);
    for (const [key, box] of this.failed) if (live.get(key) !== box) this.failed.delete(key);
  }

  /** The keys were open for this run. */
  markOpened(): void {
    this.opened = true;
  }

  /** The keys locked again: forget everything opened, so nothing shows without them. */
  clear(): void {
    this.byTicket.clear();
    this.failed.clear();
    this.opened = false;
    this.pending = null;
  }
}

/**
 * Opening runs, one at a time. A run still waiting to start reads the rows on screen
 * when it starts, which is all a new one would do, so a call joins it: each arriving
 * bundle asks, and a long load used to stack hundreds of runs (#1061). A tap's run,
 * which may ask for the passkey, is never covered by a quiet one; a quiet call may
 * join a tap's, so no call asks that was not already going to.
 */
export class RunQueue {
  private chain: Promise<void> = Promise.resolve();
  private waiting: { prompt: boolean; run: Promise<void> } | null = null;

  /** `onError` sees every run that throws: the queue keeps moving, never silently. */
  constructor(private readonly onError: (err: unknown) => void) {}

  enqueue(prompt: boolean, start: (prompt: boolean) => Promise<void>): Promise<void> {
    if (this.waiting && (this.waiting.prompt || !prompt)) return this.waiting.run;
    const waiting = { prompt, run: Promise.resolve() };
    const run = this.chain.then(() => {
      if (this.waiting === waiting) this.waiting = null;
      return start(prompt);
    });
    waiting.run = run;
    this.waiting = waiting;
    // A swallowed throw here hid every attendee's details on 2026-11-02, with nothing
    // on screen or in the console.
    this.chain = run.catch((err) => this.onError(err));
    return run;
  }
}

export interface OrdersPollerDeps {
  intervalMs: number;
  /** Sold tickets across the event, from the cheap count. */
  count(): Promise<number>;
  /** Read the full list and show it. False = nothing was shown (failed read). */
  refresh(): Promise<boolean>;
  /** A session is in memory - the cheap, synchronous check. */
  canRequest(): boolean;
  /**
   * The stored session is still on this device (read, never signed). Gone = signed
   * out elsewhere or cleared: the poller STOPS, since only a real sign-in can bring
   * it back, and a request now would start one.
   */
  sessionStored(): Promise<boolean>;
  isVisible(): boolean;
  onVisibilityChange(cb: () => void): () => void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface OrdersPoller {
  /** `known` = how many orders are on screen now. */
  start(known: number): void;
  stop(): void;
  /** One check: the count, then the full list only if it moved. */
  tick(): Promise<void>;
  /** The page came back into view or got focus. */
  resume(): void;
  /** Checks that failed in a row - the backoff. */
  readonly failures: number;
}

export function createOrdersPoller(deps: OrdersPollerDeps): OrdersPoller {
  let known: number | null = null;
  let timer: unknown = null;
  let running = false;
  let inFlight = false;
  let failures = 0;
  let lastTickAt = -Infinity;
  let unsubscribe: (() => void) | null = null;

  const stopTimer = () => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };
  /** The next check, while running and in view. Hidden: the visibility handler resumes. */
  const schedule = () => {
    stopTimer();
    if (!running || !deps.isVisible()) return;
    timer = deps.setTimeout(() => {
      timer = null;
      void tick();
    }, pollDelay(deps.intervalMs, failures));
  };

  function stop(): void {
    running = false;
    stopTimer();
    unsubscribe?.();
    unsubscribe = null;
  }

  async function tick(): Promise<void> {
    if (!running || inFlight || !deps.isVisible()) return;
    if (!deps.canRequest()) {
      schedule();
      return;
    }
    inFlight = true;
    lastTickAt = deps.now();
    try {
      if (!(await deps.sessionStored())) {
        stop();
        return;
      }
      if (!running) return;
      const count = await deps.count();
      if (!running) return;
      if (count !== known) {
        // Only a list actually shown moves the mark: a failed read is retried.
        if (!(await deps.refresh())) {
          failures++;
          return;
        }
        known = count;
      }
      failures = 0;
    } catch {
      // Offline or a failed read: back off, then try again.
      failures++;
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function onVisibility(): void {
    if (!running) return;
    if (!deps.isVisible()) {
      stopTimer();
      return;
    }
    if (deps.now() - lastTickAt >= RECHECK_GAP_MS) void tick();
    else if (!inFlight) schedule();
  }

  return {
    start(initial: number) {
      if (running) return;
      running = true;
      known = initial;
      unsubscribe = deps.onVisibilityChange(onVisibility);
      schedule();
    },
    stop,
    tick,
    resume: onVisibility,
    get failures() {
      return failures;
    },
  };
}
