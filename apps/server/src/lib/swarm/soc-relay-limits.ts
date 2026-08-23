/**
 * Rate limits for the client-SOC relay (`POST /api/swarm/soc`, `/bytes`) — #301.
 *
 * The relay's own authorisation note says abuse is bounded by auth, the
 * signature check and postage cost. That held while every writer was
 * publish-shaped (an event, a profile, a site). Likes, follows and coaster
 * credits now write through the same relay, one tap each, so it is reachable in
 * a tight loop from any free account — and every chunk it stamps comes off the
 * platform postage batch that also carries recovery envelopes, tickets,
 * profiles and site pointers. Capacity exhaustion there is not a social-feature
 * outage.
 *
 * Keys, in order of how binding they are:
 *  - the verified PARENT — the one identity an account cannot vary per request.
 *    The SOC owner is NOT usable as a key: the relay cannot bind owner==parent
 *    (a recovery envelope's owner is a guardian-derived key), and an owner key is
 *    free to mint per request.
 *  - a tighter parent bucket for STATEMENT-shaped payloads (like/follow/credit
 *    and their subject indexes), classified from the payload's own `format` —
 *    a public statement names its format by design. A writer that hides the
 *    format just lands in the general bucket, which is still bounded.
 *  - the client IP, looser, because a venue NAT is one IP and the lap rail is
 *    venue-shaped.
 *  - a GLOBAL ceiling. During an attack it converts "the batch dies for
 *    everyone, for a fortnight" into "writes 503 for a minute", and trips a
 *    health alarm. Sized far above legitimate traffic.
 *
 * Numbers are sized for human cadence, not per-request cost: a site publish
 * legitimately writes a few dozen chunks in seconds; nobody legitimately does
 * that for an hour.
 */

import {
  LIKE_STATEMENT_FORMAT,
  FOLLOW_STATEMENT_FORMAT,
  CREDIT_STATEMENT_FORMAT,
  LIKE_SUBJECT_INDEX_FORMAT,
  FOLLOW_SUBJECT_INDEX_FORMAT,
  CREDIT_SUBJECT_INDEX_FORMAT,
} from "@woco/shared";
import { SlidingWindowLimiter, type RateWindow } from "../http/rate-limit.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Payload formats that a one-tap UI writes — the loopable ones. */
const STATEMENT_FORMATS: ReadonlySet<string> = new Set([
  LIKE_STATEMENT_FORMAT,
  FOLLOW_STATEMENT_FORMAT,
  CREDIT_STATEMENT_FORMAT,
  LIKE_SUBJECT_INDEX_FORMAT,
  FOLLOW_SUBJECT_INDEX_FORMAT,
  CREDIT_SUBJECT_INDEX_FORMAT,
]);

export type RelayPayloadKind = "statement" | "other";

/**
 * Which bucket a SOC payload belongs in. Never throws: anything that is not
 * JSON with a known statement `format` is "other". A sealed envelope is
 * ordinary JSON with no `format` and lands there too.
 */
export function classifyRelayPayload(payloadHex: string): RelayPayloadKind {
  try {
    const clean = payloadHex.startsWith("0x") ? payloadHex.slice(2) : payloadHex;
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return "other";
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return "other";
    const format = (parsed as { format?: unknown }).format;
    return typeof format === "string" && STATEMENT_FORMATS.has(format) ? "statement" : "other";
  } catch {
    return "other";
  }
}

export type RelayBucket = "parent" | "statement" | "ip" | "global";

export type RelayDecision =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; bucket: RelayBucket; reason: string };

export interface RelayLimits {
  parent: RateWindow[];
  statement: RateWindow[];
  ip: RateWindow[];
  global: RateWindow[];
}

/** `POST /api/swarm/soc` — one 4 KB chunk per call. */
export const SOC_RELAY_LIMITS: RelayLimits = {
  parent: [{ limit: 60, windowMs: MIN }, { limit: 500, windowMs: HOUR }],
  statement: [{ limit: 30, windowMs: MIN }, { limit: 300, windowMs: HOUR }],
  ip: [{ limit: 300, windowMs: MIN }, { limit: 3000, windowMs: HOUR }],
  global: [{ limit: 1500, windowMs: MIN }],
};

/** `POST /api/swarm/bytes` — up to 16 chunks per call (64 KB), so tighter. No
 *  in-repo client calls it today; any traffic is already unusual. */
export const BYTES_RELAY_LIMITS: RelayLimits = {
  parent: [{ limit: 20, windowMs: MIN }, { limit: 150, windowMs: HOUR }],
  statement: [{ limit: 20, windowMs: MIN }, { limit: 150, windowMs: HOUR }], // unused: /bytes is not classified
  ip: [{ limit: 100, windowMs: MIN }, { limit: 800, windowMs: HOUR }],
  global: [{ limit: 200, windowMs: MIN }],
};

const REASON_CALLER = "Too many writes — slow down.";
const REASON_GLOBAL = "The write relay is busy — try again shortly.";

/** Counters for /api/health — cumulative since boot. */
export interface RelayHealth {
  refusals: Record<RelayBucket, number>;
  lastRefusalAt: number | null;
  /** The alarm: the GLOBAL ceiling tripped. Legitimate traffic never reaches it. */
  globalTrippedAt: number | null;
}

export class RelayGate {
  private readonly parent: SlidingWindowLimiter;
  private readonly statement: SlidingWindowLimiter;
  private readonly ip: SlidingWindowLimiter;
  private readonly global: SlidingWindowLimiter;
  private readonly refusals: Record<RelayBucket, number> = { parent: 0, statement: 0, ip: 0, global: 0 };
  private lastRefusalAt: number | null = null;
  private globalTrippedAt: number | null = null;
  private lastGlobalWarnAt = 0;

  constructor(private readonly name: string, limits: RelayLimits) {
    this.parent = new SlidingWindowLimiter(limits.parent);
    this.statement = new SlidingWindowLimiter(limits.statement);
    this.ip = new SlidingWindowLimiter(limits.ip);
    this.global = new SlidingWindowLimiter(limits.global);
  }

  /**
   * Check every applicable bucket, then charge every applicable bucket — a
   * request refused on its second bucket is not charged to its first, and a
   * refused request is never recorded (refusals cannot extend a lockout).
   */
  decide(args: { parent: string; ip: string; kind: RelayPayloadKind; now?: number }): RelayDecision {
    const now = args.now ?? Date.now();
    const pk = `p:${args.parent.toLowerCase()}`;
    const ik = `ip:${args.ip}`;
    const statement = args.kind === "statement";

    if (!this.global.peek("all", now)) return this.refuse("global", 503, REASON_GLOBAL, now);
    if (!this.ip.peek(ik, now)) return this.refuse("ip", 429, REASON_CALLER, now);
    if (!this.parent.peek(pk, now)) return this.refuse("parent", 429, REASON_CALLER, now);
    if (statement && !this.statement.peek(pk, now)) return this.refuse("statement", 429, REASON_CALLER, now);

    this.global.record("all", now);
    this.ip.record(ik, now);
    this.parent.record(pk, now);
    if (statement) this.statement.record(pk, now);
    return { allowed: true };
  }

  health(): RelayHealth {
    return {
      refusals: { ...this.refusals },
      lastRefusalAt: this.lastRefusalAt,
      globalTrippedAt: this.globalTrippedAt,
    };
  }

  private refuse(bucket: RelayBucket, status: 429 | 503, reason: string, now: number): RelayDecision {
    this.refusals[bucket]++;
    this.lastRefusalAt = now;
    if (bucket === "global") {
      this.globalTrippedAt = now;
      // Once a minute, not once a request: the ceiling trips under a flood.
      if (now - this.lastGlobalWarnAt >= MIN) {
        this.lastGlobalWarnAt = now;
        console.warn(`[swarm] ${this.name} relay GLOBAL ceiling tripped — refusing with 503 (#301)`);
      }
    }
    return { allowed: false, status, bucket, reason };
  }
}

export const socRelayGate = new RelayGate("soc", SOC_RELAY_LIMITS);
export const bytesRelayGate = new RelayGate("bytes", BYTES_RELAY_LIMITS);

/** For /api/health. */
export function socRelayHealth(): { soc: RelayHealth; bytes: RelayHealth } {
  return { soc: socRelayGate.health(), bytes: bytesRelayGate.health() };
}

/** Request-body caps for the two routes (see routes/swarm.ts for the arithmetic). */
export const SOC_RELAY_MAX_BODY_BYTES = 16 * 1024;
export const BYTES_RELAY_MAX_BODY_BYTES = 128 * 1024;
