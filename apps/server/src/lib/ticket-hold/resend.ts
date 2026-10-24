/**
 * Undelivered tickets, from the organiser's side (#983).
 *
 * A ticket whose email bounced is held: fulfilment sealed its QR to the organiser's
 * order key (`store.ts`). The buyer gets in touch, the organiser checks them against
 * the order, and resends the SAME ticket to the address the buyer gives - no refund,
 * no new mint. Three steps, each behind one gate:
 *
 *   list   - the event's sales with an unresolved undelivered-ticket row
 *   copy   - one sale's sealed copy, for the organiser's client to open
 *   resend - the opened tickets back, to email to the corrected address
 *
 * THE GATE is what keeps the organiser from opening every live ticket's QR: a copy is
 * served, and a resend accepted, only while that sale has an unresolved row in the
 * undelivered ledger (written by the mailer or the bounce webhook, never by a
 * client), and only for a sale that still holds valid tickets of a running event. The
 * organiser is the event's creator on the server's own write-once record, never the
 * client-signed feed's `creatorAddress`.
 *
 * A resend must carry exactly the tickets emailed: every held edition, each QR's
 * sha256 equal to the one kept at the sale. With the signing key discarded at mint,
 * nothing else can be a valid ticket for that seat, so no chain read is needed - and
 * a re-encoded signature, which the chain would accept, is refused.
 *
 * The server sees the QR in plaintext once more, to render and send it; it is never
 * persisted or logged here. What is recorded: the row resolved (with the address it
 * went to, so access and erasure reach it), the resend on the sale (hash only), the
 * door list's line, and the attendee index.
 */

import { MAILABLE_EMAIL_RE, ticketQrNamesSeat, type EventFeed } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { EmailFailure, FailureRecipient } from "../email/failure-ledger.js";
import type { EventKeys } from "../keyring/event-keys.js";
import type { TicketSale } from "../stripe/ticket-sales.js";
import type { TicketEmailOpts } from "../../routes/tickets.js";
import { SlidingWindowLimiter } from "../http/rate-limit.js";
import { errorClass } from "../http/error-class.js";
import { ticketQrHash, TicketHoldUnreadableError, type TicketHold } from "./store.js";

/** Resends a sale may have, ever. Each is an email to an address the organiser typed. */
export const RESENDS_PER_SALE = 3;

/**
 * Bounces that were about the message, not the mailbox: the same email fails again,
 * so the resend goes without attachments (its body still links every ticket).
 */
const LINK_ONLY_CODES = new Set([
  "Bounce/Transient/MessageTooLarge",
  "Bounce/Transient/ContentRejected",
  "Bounce/Transient/AttachmentRejected",
  "Reject",
]);

export interface ResendDeps {
  eventKeys(eventId: string): Promise<EventKeys>;
  getSale(sessionId: string): TicketSale | undefined;
  isSaleVoid(sale: TicketSale): boolean;
  unresolvedTicketFailures(eventId: string, sessionId?: string): EmailFailure[];
  cancellationGate(eventId: string): "open" | "cancelled" | "unknown";
  /** The series' onchain end, or null when it cannot be read (the resend then goes ahead). */
  eventEndMs(eventId: string, seriesId: string, onChainEventId: string): Promise<number | null>;
  /** Throws `TicketHoldUnreadableError` for a copy present but unreadable. */
  getTicketHold(sessionId: string): TicketHold | null;
  hashEmail(email: string): string;
  isGloballySuppressed(emailHash: string): boolean;
  /** Display fields for the email; null keeps the defaults. */
  getEvent(eventId: string): Promise<EventFeed | null>;
  sendTicketEmail(opts: TicketEmailOpts): Promise<void>;
  recordResend(sessionId: string, entry: NonNullable<TicketSale["resends"]>[number]): boolean;
  resolveTicketFailure(id: string, by: string, sentTo: FailureRecipient): boolean;
  replaceDoorEntries(eventId: string, tickets: Array<{ seriesId: string; edition: number }>, who: { email?: string }): Promise<unknown>;
  recordAttendeeEmail(eventId: string, emailHash: string, at: string): void;
  now(): number;
}

export type Refusal = { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502 | 503; error: string; code: string };
const refuse = (status: Refusal["status"], code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** Per organiser, across every sale: a resend is typed by a person, one buyer at a time. */
const organiserLimiter = () =>
  new SlidingWindowLimiter([
    { limit: 10, windowMs: 60 * 60 * 1000 },
    { limit: 30, windowMs: 24 * 60 * 60 * 1000 },
  ]);
let perOrganiser = organiserLimiter();

export function _resetResendLimiterForTests(): void {
  perOrganiser = organiserLimiter();
}

async function organiserOf(deps: ResendDeps, eventId: string, parent: string): Promise<Refusal | null> {
  const keys = await deps.eventKeys(eventId);
  // No record = no authoritative order key, so nothing was ever held to resend.
  if (keys.kind === "legacy") return refuse(404, "NO_HELD_COPY", "This event has no held tickets.");
  if (keys.creator !== parent.toLowerCase()) return refuse(403, "NOT_ORGANISER", "Only the event's organiser can do this.");
  return null;
}

interface Opened {
  ok: true;
  sale: TicketSale;
  row: EmailFailure;
  hold: TicketHold;
}

/** Everything the copy and the resend both require. The caller has checked the organiser. */
async function gate(deps: ResendDeps, eventId: string, sessionId: string): Promise<Opened | Refusal> {
  const sale = deps.getSale(sessionId);
  if (!sale || sale.eventId !== eventId) return refuse(404, "NO_UNDELIVERED", "No undelivered ticket for this order.");
  const [row] = deps.unresolvedTicketFailures(eventId, sessionId);
  if (!row) return refuse(404, "NO_UNDELIVERED", "No undelivered ticket for this order.");
  if (deps.isSaleVoid(sale)) return refuse(409, "SALE_VOID", "This order was refunded or charged back - its tickets are void.");
  const cancelled = deps.cancellationGate(eventId);
  if (cancelled === "cancelled") return refuse(409, "EVENT_CANCELLED", "This event is cancelled.");
  if (cancelled === "unknown") return refuse(503, "CANCELLATIONS_UNREADABLE", "Can't check this event right now - try again shortly.");
  if (sale.seriesId && sale.onChainEventId) {
    const endMs = await deps.eventEndMs(eventId, sale.seriesId, sale.onChainEventId);
    if (endMs !== null && deps.now() > endMs) return refuse(409, "EVENT_ENDED", "This event has ended.");
  }
  let hold: TicketHold | null;
  try {
    hold = deps.getTicketHold(sessionId);
  } catch (err) {
    if (err instanceof TicketHoldUnreadableError) return refuse(503, "COPY_UNREADABLE", "This order's held tickets can't be read right now.");
    throw err;
  }
  if (!hold || hold.eventId !== eventId) {
    return refuse(404, "NO_HELD_COPY", "There is no held copy of these tickets to resend.");
  }
  return { ok: true, sale, row, hold };
}

export interface UndeliveredRow {
  sessionId: string;
  failedAt: string;
  /** e.g. `Bounce/Permanent/General`, `Bounce/Transient/MailboxFull`. */
  reason: string;
  /** What the buyer typed at checkout - the organiser checks the buyer against it. */
  typedAddress: string | null;
  editions: number[];
  resendsLeft: number;
  /** Why it cannot be resent here, when it cannot. */
  blocked: string | null;
}

/** The event's sales whose tickets did not arrive, newest first. */
export async function listUndelivered(deps: ResendDeps, eventId: string, parent: string): Promise<{ ok: true; data: UndeliveredRow[] } | Refusal> {
  const who = await organiserOf(deps, eventId, parent);
  if (who) return who;
  const seen = new Set<string>();
  const rows: UndeliveredRow[] = [];
  for (const row of deps.unresolvedTicketFailures(eventId)) {
    const sessionId = row.context!.stripeSessionId!;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const g = await gate(deps, eventId, sessionId);
    const sale = deps.getSale(sessionId);
    rows.push({
      sessionId,
      failedAt: row.ts,
      reason: row.code ?? "undelivered",
      typedAddress: row.recipients.find((r) => r.address)?.address ?? null,
      editions: g.ok ? g.hold.tickets.map((t) => t.edition) : (sale?.slots ?? []).map((s) => s + 1),
      resendsLeft: Math.max(0, RESENDS_PER_SALE - (sale?.resends?.length ?? 0)),
      blocked: g.ok ? null : g.code,
    });
  }
  return { ok: true, data: rows };
}

export interface HeldCopy {
  eventId: string;
  seriesId: string;
  orderKeyRef: string;
  tickets: Array<{ edition: number; box: SealedBoxV2 }>;
}

/** One sale's sealed tickets, for its organiser's client to open. */
export async function heldCopy(deps: ResendDeps, eventId: string, sessionId: string, parent: string): Promise<{ ok: true; data: HeldCopy } | Refusal> {
  const who = await organiserOf(deps, eventId, parent);
  if (who) return who;
  const g = await gate(deps, eventId, sessionId);
  if (!g.ok) return g;
  return {
    ok: true,
    data: {
      eventId,
      seriesId: g.hold.seriesId,
      orderKeyRef: g.hold.orderKeyRef,
      tickets: g.hold.tickets.map(({ edition, box }) => ({ edition, box })),
    },
  };
}

export interface ResendBody {
  to: unknown;
  tickets: unknown;
}

/** Send a sale's held tickets to the address its buyer gave the organiser. */
export async function resendTickets(
  deps: ResendDeps,
  eventId: string,
  sessionId: string,
  parent: string,
  body: ResendBody,
): Promise<{ ok: true; data: { sentTo: string; resendsLeft: number } } | Refusal> {
  const who = await organiserOf(deps, eventId, parent);
  if (who) return who;
  const g = await gate(deps, eventId, sessionId);
  if (!g.ok) return g;
  const { sale, row, hold } = g;

  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (to.length > 254 || !MAILABLE_EMAIL_RE.test(to)) return refuse(400, "BAD_ADDRESS", "Enter the buyer's email address.");
  const toHash = deps.hashEmail(to);
  if (deps.isGloballySuppressed(toHash)) {
    return refuse(409, "ADDRESS_SUPPRESSED", "That address has bounced or complained before. Ask the buyer for another one.");
  }

  const tickets = parseTickets(body.tickets);
  if (!tickets || !sameTickets(tickets, hold, eventId)) {
    return refuse(400, "TICKETS_MISMATCH", "These are not this order's tickets. Reload and try again.");
  }

  if ((sale.resends?.length ?? 0) >= RESENDS_PER_SALE) {
    return refuse(429, "RESEND_LIMIT", `This order has been resent ${RESENDS_PER_SALE} times. Contact WoCo support.`);
  }
  const key = parent.toLowerCase();
  if (!perOrganiser.allow(key, deps.now())) return refuse(429, "RATE_LIMITED", "Too many resends - try again later.");

  const ev = await deps.getEvent(eventId).catch(() => null);
  const series = ev?.series.find((s) => s.seriesId === hold.seriesId);
  const title = ev?.title || "Your tickets";
  const at = new Date(deps.now()).toISOString();
  let accepted = true;
  try {
    await deps.sendTicketEmail({
      to,
      eventId,
      eventTitle: title,
      eventDate: ev?.startDate ?? "",
      eventEndDate: ev?.endDate || undefined,
      eventLocation: ev?.location ?? "",
      seriesName: series?.name ?? "",
      totalSupply: series?.totalSupply ?? 0,
      tickets: tickets.map(({ edition, qrContent }) => ({ edition, qrContent })),
      imageHash: ev?.imageHash || undefined,
      imageGateway: ev?.gatewayUrl || undefined,
      // The organiser checked this buyer against the order: this IS the ticket's address now.
      profileCta: true,
      linkOnly: LINK_ONLY_CODES.has(row.code ?? ""),
      // A second bounce writes a fresh row, which reopens the gate (bounded by the cap).
      failureContext: { stripeSessionId: sessionId, eventId, resentBy: key },
    });
  } catch (err) {
    accepted = false;
    // The class only: a provider's message can quote the address back.
    console.error(`[ticket-hold] resend of ${sessionId} failed:`, errorClass(err));
  }
  // Counted either way: each attempt is a message to an address the organiser typed.
  deps.recordResend(sessionId, { at, toHash, by: key, accepted });
  if (!accepted) return refuse(502, "SEND_FAILED", "The email could not be sent. Check the address and try again.");

  deps.resolveTicketFailure(row.id, key, { hash: toHash, address: to });
  for (const other of deps.unresolvedTicketFailures(eventId, sessionId)) {
    deps.resolveTicketFailure(other.id, key, { hash: toHash, address: to });
  }
  try {
    await deps.replaceDoorEntries(eventId, tickets.map((t) => ({ seriesId: hold.seriesId, edition: t.edition })), { email: to });
  } catch (err) {
    console.error("[ticket-hold] door list not updated (the resend stands):", errorClass(err));
  }
  try {
    deps.recordAttendeeEmail(eventId, toHash, at);
  } catch (err) {
    console.error("[ticket-hold] attendee index not updated (the resend stands):", errorClass(err));
  }
  return { ok: true, data: { sentTo: to, resendsLeft: Math.max(0, RESENDS_PER_SALE - (sale.resends?.length ?? 0)) } };
}

function parseTickets(raw: unknown): Array<{ edition: number; qrContent: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return null;
  const out: Array<{ edition: number; qrContent: string }> = [];
  for (const t of raw) {
    const edition = (t as { edition?: unknown })?.edition;
    const qrContent = (t as { qrContent?: unknown })?.qrContent;
    if (!Number.isInteger(edition) || typeof qrContent !== "string" || qrContent.length > 512) return null;
    out.push({ edition: edition as number, qrContent });
  }
  return out;
}

/** Every held edition exactly once, each QR naming its seat and hashing to what was emailed. */
function sameTickets(tickets: Array<{ edition: number; qrContent: string }>, hold: TicketHold, eventId: string): boolean {
  if (tickets.length !== hold.tickets.length) return false;
  const want = new Map(hold.tickets.map((t) => [t.edition, t.qrHash]));
  const seen = new Set<number>();
  for (const t of tickets) {
    if (seen.has(t.edition)) return false;
    seen.add(t.edition);
    const hash = want.get(t.edition);
    if (!hash || ticketQrHash(t.qrContent) !== hash) return false;
    if (!ticketQrNamesSeat(t.qrContent, eventId, hold.seriesId, t.edition)) return false;
  }
  return true;
}
