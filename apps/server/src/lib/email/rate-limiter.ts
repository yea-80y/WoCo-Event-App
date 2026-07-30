/**
 * Account-wide outbound send-rate limiter.
 *
 * SES grants a MAXIMUM SEND RATE (messages/second) per account, not per caller —
 * 14/s for us as of 2026-07-30. Exceeding it returns `TooManyRequestsException`,
 * which the old marketing loop counted as `failed` with no retry, so recipients
 * were simply never mailed. Shaping the traffic here is better than retrying
 * after the fact: a throttled request still costs a round trip and still burns
 * the SDK's retry budget.
 *
 * This lives at the `sendEmail` chokepoint precisely because the SES limit is
 * account-wide. A per-caller limiter would let a 1,000-recipient broadcast and a
 * burst of ticket email each stay under the cap individually while together
 * blowing through it.
 *
 * PRIORITY. Transactional mail (someone paid and is waiting for a ticket) always
 * drains before marketing. Without this, a broadcast queued 1,000 messages ahead
 * of the buyer who just checked out and pushed their ticket minutes into the
 * future. Marketing is the load that can wait; a paid ticket is not.
 */

/** Transactional outranks marketing whenever both are waiting for a token. */
export type SendPriority = "transactional" | "marketing";

export interface RateLimiterOptions {
  /** Sustained messages per second. Keep BELOW the SES quota, not equal to it. */
  ratePerSecond: number;
  /**
   * Tokens available for an idle-start burst. Defaults to one second's worth.
   * Larger values trade a brief overshoot for lower latency on bursty traffic;
   * SES measures the rate over a sliding window, so a small burst is safe.
   */
  burst?: number;
  /**
   * Hard cap on queued waiters. Reached only if callers enqueue far faster than
   * the rate drains — at which point failing fast is the honest answer, because
   * the alternative is unbounded memory growth and messages that sit for hours.
   */
  maxQueueDepth?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. Must behave like `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class QueueOverflowError extends Error {
  readonly retryable = true;
  constructor(depth: number) {
    super(`Email send queue is full (${depth} waiting) — refusing to enqueue`);
    this.name = "QueueOverflowError";
  }
}

export class RateLimiter {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly maxQueueDepth: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  private tokens: number;
  private lastRefill: number;
  /** Two FIFOs rather than a sorted structure: priority has exactly two levels. */
  private readonly queues: Record<SendPriority, Waiter[]> = {
    transactional: [],
    marketing: [],
  };
  private pumpScheduled = false;

  constructor(opts: RateLimiterOptions) {
    if (!(opts.ratePerSecond > 0)) {
      throw new Error(`RateLimiter: ratePerSecond must be > 0, got ${opts.ratePerSecond}`);
    }
    this.ratePerSecond = opts.ratePerSecond;
    this.capacity = Math.max(1, opts.burst ?? Math.ceil(opts.ratePerSecond));
    this.maxQueueDepth = opts.maxQueueDepth ?? 10_000;
    this.now = opts.now ?? Date.now;
    // unref so a pending pump can never hold the process open at shutdown.
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        if (typeof t.unref === "function") t.unref();
      });

    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedMs = t - this.lastRefill;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs * this.ratePerSecond) / 1000);
    this.lastRefill = t;
  }

  private get waiting(): number {
    return this.queues.transactional.length + this.queues.marketing.length;
  }

  /** Next waiter, transactional first. */
  private shift(): Waiter | undefined {
    return this.queues.transactional.shift() ?? this.queues.marketing.shift();
  }

  private pump = (): void => {
    this.pumpScheduled = false;
    this.refill();

    while (this.tokens >= 1) {
      const waiter = this.shift();
      if (!waiter) return;
      this.tokens -= 1;
      waiter.resolve();
    }

    if (this.waiting > 0) this.schedulePump();
  };

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    // Time until one whole token exists. Rounded up so we never wake early and
    // spin; a wasted wake-up per message is real CPU at broadcast volume.
    const deficit = 1 - this.tokens;
    const ms = Math.max(1, Math.ceil((deficit / this.ratePerSecond) * 1000));
    this.schedule(this.pump, ms);
  }

  /**
   * Resolves when this caller may send. Rejects only on queue overflow — a
   * caller that is admitted always eventually runs.
   */
  acquire(priority: SendPriority = "transactional"): Promise<void> {
    this.refill();

    // Fast path: a free token and nobody ahead of us. The queue check matters —
    // skipping it would let a late arrival overtake a waiter that is already in
    // line, which for `transactional` means reordering paid ticket email.
    if (this.tokens >= 1 && this.waiting === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    if (this.waiting >= this.maxQueueDepth) {
      return Promise.reject(new QueueOverflowError(this.waiting));
    }

    return new Promise<void>((resolve, reject) => {
      this.queues[priority].push({ resolve, reject });
      this.schedulePump();
    });
  }

  /** Depth by priority — surfaced on /api/health so a stuck queue is visible. */
  stats(): { ratePerSecond: number; waiting: number; transactional: number; marketing: number } {
    return {
      ratePerSecond: this.ratePerSecond,
      waiting: this.waiting,
      transactional: this.queues.transactional.length,
      marketing: this.queues.marketing.length,
    };
  }
}

/**
 * Default rate. Deliberately UNDER the 14/s SES grant: the limiter shapes our
 * own traffic, but SES measures at its edge, and retries the SDK performs after
 * a throttle are not visible here. Leaving headroom keeps a burst from turning
 * into a throttle storm. Raise only in step with the quota in the SES console.
 */
export const DEFAULT_SEND_RATE = 12;

/** The rate actually in force, from env or the default. */
export function effectiveSendRate(): number {
  const configured = Number(process.env.SES_MAX_SEND_RATE);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SEND_RATE;
}

/**
 * Seconds a broadcast may spend inside one HTTP request.
 *
 * Cloudflare's default origin-response timeout is **125s** (Error 524), and
 * raising it is Enterprise-only — Cloudflare's own advice is to move
 * long-running work off the request instead. 90s leaves ~35s for rendering,
 * per-recipient suppression checks, unsubscribe-token minting and provider
 * latency variance, none of which the rate calculation covers.
 */
const INLINE_SEND_BUDGET_S = 90;

/**
 * Largest broadcast that can finish inside one HTTP request at the current rate.
 *
 * TEMPORARY. This exists only because broadcasts still send inline; the fix is
 * the background queue, and this guard goes with it. Delete both together.
 *
 * Derived rather than hardcoded on purpose, because the dangerous case is not
 * an operator raising the recipient cap — it is one LOWERING the send rate.
 * Warm-up guidance says to start SES slower than the granted 14/s, and at 5/s a
 * 1,000-recipient broadcast takes 200s and dies at the edge with the organiser
 * seeing a generic 524 and no idea how many people were mailed.
 */
export function maxInlineRecipients(): number {
  return Math.floor(INLINE_SEND_BUDGET_S * effectiveSendRate());
}

let shared: RateLimiter | null = null;

export function sendRateLimiter(): RateLimiter {
  if (!shared) shared = new RateLimiter({ ratePerSecond: effectiveSendRate() });
  return shared;
}

/** Tests only — drops the shared instance so env changes take effect. */
export function resetSendRateLimiter(): void {
  shared = null;
}
