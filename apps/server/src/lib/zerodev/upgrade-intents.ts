/**
 * Permission for ONE sponsored upgrade op of a LOCKED account (#746): an email
 * account handing itself to its new passkey. The account's own signed session asks
 * for it (routes/upgrade-intent.ts) just before the op is sent, because ZeroDev's
 * servers call the sponsorship webhook and it never sees the person's IP - this
 * request is where a per-IP limit can stand. The policy spends one intent per new
 * op (lib/zerodev/sponsor-policy.ts); the stub and final request of that op, and
 * a retry at the same nonce, ride on it.
 *
 * In memory, on purpose: an intent lives minutes, and the client asks for a fresh
 * one at every attempt, so a restart costs one request and nothing else.
 */

import { SlidingWindowLimiter } from "../http/rate-limit.js";

/** One attempt: asked just before the retraction and the op, so 30 minutes covers
 *  both and never a second attempt (the client asks afresh for that). */
export const UPGRADE_INTENT_TTL_MS = 30 * 60_000;

/**
 * Per network, per day. A bad-actor limit, not a ration (owner 10-08): one machine
 * cannot farm free Google accounts into more than this, while a household or a venue
 * where several people upgrade on one connection is not turned away. A shared egress
 * (Apple Private Relay, carrier NAT) can still meet it - `refusedByNetwork24h` in
 * `/api/health` says when it does.
 */
export const UPGRADE_INTENTS_PER_IP = 10;

const MAX_OPEN = 10_000;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** How many things happened in the last 24 h, in per-minute buckets (bounded memory). */
export class RollingDayCount {
  private readonly buckets = new Map<number, number>();

  record(now = Date.now()): void {
    const m = Math.floor(now / MINUTE_MS);
    this.buckets.set(m, (this.buckets.get(m) ?? 0) + 1);
    this.prune(now);
  }

  count(now = Date.now()): number {
    this.prune(now);
    let n = 0;
    for (const v of this.buckets.values()) n += v;
    return n;
  }

  private prune(now: number): void {
    const oldest = Math.floor((now - DAY_MS) / MINUTE_MS);
    for (const m of this.buckets.keys()) if (m <= oldest) this.buckets.delete(m);
  }
}

export class UpgradeIntents {
  private readonly open = new Map<string, number>();
  private readonly perIp = new SlidingWindowLimiter([{ limit: UPGRADE_INTENTS_PER_IP, windowMs: DAY_MS }]);
  private readonly granted = new RollingDayCount();
  private readonly refused = new RollingDayCount();

  /** Grant `account` one intent, charged to `ip`; false when that network has had its share today. */
  grant(account: string, ip: string, now = Date.now()): boolean {
    if (!this.perIp.peek(ip, now)) {
      this.refused.record(now);
      return false;
    }
    this.perIp.record(ip, now);
    this.granted.record(now);
    this.open.delete(account.toLowerCase());
    this.open.set(account.toLowerCase(), now + UPGRADE_INTENT_TTL_MS);
    while (this.open.size > MAX_OPEN) this.open.delete(this.open.keys().next().value as string);
    return true;
  }

  /**
   * Spend `account`'s intent: true when it held an unexpired one, which is now gone.
   * One call, so "had one" and "spent it" can never be split by anything awaited
   * between them (Fable delta sign-off).
   */
  spend(account: string, now = Date.now()): boolean {
    const key = account.toLowerCase();
    const until = this.open.get(key);
    this.open.delete(key);
    return until !== undefined && until > now;
  }

  /** For `/api/health`: what the per-network limit is doing. */
  stats(now = Date.now()): { granted24h: number; refusedByNetwork24h: number } {
    return { granted24h: this.granted.count(now), refusedByNetwork24h: this.refused.count(now) };
  }
}

export const upgradeIntents = new UpgradeIntents();
