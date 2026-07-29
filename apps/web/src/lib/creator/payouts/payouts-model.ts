/**
 * Pure shaping for the payouts screen: grouping, per-currency totals, and the
 * date labels an organiser reads as a promise about their money.
 *
 * Kept free of Svelte and of `fetch` so the arithmetic can be tested directly.
 * Two rules run through all of it:
 *
 *   1. Money is summed in INTEGER minor units and divided exactly once, at the
 *      formatting edge. Floats never touch a running total.
 *   2. An amount is shown in the currency it actually sits in. Stripe converts a
 *      charge whose currency has no matching bank account, so `settlementCurrency`
 *      wins over `currency` once it is known — the same rule the server applies
 *      when it builds `heldByCurrency`, so the tiles always equal the rows.
 */

import type { PayoutEntryView, PayoutsResponse } from "@woco/shared";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type FailureKind = "auth" | "network" | "server";

export interface PayoutsFailure {
  kind: FailureKind;
  /** What the organiser reads: what happened, and what to do about it. */
  message: string;
  /** The underlying text, for the console. Never rendered. */
  detail: string;
}

const AUTH_HINTS = ["not authenticated", "unauthorized", "unauthorised", "session", "401", "403"];
const NETWORK_HINTS = ["failed to fetch", "networkerror", "load failed", "network request failed"];

/**
 * Turn anything a failed load can produce — a thrown Error, a rejected fetch, or
 * the server's `{ ok: false, error }` string — into one of three things the
 * organiser can act on. Money screens must never render a raw stack or an
 * "unexpected token" from a non-JSON error page.
 */
export function classifyFailure(input: unknown): PayoutsFailure {
  const detail =
    input instanceof Error ? input.message
      : typeof input === "string" ? input
      : "Unknown error";
  const hay = detail.toLowerCase();

  if (AUTH_HINTS.some((h) => hay.includes(h))) {
    return { kind: "auth", detail, message: "Your session ended. Sign in again to see your payouts." };
  }
  if (NETWORK_HINTS.some((h) => hay.includes(h))) {
    return { kind: "network", detail, message: "Can't reach WoCo. Check your connection and try again." };
  }
  return { kind: "server", detail, message: "We couldn't load your payouts. Try again in a moment." };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const digitsCache = new Map<string, number>();

/**
 * Minor-unit exponent for a currency — 2 for GBP, 0 for JPY, 3 for KWD.
 * Read from Intl rather than a hand-kept list, so a currency we have never
 * seen still formats correctly. Unknown codes fall back to 2.
 */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  const hit = digitsCache.get(code);
  if (hit !== undefined) return hit;
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency: code })
        .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Not a currency Intl knows — 2 is the overwhelmingly common case.
  }
  digitsCache.set(code, digits);
  return digits;
}

/** Format integer minor units as money. The ONLY place a division happens. */
export function formatMinor(amount: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  const value = amount / 10 ** currencyDigits(code);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(value);
  } catch {
    return `${value.toFixed(currencyDigits(code))} ${code}`;
  }
}

/**
 * The currency an entry's money is in. Settlement currency wins once Stripe has
 * told us it converted the charge.
 */
export function entryCurrency(e: PayoutEntryView): string {
  return e.settlementCurrency ?? e.currency;
}

/**
 * The amount to show for one sale: the resolved net where we have it, gross
 * until the sweep reads the balance transaction. Always integer minor units.
 */
export function entryAmount(e: PayoutEntryView): number {
  return e.netAmount ?? e.grossAmount;
}

/** True when the buyer was charged in one currency and paid out in another. */
export function isConverted(e: PayoutEntryView): boolean {
  return !!e.settlementCurrency && e.settlementCurrency !== e.currency;
}

/** Integer sum per currency. Never divides. */
export function sumByCurrency(entries: PayoutEntryView[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const cur = entryCurrency(e);
    out[cur] = (out[cur] ?? 0) + entryAmount(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface PayoutGroup {
  /** Stable identity for keyed rendering: "event:{id}" · "shop:{id}" · "other". */
  key: string;
  kind: "event" | "shop" | "other";
  id: string | null;
  title: string;
  /** Newest sale first. */
  entries: PayoutEntryView[];
  heldByCurrency: Record<string, number>;
  releasedByCurrency: Record<string, number>;
  /** Soonest release among the held sales, or null when nothing is held. */
  nextReleaseAt: string | null;
  /** Any sale released early against Stripe's hold ceiling. */
  hasForcedRelease: boolean;
}

/** Resolve a display title for a group. Returning undefined falls back to the id. */
export type TitleLookup = (kind: "event" | "shop", id: string) => string | undefined;

function groupKeyOf(e: PayoutEntryView): { key: string; kind: PayoutGroup["kind"]; id: string | null } {
  if (e.kind === "event" && e.eventId) return { key: `event:${e.eventId}`, kind: "event", id: e.eventId };
  if (e.kind === "shop" && e.shopId) return { key: `shop:${e.shopId}`, kind: "shop", id: e.shopId };
  return { key: "other", kind: "other", id: null };
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * One group per event (shop orders group under their shop), ordered by what the
 * organiser wants to know first: the money arriving soonest. Groups with nothing
 * held fall to the bottom, most recent sale first — they are history, not a plan.
 */
export function groupPayouts(entries: PayoutEntryView[], titleOf?: TitleLookup): PayoutGroup[] {
  const groups = new Map<string, PayoutGroup>();

  for (const e of entries) {
    const { key, kind, id } = groupKeyOf(e);
    let g = groups.get(key);
    if (!g) {
      const looked = titleOf && kind !== "other" && id ? titleOf(kind, id) : undefined;
      g = {
        key,
        kind,
        id,
        title:
          looked ??
          (kind === "event" && id ? `Event ${shortId(id)}`
            : kind === "shop" && id ? `Shop ${shortId(id)}`
            : "Other sales"),
        entries: [],
        heldByCurrency: {},
        releasedByCurrency: {},
        nextReleaseAt: null,
        hasForcedRelease: false,
      };
      groups.set(key, g);
    }
    g.entries.push(e);
    if (e.forcedByCeiling) g.hasForcedRelease = true;
    if (e.status === "held" && (g.nextReleaseAt === null || e.releaseAfter < g.nextReleaseAt)) {
      g.nextReleaseAt = e.releaseAfter;
    }
  }

  for (const g of groups.values()) {
    g.entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    g.heldByCurrency = sumByCurrency(g.entries.filter((e) => e.status === "held"));
    g.releasedByCurrency = sumByCurrency(g.entries.filter((e) => e.status === "released"));
  }

  return [...groups.values()].sort((a, b) => {
    if (a.nextReleaseAt && b.nextReleaseAt) return a.nextReleaseAt.localeCompare(b.nextReleaseAt);
    if (a.nextReleaseAt) return -1;
    if (b.nextReleaseAt) return 1;
    const aLatest = a.entries[0]?.recordedAt ?? "";
    const bLatest = b.entries[0]?.recordedAt ?? "";
    return bLatest.localeCompare(aLatest);
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface PayoutSummary {
  heldByCurrency: Record<string, number>;
  releasedByCurrency: Record<string, number>;
  nextReleaseAt: string | null;
  /**
   * True while any held sale's net is unresolved — a refund can still change it,
   * so the held total is labelled an estimate rather than stated as fact.
   */
  heldIsEstimate: boolean;
  heldCount: number;
  releasedCount: number;
  /** Sales that converted currency — drives the settlement-currency note. */
  convertedCount: number;
}

export function summarisePayouts(res: PayoutsResponse): PayoutSummary {
  const entries = res.entries;
  const held = entries.filter((e) => e.status === "held");
  const released = entries.filter((e) => e.status === "released");
  return {
    // Server-computed: it is the authority on what is still held.
    heldByCurrency: res.heldByCurrency,
    releasedByCurrency: sumByCurrency(released),
    nextReleaseAt: res.nextReleaseAt,
    heldIsEstimate: held.some((e) => !e.netIsFinal),
    heldCount: held.length,
    releasedCount: released.length,
    convertedCount: entries.filter(isConverted).length,
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Whole days from `now` to `iso`, counted in the VIEWER'S calendar days. UTC
 * arithmetic here would tell an organiser in Auckland "today" for money that
 * lands after their midnight — the countdown must agree with the wall clock
 * they will check it against (and with `formatDate`, which renders local).
 */
export function daysUntil(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const target = new Date(t);
  target.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // Round, not floor: a DST shift makes one day 23 or 25 hours long.
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/** "12 Aug" — short, and only shows the year when it isn't this one. */
export function formatDate(iso: string, now: number, locale?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * When money arrives, said the way a person asks it. Past dates read as
 * "overdue" rather than a negative countdown: the release sweep runs hourly, so
 * a date that has passed means a payout is in flight, not that we lost track.
 */
export function releaseCountdown(iso: string, now: number, locale?: string): string {
  const days = daysUntil(iso, now);
  if (days === null) return "—";
  if (days < 0) return "releasing now";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return `on ${formatDate(iso, now, locale)}`;
}

export type PayoutTone = "held" | "released" | "void";

export interface EntryStatusLabel {
  tone: PayoutTone;
  /** Short state word for the badge. */
  badge: string;
  /** The full sentence for the row: when it lands, or when it landed. */
  detail: string;
}

/** The status line for one sale. */
export function entryStatusLabel(e: PayoutEntryView, now: number, locale?: string): EntryStatusLabel {
  if (e.status === "void") {
    return {
      tone: "void",
      badge: "Refunded",
      // voidReason is our own short string ("full refund", "claim failed") —
      // shown verbatim so the organiser sees the actual reason, not a guess.
      detail: e.voidReason ?? "Returned to the buyer — nothing to pay out",
    };
  }
  if (e.status === "released") {
    const when = e.releasedAt ? formatDate(e.releasedAt, now, locale) : formatDate(e.releaseAfter, now, locale);
    return {
      tone: "released",
      badge: "Paid out",
      detail: e.forcedByCeiling ? `Released early on ${when}` : `Released on ${when}`,
    };
  }
  return {
    tone: "held",
    badge: "Held",
    detail: `Releases ${releaseCountdown(e.releaseAfter, now, locale)}`,
  };
}
