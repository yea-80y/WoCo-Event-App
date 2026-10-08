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

/** Long enough for a passkey ceremony, a backup removal and the op itself. */
export const UPGRADE_INTENT_TTL_MS = 30 * 60_000;

/**
 * Per network, per day. A bad-actor limit, not a ration (owner 10-08): one machine
 * cannot farm free Google accounts into more than this, while a household or a venue
 * where several people upgrade on one connection is not turned away.
 */
export const UPGRADE_INTENTS_PER_IP = 10;

const MAX_OPEN = 10_000;

export class UpgradeIntents {
  private readonly open = new Map<string, number>();
  private readonly perIp = new SlidingWindowLimiter([{ limit: UPGRADE_INTENTS_PER_IP, windowMs: 24 * 60 * 60_000 }]);

  /** Grant `account` one intent, charged to `ip`; false when that network has had its share today. */
  grant(account: string, ip: string, now = Date.now()): boolean {
    if (!this.perIp.peek(ip, now)) return false;
    this.perIp.record(ip, now);
    this.open.delete(account.toLowerCase());
    this.open.set(account.toLowerCase(), now + UPGRADE_INTENT_TTL_MS);
    while (this.open.size > MAX_OPEN) this.open.delete(this.open.keys().next().value as string);
    return true;
  }

  /** An unexpired intent for `account`? */
  has(account: string, now = Date.now()): boolean {
    const until = this.open.get(account.toLowerCase());
    return until !== undefined && until > now;
  }

  /** Spent by the op it paid for. */
  consume(account: string): void {
    this.open.delete(account.toLowerCase());
  }
}

export const upgradeIntents = new UpgradeIntents();
