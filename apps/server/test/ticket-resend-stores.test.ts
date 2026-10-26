/**
 * #983 step 3, the stores and the HTTP edge behind a resend.
 *
 *  - The ledger: only an unresolved TRANSACTIONAL row for this event and sale opens
 *    the gate, and resolving it adds the address the ticket went to, so an access
 *    or erasure request for that address reaches the record.
 *  - The sale record keeps every resend (hash only), durably.
 *  - All three routes need a signed session.
 *
 * MUTATION: let a marketing row or another event's row through and "only an
 * unresolved transactional row" goes red; skip the recipient on resolve and "erasure
 * reaches" goes red; drop requireAuth from a route and "signed session" goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "woco-983-resend-stores-")));
process.env.EMAIL_HASH_SECRET ??= "test-secret-983-resend";

let ledger: typeof import("../src/lib/email/failure-ledger.js");
let sales: typeof import("../src/lib/stripe/ticket-sales.js");

const EVENT = "e0000000-0000-4000-8000-000000000983";
const SALE = "cs_live_stores00000001";

before(async () => {
  ledger = await import("../src/lib/email/failure-ledger.js");
  sales = await import("../src/lib/stripe/ticket-sales.js");
  ledger._resetForTest();
});

const ticketRow = (context: Record<string, string>, kind: "transactional" | "marketing" = "transactional") =>
  ledger.recordFailure({
    kind,
    recipients: ["typo@exampl.com"],
    recipientHashes: ["hash-typo"],
    subject: "Your ticket",
    provider: "ses",
    error: "550",
    attempts: 1,
    retryable: false,
    context,
  });

test("only an unresolved transactional row for this event and sale opens the gate", () => {
  const mine = ticketRow({ stripeSessionId: SALE, eventId: EVENT });
  ticketRow({ stripeSessionId: SALE, eventId: EVENT }, "marketing");
  ticketRow({ stripeSessionId: SALE, eventId: "e0000000-0000-4000-8000-000000000999" });
  ticketRow({ stripeSessionId: "cs_live_other00000001", eventId: EVENT });
  ticketRow({ eventId: EVENT }); // no sale named: a render failure with no session
  assert.deepEqual(ledger.unresolvedTicketFailures(EVENT, SALE).map((e) => e.id), [mine.id]);
  assert.equal(ledger.unresolvedTicketFailures(EVENT).length, 2, "both sales of this event, never the session-less row");
});

test("resolving adds the address it went to, so erasure reaches it", () => {
  const [row] = ledger.unresolvedTicketFailures(EVENT, SALE);
  assert.equal(ledger.resolveTicketFailure(row!.id, "0xorg", { hash: "hash-new", address: "buyer@example.com" }), true);
  assert.equal(ledger.unresolvedTicketFailures(EVENT, SALE).length, 0, "the gate shuts");
  assert.equal(ledger.resolveTicketFailure(row!.id, "0xorg", { hash: "hash-new", address: "buyer@example.com" }), false, "once");
  const found = ledger.failuresForHash("hash-new");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.resolvedBy, "0xorg");
  assert.equal(ledger.eraseRecipient("hash-new"), 1);
  assert.equal(ledger.failuresForHash("hash-new")[0]!.recipients.find((r) => r.hash === "hash-new")!.address, undefined);
  assert.equal(ledger.failuresForHash("hash-new")[0]!.recipients.find((r) => r.hash === "hash-typo")!.address, "typo@exampl.com", "only that subject's");
});

test("a marketing row is never resolved as a ticket", () => {
  const m = ticketRow({ stripeSessionId: SALE, eventId: EVENT }, "marketing");
  assert.equal(ledger.resolveTicketFailure(m.id, "0xorg", { hash: "h", address: "a@b.co" }), false);
});

test("every resend is kept on the sale, durably, hash only", () => {
  sales.recordSaleStub({ sessionId: SALE, paymentIntentId: "pi_stores", connectedAccountId: "acct_1", eventId: EVENT, seriesId: "s1", quantity: 1, amountTotal: 1000, currency: "gbp" });
  assert.equal(sales.recordResend(SALE, { at: "2026-10-24T12:00:00Z", toHash: "hash-new", by: "0xorg", accepted: false }), true);
  assert.equal(sales.recordResend(SALE, { at: "2026-10-24T12:01:00Z", toHash: "hash-new", by: "0xorg", accepted: true }), true);
  assert.equal(sales.recordResend("cs_live_nosuchsale0001", { at: "x", toHash: "y", by: "z", accepted: true }), false);
  const onDisk = JSON.parse(readFileSync(join(process.cwd(), ".data", "ticket-sales.json"), "utf-8"));
  assert.deepEqual(onDisk[SALE].resends.map((r: { accepted: boolean }) => r.accepted), [false, true]);
  assert.ok(!JSON.stringify(onDisk).includes("buyer@example.com"));
});

test("all three routes need a signed session", async () => {
  const { undeliveredRoutes } = await import("../src/routes/undelivered.js");
  const app = undeliveredRoutes({} as never);
  for (const [method, path] of [
    ["GET", `/${EVENT}/undelivered`],
    ["GET", `/${EVENT}/undelivered/${SALE}/copy`],
    ["POST", `/${EVENT}/undelivered/${SALE}/resend`],
  ] as const) {
    const res = await app.request(path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("a resend counts once the mailer took it, and only then names its sale for an access request", async () => {
  const SALE2 = "cs_live_stores00000002";
  sales.recordSaleStub({ sessionId: SALE2, paymentIntentId: "pi_stores2", connectedAccountId: "acct_1", eventId: EVENT, seriesId: "s1", quantity: 1, amountTotal: 1000, currency: "gbp" });
  const at = "2026-10-24T13:00:00.000Z";
  sales.recordResend(SALE2, { at, toHash: "hash-later", by: "0xorg", accepted: false });
  sales.recordResend(SALE2, { at, toHash: "hash-later", by: "0xorg", accepted: false });
  const { reportSubject } = await import("../src/lib/marketing/subject-request.js");
  assert.deepEqual(sales.salesResentTo("hash-later"), []);
  assert.deepEqual(reportSubject("hash-later").ticketResends, []);
  assert.equal(sales.markResendAccepted(SALE2, at), true);
  assert.deepEqual(sales.getSale(SALE2)!.resends!.map((r) => r.accepted), [false, true], "the newest attempt, never an older one");
  assert.deepEqual(sales.salesResentTo("hash-later").map((s) => s.sessionId), [SALE2]);
  assert.deepEqual(reportSubject("hash-later").ticketResends, [{ sessionId: SALE2, eventId: EVENT }]);
  assert.equal(sales.markResendAccepted("cs_live_nosuchsale0001", at), false);
});
