/**
 * Held tickets (#983): each emailed ticket's QR, sealed at fulfilment to the
 * organiser's order key, so a ticket whose email never arrives can be sent again -
 * the same ticket, with no refund and no new mint. The QR exists nowhere else: the
 * key that signed it is discarded at mint, and this server keeps only boxes it
 * cannot open.
 *
 *   .data/ticket-holds/{sessionId}.json
 *     { v: 1, sessionId, eventId, seriesId, orderKeyRef, sealedAt, tickets: [{ edition, qrHash, box }] }
 *
 * `qrHash` is sha256 of the QR as emailed: a resend must carry exactly those bytes,
 * which the server can check without reading the box or asking the chain. It says
 * nothing about the QR (the signature in it is 65 random-looking bytes).
 *
 * One write-once file per sale. Sealed to the organiser's AUTHORITATIVE order key -
 * the one sales seal to (`sellableKeys`) - never a key the event feed names: the feed
 * is client-signed. A copy sealed before a key rotation still opens, because the
 * ring's back blob gives the current holder every earlier generation's key;
 * `orderKeyRef` records which one, and nothing is ever re-sealed.
 *
 * Deleted with the event's door copies 2 days after its onchain end
 * (`roster-retention.ts`), and with the order on erasure (`erase.ts`). Present but
 * unreadable: never overwritten, and `/api/health` `email.ticketHolds` is red until
 * an operator restores it.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { CHECKOUT_SESSION_RE, type TicketHoldPlaintext } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { errorClass } from "../http/error-class.js";

const DIR = join(process.cwd(), ".data", "ticket-holds");
const TAG = "ticket-holds";
/** The file name, so nothing but a Checkout Session id may reach the path. */
const SESSION_RE = CHECKOUT_SESSION_RE;
const REF_RE = /^[0-9a-f]{64}$/;

export interface TicketHold {
  v: 1;
  sessionId: string;
  eventId: string;
  seriesId: string;
  /** The order key the boxes are sealed to. */
  orderKeyRef: string;
  sealedAt: string;
  tickets: Array<{ edition: number; qrHash: string; box: SealedBoxV2 }>;
}

/** sha256 of a QR as emailed, hex - what a resend must match. */
export function ticketQrHash(qrContent: string): string {
  return createHash("sha256").update(qrContent, "utf8").digest("hex");
}

export interface HoldTicketsInput {
  sessionId: string;
  eventId: string;
  seriesId: string;
  orderKeyRef: string;
  tickets: Array<{ edition: number; qrContent: string }>;
}

export class TicketHoldUnreadableError extends Error {
  constructor() {
    super("a held ticket copy is present but unreadable");
    this.name = "TicketHoldUnreadableError";
  }
}

const cache = new Map<string, TicketHold>();
/** Copies kept in memory: the oldest goes first. Disk is the store. */
const CACHE_MAX = 1000;
function remember(sessionId: string, hold: TicketHold): void {
  if (!cache.has(sessionId) && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(sessionId, hold);
}
const unreadable = new Set<string>();
const health = { held: 0, failed: 0, lastError: null as string | null };

const fileOf = (sessionId: string) => join(DIR, `${sessionId}.json`);

function isTicketHold(x: unknown, sessionId: string): x is TicketHold {
  const h = x as Partial<TicketHold> | null;
  return (
    !!h && h.v === 1 && h.sessionId === sessionId && typeof h.eventId === "string" && typeof h.seriesId === "string" &&
    typeof h.orderKeyRef === "string" && Array.isArray(h.tickets) &&
    h.tickets.every((t) => Number.isInteger(t?.edition) && t.edition >= 1 && /^[0-9a-f]{64}$/.test(t.qrHash) && !!t.box)
  );
}

/** The sale's copy, or null when it has none. Throws when it is present but unreadable. */
export function getTicketHold(sessionId: string): TicketHold | null {
  if (!SESSION_RE.test(sessionId)) return null;
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const hold = readHold(sessionId);
  if (hold) remember(sessionId, hold);
  return hold;
}

/** From disk, never cached: the sweep reads every file and must not keep them all in memory. */
function readHold(sessionId: string): TicketHold | null {
  let raw: string;
  try {
    raw = readFileSync(fileOf(sessionId), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      unreadable.delete(sessionId);
      return null;
    }
    unreadable.add(sessionId);
    throw new TicketHoldUnreadableError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isTicketHold(parsed, sessionId)) {
    unreadable.add(sessionId);
    throw new TicketHoldUnreadableError();
  }
  unreadable.delete(sessionId);
  return parsed;
}

/**
 * Seal one sale's tickets for its organiser, before their email goes. Never throws -
 * the copy is the remedy for a bounce, never the sale. Write-once: a sale that already
 * has a copy (a retried webhook) keeps it, and an unreadable one is left for an operator.
 *
 * @returns whether this sale now has a readable copy.
 */
export async function holdTickets(
  input: HoldTicketsInput,
  fetchOrderKey: (ref: string) => Promise<Uint8Array>,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    if (!SESSION_RE.test(input.sessionId) || !REF_RE.test(input.orderKeyRef) || input.tickets.length === 0) {
      throw new Error("malformed hold input");
    }
    if (getTicketHold(input.sessionId)) return true;
    const key = await fetchOrderKey(input.orderKeyRef);
    const { sealBoxJson, ticketHoldSealContext } = await import("@woco/shared/crypto/sealed-box");
    const tickets: TicketHold["tickets"] = [];
    for (const t of input.tickets) {
      const plain: TicketHoldPlaintext = { v: 1, sessionId: input.sessionId, seriesId: input.seriesId, edition: t.edition, qrContent: t.qrContent };
      const ctx = ticketHoldSealContext(input.eventId, input.seriesId, t.edition, input.sessionId);
      tickets.push({ edition: t.edition, qrHash: ticketQrHash(t.qrContent), box: await sealBoxJson(key, plain, ctx) });
    }
    // Read again after the awaits: another write of this sale wins, never two.
    if (getTicketHold(input.sessionId)) return true;
    const hold: TicketHold = {
      v: 1,
      sessionId: input.sessionId,
      eventId: input.eventId,
      seriesId: input.seriesId,
      orderKeyRef: input.orderKeyRef,
      sealedAt: new Date(now).toISOString(),
      tickets,
    };
    if (!writeJsonAtomic(fileOf(input.sessionId), hold, TAG)) throw new Error("held tickets could not be persisted");
    remember(input.sessionId, hold);
    health.held += tickets.length;
    return true;
  } catch (err) {
    health.failed++;
    health.lastError = `hold failed (${errorClass(err)})`;
    console.error("[ticket-hold] tickets could not be held for their organiser (the sale stands):", errorClass(err));
    return false;
  }
}

/** Delete one sale's copy and any half-written one beside it. Already gone is not a failure. */
export function deleteTicketHold(sessionId: string): void {
  if (!SESSION_RE.test(sessionId)) return;
  for (const file of [fileOf(sessionId), `${fileOf(sessionId)}.tmp`]) {
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  cache.delete(sessionId);
  unreadable.delete(sessionId);
}

/**
 * Every readable copy's sale, by event - what the retention sweep deletes from. An
 * unreadable copy names no event, so it stays (and alarms) until it is restored.
 */
export function ticketHoldsByEvent(): Map<string, string[]> {
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const out = new Map<string, string[]>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -5);
    if (!SESSION_RE.test(sessionId)) continue;
    let hold: TicketHold | null;
    try {
      hold = cache.get(sessionId) ?? readHold(sessionId);
    } catch {
      continue;
    }
    if (!hold) continue;
    out.set(hold.eventId, [...(out.get(hold.eventId) ?? []), sessionId]);
  }
  return out;
}

/** Forget what memory holds, as a restart would: the next read goes to disk. */
export function _dropTicketHoldCacheForTests(): void {
  cache.clear();
}

export function _ticketHoldCacheSizeForTests(): number {
  return cache.size;
}

/** `/api/health`: red while a copy is present but unreadable. Counts since boot. */
export function ticketHoldsHealth() {
  return { ok: unreadable.size === 0, unreadable: unreadable.size, ...health };
}
