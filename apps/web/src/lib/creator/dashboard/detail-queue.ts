/**
 * Fetches the organiser's sealed orders from the gateway in the background, after
 * the rows are already on screen (#965). One root = one sale's sealed order.
 *
 * ERASURE. Only roots the NEWEST erasure answer covers are fetched, and a fetched
 * box is kept only if the answer current when it ARRIVES still covers it: an answer
 * that lands mid-fetch and erases the root wins. An answer older than
 * COVERAGE_STALE_MS stops new fetches until a fresh one arrives; from
 * COVERAGE_REFRESH_MS the queue asks for one while it still has work. A load that
 * takes minutes therefore never runs on an erasure answer from minutes ago.
 *
 * BUNDLES. Where the gateway has a bundled read (`maxBatch()` > 1, our gateway's
 * POST /bytes-bundle), one request carries up to that many roots, page on screen
 * first, and counts once against everything below. Each root's answer settles by
 * the same rules as a single read; a bundle that fails as a whole retries together;
 * "unsupported" sends its roots back first and the page reads one at a time.
 *
 * PACING. At most CONCURRENCY at once. A gateway limits requests per connection,
 * and the rest of the app (and anyone else on the same connection, e.g. venue
 * staff) shares that allowance. Where the RateLimit headers are readable - our
 * gateway exposes them cross-origin since the bundle change, so this is the live
 * rule there - the queue stops with headroom left and resumes at the reset. Where
 * they are not (another gateway), it keeps to SELF_CAP_PER_MINUTE, or
 * BATCH_SELF_CAP_PER_MINUTE for bundles. A 429 pauses everything.
 *
 * A BACKGROUND queue (the audience sync's) keeps more headroom (`headroomShare`) and
 * issues nothing while `holdWhile()` says a foreground read in this tab - an open
 * dashboard - is using the same per-IP allowance (gateway-share.ts).
 *
 * NOTHING IS DROPPED SILENTLY. Every root ends ready, missing (404: its storage
 * expired or the chunk was evicted) or unreadable, or keeps retrying - and says
 * which, so a row never shows a blank that looks like data.
 *
 * Nothing here is persisted: boxes live in memory for this page only.
 */
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";

/** The gateway's RateLimit headers, when the browser can read them. */
export interface GatewayBudget {
  limit: number;
  remaining: number;
  /** Until the window resets. */
  resetMs: number;
}

export type FetchResult = (
  | { kind: "ok"; box: SealedBoxV2 }
  /** 404: nothing stored at this root any more. */
  | { kind: "missing" }
  /** Refused (403), server error, timeout or network: try again later. */
  | { kind: "unavailable" }
  /** 429. */
  | { kind: "limited"; retryAfterMs?: number }
  /** Not a sealed order, or too large to be one. */
  | { kind: "unreadable" }
) & { budget?: GatewayBudget };

/** One erasure answer, as the queue needs it. */
export interface Coverage {
  /** Grows with every answer; an older one arriving late is ignored. */
  epoch: number;
  /** When it arrived (the queue's clock). */
  at: number;
  /** Roots the answer covered, not erased and with no held box: the gateway may be asked for these. */
  fetchable: ReadonlySet<string>;
  /** Roots sold in the last few minutes: a 404 may only be the store not done yet. */
  recent: ReadonlySet<string>;
}

export type DetailState = "queued" | "fetching" | "retrying" | "ready" | "missing" | "unreadable";

/** One root's answer, from either kind of request. */
export type BatchResult =
  | { kind: "items"; items: ReadonlyMap<string, FetchResult>; budget?: GatewayBudget }
  /** 429 for the whole request. */
  | { kind: "limited"; retryAfterMs?: number; budget?: GatewayBudget }
  /** The request as a whole failed (network, 5xx): every root in it is retried, together. */
  | { kind: "unavailable"; budget?: GatewayBudget }
  /** The gateway has no bundled read. Nothing was tried: the roots go back first, and `maxBatch` now says 1. */
  | { kind: "unsupported" };

/** Requests in flight, one root each. */
export const CONCURRENCY = 4;
/** Requests in flight when each carries a bundle (up to 100 roots, ~0.3 MB). */
export const BATCH_CONCURRENCY = 2;
/** With no readable budget: 10 a second, well inside a 1,000-a-minute gateway with room for the rest of the app. */
export const SELF_CAP_PER_MINUTE = 600;
/** The same for bundles: inside our gateway's 120-a-minute bundle allowance. */
export const BATCH_SELF_CAP_PER_MINUTE = 90;
/** Retries that fall due together go out as one bundle, not one request each. */
export const RETRY_COALESCE_MS = 100;
/** With a readable budget: stop while less than this share of the allowance is left. */
export const HEADROOM_SHARE = 0.25;
/** While `holdWhile()` is true, look again this often. */
export const HOLD_RECHECK_MS = 1_000;
export const COVERAGE_REFRESH_MS = 60_000;
export const COVERAGE_STALE_MS = 90_000;
/** One more look at a 404 for a sale this recent: storing can lag the sale. */
export const MISSING_RECHECK_MS = 60_000;
/** A 429 never pauses for less: "Retry-After: 0" from a refusing gateway would otherwise be a tight loop. */
export const LIMITED_MIN_MS = 1_000;
const LIMITED_FIRST_MS = 5_000;
const LIMITED_MAX_MS = 60_000;
const UNAVAILABLE_FIRST_MS = 5_000;
const UNAVAILABLE_MAX_MS = 10 * 60_000;
const MINUTE = 60_000;

export interface DetailQueueDeps {
  /** One request for these roots (never more than `maxBatch()` said). */
  fetchBatch(roots: string[]): Promise<BatchResult>;
  /** How many roots the next request may carry: 1 when the gateway reads one at a time. */
  maxBatch(): number;
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** [0, 1): jitter for backoff. */
  random(): number;
  /** The newest answer is getting old while work remains: read a fresh one and `cover()` it. */
  wantCoverage(): void;
  /** Something a row shows changed. */
  onChange(): void;
  /** Stop while less than this share of a readable allowance is left. Default HEADROOM_SHARE. */
  headroomShare?: number;
  /** True = issue nothing for now (a foreground read is using the allowance); asked again shortly. */
  holdWhile?(): boolean;
}

interface Entry {
  state: DetailState;
  box?: SealedBoxV2;
  failures: number;
  rechecked: boolean;
  timer?: unknown;
}

export interface DetailProgress {
  /** Roots this page wants details for. */
  total: number;
  ready: number;
  /** Queued or being fetched. */
  waiting: number;
  retrying: number;
  missing: number;
  unreadable: number;
}

export class DetailQueue {
  private coverage: Coverage | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly counts: Record<DetailState, number> = { queued: 0, fetching: 0, retrying: 0, ready: 0, missing: 0, unreadable: 0 };
  /** Queued roots, next first. Holds exactly the entries in state "queued". */
  private pending: string[] = [];
  /** The page on screen. */
  private priority: string[] = [];
  /** Issue times in the last minute, for the self cap. */
  private issued: number[] = [];
  /** Requests in flight (a bundle is one). */
  private inFlight = 0;
  /** Timers that retry a whole failed bundle together. */
  private readonly groupTimers = new Set<unknown>();
  private budgetSeen = false;
  private pausedUntil = 0;
  private limitedStreak = 0;
  private askedAt = -Infinity;
  private wake: unknown = null;
  private wakeTime = Infinity;
  private stopped = false;

  constructor(private readonly deps: DetailQueueDeps) {}

  /** A new erasure answer. Roots it no longer offers are forgotten - box and all. */
  cover(c: Coverage): void {
    if (this.stopped || (this.coverage && c.epoch <= this.coverage.epoch)) return;
    this.coverage = c;
    for (const [root, e] of this.entries) if (!c.fetchable.has(root)) this.forget(root, e);
    for (const root of c.fetchable) {
      if (this.entries.has(root)) continue;
      const e: Entry = { state: "queued", failures: 0, rechecked: false };
      this.entries.set(root, e);
      this.counts.queued++;
      this.pending.push(root);
    }
    this.pending = this.pending.filter((r) => this.entries.get(r)?.state === "queued");
    this.reorder();
    this.deps.onChange();
    this.pump();
  }

  /** Fetch these first (the page on screen), in this order - now and after every answer. */
  prioritise(roots: readonly string[]): void {
    this.priority = [...roots];
    this.reorder();
  }

  private reorder(): void {
    const front = this.priority.filter((r) => this.entries.get(r)?.state === "queued");
    if (front.length === 0) return;
    const first = new Set(front);
    this.pending = [...first, ...this.pending.filter((r) => !first.has(r))];
  }

  state(root: string): DetailState | undefined {
    return this.entries.get(root)?.state;
  }

  box(root: string): SealedBoxV2 | undefined {
    return this.entries.get(root)?.box;
  }

  progress(): DetailProgress {
    const c = this.counts;
    return {
      total: this.entries.size,
      ready: c.ready,
      waiting: c.queued + c.fetching,
      retrying: c.retrying,
      missing: c.missing,
      unreadable: c.unreadable,
    };
  }

  /** Why fetching is held back right now, if it is. */
  waitingOn(): "gateway" | "erasure-check" | null {
    if (!this.coverage || (this.pending.length === 0 && this.counts.fetching === 0)) return null;
    const now = this.deps.now();
    if (now - this.coverage.at >= COVERAGE_STALE_MS) return "erasure-check";
    if (now < this.pausedUntil) return "gateway";
    return null;
  }

  stop(): void {
    this.stopped = true;
    if (this.wake !== null) this.deps.clearTimer(this.wake);
    this.wake = null;
    for (const e of this.entries.values()) if (e.timer !== undefined) this.deps.clearTimer(e.timer);
    for (const t of this.groupTimers) this.deps.clearTimer(t);
    this.groupTimers.clear();
  }

  private setState(e: Entry, s: DetailState): void {
    this.counts[e.state]--;
    this.counts[s]++;
    e.state = s;
  }

  private forget(root: string, e: Entry): void {
    if (e.timer !== undefined) this.deps.clearTimer(e.timer);
    this.counts[e.state]--;
    this.entries.delete(root);
  }

  private busy(): boolean {
    return this.pending.length > 0 || this.counts.fetching > 0 || this.counts.retrying > 0;
  }

  private pump(): void {
    if (this.stopped || !this.coverage) return;
    const now = this.deps.now();
    // Held: no fetch, and no fresh answer asked for either - the age check below runs
    // again on resume, so a long hold never resumes on an old answer.
    if (this.busy() && this.deps.holdWhile?.()) {
      this.wakeAt(now + HOLD_RECHECK_MS, now);
      return;
    }
    const age = now - this.coverage.at;
    if (this.busy() && age >= COVERAGE_REFRESH_MS && now - this.askedAt >= COVERAGE_REFRESH_MS) {
      this.askedAt = now;
      this.deps.wantCoverage();
    }
    if (age >= COVERAGE_STALE_MS) {
      // Wait for `cover()`; meanwhile keep asking, in case that read failed.
      if (this.busy()) this.wakeAt(now + COVERAGE_REFRESH_MS, now);
      return;
    }
    if (now < this.pausedUntil) {
      this.wakeAt(this.pausedUntil, now);
      return;
    }
    while (this.pending.length > 0) {
      // `|| 1`: a batch size that is not a number must never stall or spin this loop.
      const size = Math.max(1, Math.floor(this.deps.maxBatch()) || 1);
      if (this.inFlight >= (size > 1 ? BATCH_CONCURRENCY : CONCURRENCY)) break;
      const gate = this.nextIssueAt(now, size > 1);
      if (gate > now) {
        this.wakeAt(gate, now);
        return;
      }
      // Never waits to fill a bundle: whatever is queued (page on screen first) goes now.
      this.issue(this.pending.splice(0, size), now);
    }
    // The answer will need refreshing while work remains.
    const nextAsk = Math.max(this.coverage.at, this.askedAt) + COVERAGE_REFRESH_MS;
    if (this.busy() && nextAsk > now) this.wakeAt(nextAsk, now);
  }

  private nextIssueAt(now: number, batched: boolean): number {
    if (this.budgetSeen) return now;
    while (this.issued.length > 0 && this.issued[0] <= now - MINUTE) this.issued.shift();
    const cap = batched ? BATCH_SELF_CAP_PER_MINUTE : SELF_CAP_PER_MINUTE;
    return this.issued.length < cap ? now : this.issued[this.issued.length - cap] + MINUTE;
  }

  private issue(roots: string[], now: number): void {
    const batch = roots.map((root) => {
      const e = this.entries.get(root)!;
      this.setState(e, "fetching");
      return { root, e };
    });
    this.inFlight++;
    this.issued.push(now);
    this.deps.fetchBatch(roots).then(
      (r) => this.settleBatch(batch, r),
      () => this.settleBatch(batch, { kind: "unavailable" }),
    );
  }

  private settleBatch(batch: Array<{ root: string; e: Entry }>, r: BatchResult): void {
    this.inFlight--;
    if (this.stopped) return;
    const now = this.deps.now();
    if (r.kind !== "unsupported" && r.budget) this.noteBudget(r.budget, now);
    // Forgotten while in flight (erased, held, or no longer offered): their counts are gone already.
    const live = batch.filter(({ root, e }) => this.entries.get(root) === e);
    switch (r.kind) {
      case "items": {
        // Each root by the same rules as ever; one the answer left out is retried. Roots that go
        // back to the front go together afterwards, keeping the bundle's order.
        const front: Array<{ root: string; e: Entry }> = [];
        // One jitter for the whole bundle: its roots that must retry fall due together and
        // go out again as one bundle, not a scatter of small ones.
        const jitter = this.deps.random();
        for (const { root, e } of live) this.settleRoot(root, e, r.items.get(root) ?? { kind: "unavailable" }, now, front, jitter);
        this.requeueFront(front);
        break;
      }
      case "limited": {
        this.limitedStreak++;
        const wait = Math.max(LIMITED_MIN_MS, r.retryAfterMs ?? this.backoff(LIMITED_FIRST_MS, LIMITED_MAX_MS, this.limitedStreak));
        this.pausedUntil = Math.max(this.pausedUntil, now + wait);
        this.requeueFront(live);
        break;
      }
      case "unsupported":
        this.requeueFront(live);
        break;
      case "unavailable": {
        // The request failed as a whole: its roots wait the longest backoff any of them has earned, then go together.
        let worst = 0;
        for (const { e } of live) worst = Math.max(worst, ++e.failures);
        if (live.length > 0) this.retryTogether(live, this.backoff(UNAVAILABLE_FIRST_MS, UNAVAILABLE_MAX_MS, worst));
        break;
      }
    }
    this.deps.onChange();
    this.pump();
  }

  /** One root's answer. A root that must go back to the front is added to `front`, for the caller to requeue in order. */
  private settleRoot(
    root: string,
    e: Entry,
    r: FetchResult,
    now: number,
    front: Array<{ root: string; e: Entry }>,
    jitter: number,
  ): void {
    const c = this.coverage!;
    switch (r.kind) {
      case "ok":
        if (now - c.at >= COVERAGE_STALE_MS) {
          // No current answer vouches for it: fetch again once one does.
          front.push({ root, e });
          break;
        }
        this.limitedStreak = 0;
        e.box = r.box;
        this.setState(e, "ready");
        break;
      case "limited": {
        this.limitedStreak++;
        const wait = Math.max(LIMITED_MIN_MS, r.retryAfterMs ?? this.backoff(LIMITED_FIRST_MS, LIMITED_MAX_MS, this.limitedStreak));
        this.pausedUntil = Math.max(this.pausedUntil, now + wait);
        front.push({ root, e });
        break;
      }
      case "missing":
        if (!e.rechecked && c.recent.has(root)) {
          e.rechecked = true;
          this.retryLater(root, e, MISSING_RECHECK_MS);
        } else {
          this.setState(e, "missing");
        }
        break;
      case "unavailable":
        e.failures++;
        this.retryLater(root, e, this.backoff(UNAVAILABLE_FIRST_MS, UNAVAILABLE_MAX_MS, e.failures, jitter));
        break;
      case "unreadable":
        this.setState(e, "unreadable");
        break;
    }
  }

  /** Back to the front of the queue, in the order they were sent. */
  private requeueFront(list: Array<{ root: string; e: Entry }>): void {
    for (const { e } of list) this.setState(e, "queued");
    this.pending.unshift(...list.map(({ root }) => root));
  }

  /** One timer for a whole failed bundle, so it goes out again as one bundle. */
  private retryTogether(list: Array<{ root: string; e: Entry }>, ms: number): void {
    for (const { e } of list) this.setState(e, "retrying");
    const t = this.deps.setTimer(() => {
      this.groupTimers.delete(t);
      if (this.stopped) return;
      for (const { root, e } of list) {
        if (this.entries.get(root) === e && e.state === "retrying") this.requeue(root, e, false);
      }
      this.deps.onChange();
      this.pump();
    }, ms);
    this.groupTimers.add(t);
  }

  private noteBudget(b: GatewayBudget, now: number): void {
    this.budgetSeen = true;
    // A quarter of whatever allowance the gateway names: 250 of the general 1,000/min the
    // rest of the app shares, 30 of the bundle limiter's 120/min. (A fixed floor of 100
    // stopped bundles after 20 a minute - Fable sign-off 2026-11-02 S1.)
    const floor = Math.ceil(b.limit * (this.deps.headroomShare ?? HEADROOM_SHARE));
    if (b.remaining < floor) this.pausedUntil = Math.max(this.pausedUntil, now + b.resetMs);
  }

  private requeue(root: string, e: Entry, front: boolean): void {
    this.setState(e, "queued");
    if (front) this.pending.unshift(root);
    else this.pending.push(root);
  }

  private retryLater(root: string, e: Entry, ms: number): void {
    this.setState(e, "retrying");
    e.timer = this.deps.setTimer(() => {
      e.timer = undefined;
      if (this.stopped || this.entries.get(root) !== e) return;
      this.requeue(root, e, false);
      this.deps.onChange();
      // A moment's grace, so retries due together share one bundle.
      const now = this.deps.now();
      this.wakeAt(now + RETRY_COALESCE_MS, now);
    }, ms);
  }

  /** first, doubling per failure, capped; then up to a quarter less, so tabs do not retry in step. */
  private backoff(first: number, max: number, n: number, jitter: number = this.deps.random()): number {
    const base = Math.min(max, first * 2 ** Math.min(n - 1, 20));
    return Math.round(base * (1 - 0.25 * jitter));
  }

  private wakeAt(t: number, now: number): void {
    if (this.wake !== null && this.wakeTime <= t) return;
    if (this.wake !== null) this.deps.clearTimer(this.wake);
    this.wakeTime = t;
    this.wake = this.deps.setTimer(() => {
      this.wake = null;
      this.wakeTime = Infinity;
      this.pump();
    }, Math.max(0, t - now));
  }
}
