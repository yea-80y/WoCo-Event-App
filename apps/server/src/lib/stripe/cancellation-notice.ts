/**
 * WoCo's own email to each buyer of a cancelled event (#798).
 *
 * The organiser's "event cancelled" broadcast is built from decrypted orders,
 * so it cannot reach a buyer whose order was erased (#546), nor anyone whose
 * organiser never sends one. Owner decision (2026-10-07): every buyer is told.
 * So the refund pass notifies each sale itself, to the email on that sale's
 * Stripe checkout - read at send time, stored nowhere.
 *
 * Once per sale, the first time something has happened to the money:
 *   issued  - a refund exists (done / pending / requires-action)
 *   delayed - it could not be made yet (pending-funds / failed / abandoned /
 *             disputed); a later `issued` follows when it lands
 * A pass whose Stripe read failed has learned nothing and sends nothing.
 *
 * A service message about the buyer's own money, and nothing else: no other
 * events, no organiser call to action (PECR reg. 22).
 */

import { mayDeliverRefundNotice } from "../email/service-notice-crossing.js";
import { redactAddresses } from "../email/failure-ledger.js";
import type { SuppressSource } from "../marketing/suppression-store.js";
import type { CancelNotice, CancelRefundRow } from "../event/cancellations.js";

/** Failed sends before a notice is left to the failure ledger and an operator. */
export const MAX_NOTICE_FAILURES = 3;

export type NoticeVariant = "issued" | "delayed";

const ISSUED = new Set(["done", "pending", "requires-action"]);
const DELAYED = new Set(["pending-funds", "failed", "abandoned", "disputed"]);

/** Which notice this row is owed now, or null. Pure. */
export function noticeDue(row: CancelRefundRow): NoticeVariant | null {
  const n = row.notice ?? {};
  if (n.issuedAt || n.unreachable || (n.failures ?? 0) >= MAX_NOTICE_FAILURES) return null;
  // A `pending` row that has not been read, or whose last read failed (or met
  // a refund made elsewhere), has learned nothing about THIS refund yet. The
  // `lastError` half matters after a re-open: the row keeps its old `charged`.
  if (row.status === "pending" && (row.charged === undefined || row.lastError)) return null;
  if (ISSUED.has(row.status)) return "issued";
  if (DELAYED.has(row.status) && !n.delayedAt) return "delayed";
  return null;
}

export function formatAmount(minor: number | undefined, currency: string | undefined): string | null {
  if (minor === undefined || !currency) return null;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return null;
  }
}

/**
 * The event title as plain words. It is the one piece of organiser-written
 * text in a message that crosses unsubscribes and erasure, and the organiser
 * can rename the event just before cancelling, so it must not be able to carry
 * a link, a domain or an address.
 *
 * Two layers. The patterns strip what looks like a URL, an address or a domain
 * (best effort: it removes the spammer's words too). The guarantee is the
 * second layer, an ALLOWLIST: letters, marks, numbers, currency, spaces and
 * plain punctuation - never `/`, `:`, `@` or `\` - and a dot only at the end of
 * a word or inside a plain number ("v2.0"). With those gone, no domain, URL or
 * email can be formed, however it is spelled. Capped at 80 characters; a title
 * reduced to nothing falls back to the generic wording.
 */
export function plainTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const words = title
    // What a mail client would linkify: IDNA's full stops and fullwidth forms.
    .normalize("NFKC")
    .replace(/[\u3002\uFF61\uFE52\u2024]/gu, ".")
    .replace(/\p{Cf}/gu, "")
    // Layer 1: patterns.
    .replace(/https?:\/\/\S*/giu, " ")
    .replace(/www\.\S*/giu, " ")
    .replace(/\S+@\S+/gu, " ")
    .replace(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,24}|xn--[a-z0-9-]{2,59})(?![\p{L}\p{N}])\S*/giu, " ")
    // Layer 2: the allowlist, then dots.
    .replace(/[^\p{L}\p{M}\p{N}\p{Sc}\s.,'\u2019&!?()#+-]/gu, " ")
    .split(/\s+/u)
    .map((tok) => (/^\p{L}{0,3}\d+\.\d+$/u.test(tok) ? tok : tok.replace(/\.(?=.)/gu, " ")))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!words) return undefined;
  return words.length > 80 ? `${words.slice(0, 79).trimEnd()}…` : words;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildCancellationNotice(input: {
  variant: NoticeVariant;
  title: string | undefined;
  status: CancelRefundRow["status"];
  amount: string | null;
}): { subject: string; html: string; text: string } {
  const event = plainTitle(input.title) || "An event you booked";
  const refund = input.amount ? `your refund of ${input.amount}` : "your refund";
  const subject = input.variant === "issued"
    ? `${event} is cancelled - your refund is on its way`
    : `${event} is cancelled - your refund is being arranged`;
  const lines: string[] = [`${event} has been cancelled by its organiser, and your tickets are no longer valid.`];
  if (input.variant === "issued") {
    lines.push(
      input.status === "requires-action"
        ? `We have started ${refund} to the card you paid with. Your bank or payment provider may contact you to complete it.`
        : `We have sent ${refund} to the card you paid with. It usually reaches your account within 5 to 10 working days.`,
    );
    lines.push("You don't need to do anything.");
  } else {
    lines.push(`${refund[0]!.toUpperCase()}${refund.slice(1)} is being arranged and has not been sent yet. We will email you again as soon as it has.`);
  }
  lines.push("This is a service message about your booking, sent to the email you paid with.");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px;">
    <table width="100%" style="max-width:480px;margin:0 auto;background:#222;border:1px solid #333;border-radius:8px;">
      <tr><td style="padding:32px 28px;">
        ${lines.map((l, i) => `<p style="margin:0 0 ${i === lines.length - 1 ? 0 : 16}px;color:${i === lines.length - 1 ? "#9a9a94" : "#e8e8e4"};font-size:${i === lines.length - 1 ? 13 : 15}px;line-height:1.6;">${escHtml(l)}</p>`).join("\n        ")}
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
  return { subject, html, text: lines.join("\n\n") + "\n" };
}

export interface CancellationNoticeDeps {
  /** The email on the sale's Stripe checkout, or null when it has none. Throws on transport. */
  buyerEmail(sessionId: string, account: string): Promise<string | null>;
  hashEmail(email: string): string;
  /** Active suppression marks for this address (global and the organiser's). */
  suppressionSources(emailHash: string, organiser: string): SuppressSource[];
  /** The event's organiser, lowercase 0x, or "" when unknown (global marks still apply). */
  organiserOf(eventId: string): string;
  /** Rejects when the message could not be delivered. */
  send(to: string, message: { subject: string; html: string; text: string }, context: Record<string, string>): Promise<void>;
  setNotice(eventId: string, sessionId: string, notice: CancelNotice): void;
  now(): Date;
}

export type NoticeOutcome = "sent" | "unreachable" | "failed" | "deferred" | "none";

/**
 * Send this row the notice it is owed, if any. The pass fences it, so a notice
 * can never stop a refund. The marker is written AFTER the provider accepts, so
 * a crash in between costs at most one duplicate, never silence.
 */
export async function notifyRow(
  eventId: string,
  title: string | undefined,
  row: CancelRefundRow,
  deps: CancellationNoticeDeps,
): Promise<NoticeOutcome> {
  const variant = noticeDue(row);
  if (!variant) return "none";
  const notice: CancelNotice = { ...(row.notice ?? {}) };
  let to: string | null;
  try {
    to = await deps.buyerEmail(row.sessionId, row.account);
  } catch (err) {
    // The next pass tries again. A Stripe error names the session, never the buyer.
    console.warn(`[cancel-notice] ${row.sessionId}: buyer email read failed:`, redactAddresses(err instanceof Error ? err.message : String(err)));
    return "deferred";
  }
  if (!to) {
    deps.setNotice(eventId, row.sessionId, { ...notice, unreachable: "no-address" });
    return "unreachable";
  }
  if (!mayDeliverRefundNotice(deps.suppressionSources(deps.hashEmail(to), deps.organiserOf(eventId)))) {
    deps.setNotice(eventId, row.sessionId, { ...notice, unreachable: "undeliverable" });
    return "unreachable";
  }
  const message = buildCancellationNotice({
    variant,
    title,
    status: row.status,
    amount: formatAmount(row.refunded ?? row.charged, row.currency),
  });
  try {
    await deps.send(to, message, { kind: "cancellation-notice", eventId, sessionId: row.sessionId, variant });
  } catch {
    deps.setNotice(eventId, row.sessionId, { ...notice, failures: (notice.failures ?? 0) + 1 });
    return "failed";
  }
  const at = deps.now().toISOString();
  // A success clears the failure count: the cap is per notice, not per sale.
  const { failures: _cleared, ...kept } = notice;
  deps.setNotice(eventId, row.sessionId, variant === "issued" ? { ...kept, issuedAt: at } : { ...kept, delayedAt: at });
  return "sent";
}
