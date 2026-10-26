/**
 * #983 step 3: the organiser's undelivered tickets - list, open the held copy, resend.
 *
 * The gate is the point: a held copy is served, and a resend accepted, only for a sale
 * with an unresolved undelivered-ticket row, still valid tickets and a running event,
 * and only to the event's creator on the server's own record. A resend must carry
 * exactly the tickets emailed.
 *
 * MUTATION: drop the row check, the void check, the cancellation or end check, or the
 * record-creator check and its "refused" test goes red; accept a QR whose hash differs,
 * a missing edition or a duplicate and "exactly the tickets" goes red; count failed
 * sends against the cap and "the cap counts accepted sends" goes red; send before the
 * attempt is recorded and "nothing is sent unrecorded" goes red; resolve the row on a
 * failed send and "a failed send resolves nothing" goes red; drop linkOnly and "link
 * only" goes red.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import type { EmailFailure } from "../src/lib/email/failure-ledger.js";
import type { TicketSale } from "../src/lib/stripe/ticket-sales.js";
import type { TicketEmailOpts } from "../src/routes/tickets.js";
import { ticketQrHash, TicketHoldUnreadableError, type TicketHold } from "../src/lib/ticket-hold/store.js";
import {
  heldCopy,
  listUndelivered,
  undeliveredSummary,
  resendTickets,
  RESENDS_PER_SALE,
  _resetResendLimiterForTests,
  type ResendDeps,
} from "../src/lib/ticket-hold/resend.js";

const EVENT = "e0000000-0000-4000-8000-000000000983";
const SERIES = "s0000000-0000-4000-8000-000000000001";
const SALE = "cs_live_resend0000000001";
const ORGANISER = "0x" + "0a".repeat(20);
const FEED_CREATOR = "0x" + "0b".repeat(20);
const SIG = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(65)}`;
const qr = (edition: number) => `woco://t/${EVENT}/${SERIES}/${edition}/${SIG(edition)}`;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const BOX = { v: 2, enc: "aa", ct: "bb" } as unknown as TicketHold["tickets"][number]["box"];

interface World {
  keys: Awaited<ReturnType<ResendDeps["eventKeys"]>>;
  sale: TicketSale | undefined;
  rows: EmailFailure[];
  void: boolean;
  cancellation: "open" | "cancelled" | "unknown";
  endMs: number | null;
  hold: TicketHold | null | "unreadable";
  suppressed: Set<string>;
  sendFails: boolean;
  feed: EventFeed | null;
  recordFails: boolean;
  suppressionUnreadable: boolean;
}

function world(): World {
  return {
    keys: { kind: "record", creator: ORGANISER, feedSigner: "0x" + "fe".repeat(20), orderKeyRef: "ab".repeat(32) },
    sale: {
      sessionId: SALE, paymentIntentId: "pi_1", connectedAccountId: "acct_1", eventId: EVENT, seriesId: SERIES,
      quantity: 2, amountTotal: 2000, currency: "gbp", recordedAt: "2026-10-23T18:00:00Z",
      onChainEventId: "0x" + "0e".repeat(32), contract: "c", slots: [0, 1],
    },
    rows: [row("r1", "Bounce/Permanent/General")],
    void: false,
    cancellation: "open",
    endMs: NOW + 86_400_000,
    hold: {
      v: 1, sessionId: SALE, eventId: EVENT, seriesId: SERIES, orderKeyRef: "ab".repeat(32), sealedAt: "2026-10-23T18:00:00Z",
      tickets: [1, 2].map((edition) => ({ edition, qrHash: ticketQrHash(qr(edition)), box: BOX })),
    },
    suppressed: new Set(),
    sendFails: false,
    recordFails: false,
    suppressionUnreadable: false,
    feed: { title: "Warehouse Party", startDate: "2026-11-01T20:00:00Z", location: "London", series: [{ seriesId: SERIES, name: "General", totalSupply: 100 }], creatorAddress: FEED_CREATOR } as unknown as EventFeed,
  };
}

function row(id: string, code: string, sessionId = SALE): EmailFailure {
  return {
    id, ts: "2026-10-23T18:51:39Z", kind: "transactional", recipients: [{ hash: "h(typo@exampl.com)", address: "typo@exampl.com" }],
    subject: "Your ticket", provider: "ses", code, error: "550", attempts: 1, retryable: false,
    context: { stripeSessionId: sessionId, eventId: EVENT, asyncEvent: "Bounce" },
  };
}

function fakes(w: World) {
  const sent: TicketEmailOpts[] = [];
  const resends: Array<NonNullable<TicketSale["resends"]>[number]> = [];
  const resolved: Array<{ id: string; by: string; sentTo: { hash: string; address?: string } }> = [];
  const door: Array<{ tickets: Array<{ seriesId: string; edition: number }>; who: { email?: string; buyerName?: string } }> = [];
  const attendees: string[] = [];
  const deps: ResendDeps = {
    eventKeys: async () => w.keys,
    getSale: (sid) => (w.sale?.sessionId === sid ? w.sale : undefined),
    isSaleVoid: () => w.void,
    unresolvedTicketFailures: (eventId, sid) =>
      w.rows.filter((r) => !r.resolvedAt && r.context?.eventId === eventId && (sid === undefined || r.context?.stripeSessionId === sid)),
    unresolvedTicketEvents: () => {
      const m = new Map<string, Set<string>>();
      for (const r of w.rows) if (!r.resolvedAt) m.set(r.context!.eventId!, (m.get(r.context!.eventId!) ?? new Set()).add(r.context!.stripeSessionId!));
      return new Map([...m].map(([k, v]) => [k, v.size]));
    },
    recordedCreator: (eventId) => (eventId === EVENT ? ORGANISER : "0x" + "99".repeat(20)),
    cancellationGate: () => w.cancellation,
    eventEndMs: async () => w.endMs,
    getTicketHold: () => {
      if (w.hold === "unreadable") throw new TicketHoldUnreadableError();
      return w.hold;
    },
    hashEmail: (e) => `h(${e})`,
    isGloballySuppressed: (h) => w.suppressed.has(h),
    suppressionUnreadable: () => w.suppressionUnreadable,
    getSiteTheme: async (siteId, eventId) => (siteId === "site-1" && eventId === EVENT ? { palette: { accent: "#ff0055" } as never, contactEmail: "hello@venue.example" } : null),
    getEvent: async () => w.feed,
    sendTicketEmail: async (opts) => {
      if (w.sendFails) throw Object.assign(new Error("MessageRejected: x@y.com"), { ledgered: true });
      sent.push(opts);
    },
    recordResend: (sid, entry) => {
      if (w.recordFails) return false;
      const e = { ...entry };
      resends.push(e);
      if (w.sale && w.sale.sessionId === sid) w.sale.resends = [...(w.sale.resends ?? []), e];
      return true;
    },
    markResendAccepted: (sid, at) => {
      const e = w.sale?.sessionId === sid ? [...(w.sale.resends ?? [])].reverse().find((r) => r.at === at && !r.accepted) : undefined;
      if (!e) return false;
      e.accepted = true;
      return true;
    },
    resolveTicketFailure: (id, by, sentTo) => {
      resolved.push({ id, by, sentTo });
      const r = w.rows.find((x) => x.id === id);
      if (r) r.resolvedAt = new Date(NOW).toISOString();
      return true;
    },
    replaceDoorEntries: async (_e, tickets, who) => {
      door.push({ tickets, who });
    },
    recordAttendeeEmail: (_e, h) => {
      attendees.push(h);
    },
    now: () => NOW,
  };
  return { deps, sent, resends, resolved, door, attendees };
}

const goodBody = (to = "buyer@example.com") => ({ to, tickets: [1, 2].map((edition) => ({ edition, qrContent: qr(edition) })) });

beforeEach(() => _resetResendLimiterForTests());

// ── The organiser ───────────────────────────────────────────────────────────

test("only the creator on the server's record: the feed's creatorAddress opens nothing", async () => {
  const w = world();
  const f = fakes(w);
  for (const v of [
    await listUndelivered(f.deps, EVENT, FEED_CREATOR),
    await heldCopy(f.deps, EVENT, SALE, FEED_CREATOR),
    await resendTickets(f.deps, EVENT, SALE, FEED_CREATOR, goodBody()),
  ]) {
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.status, 403);
  }
  assert.equal(f.sent.length, 0);
  // Case-insensitive on the caller's address.
  assert.equal((await heldCopy(f.deps, EVENT, SALE, ORGANISER.toUpperCase().replace("0X", "0x"))).ok, true);
});

test("a legacy event has nothing held", async () => {
  const w = world();
  w.keys = { kind: "legacy" };
  const v = await heldCopy(fakes(w).deps, EVENT, SALE, ORGANISER);
  assert.ok(!v.ok && v.status === 404 && v.code === "NO_HELD_COPY");
});

// ── The gate ────────────────────────────────────────────────────────────────

test("the copy is served for a bounced sale - boxes only, never the hashes", async () => {
  const v = await heldCopy(fakes(world()).deps, EVENT, SALE, ORGANISER);
  assert.ok(v.ok);
  assert.deepEqual(v.data.tickets.map((t) => t.edition), [1, 2]);
  assert.deepEqual(Object.keys(v.data.tickets[0]!).sort(), ["box", "edition"]);
  assert.equal(v.data.orderKeyRef, "ab".repeat(32));
});

test("refused: no row, a resolved row, another event's sale, an unknown sale", async () => {
  const cases: Array<[string, (w: World) => void, string]> = [
    ["no row", (w) => (w.rows = []), "NO_UNDELIVERED"],
    ["resolved row", (w) => (w.rows[0]!.resolvedAt = "2026-10-23T21:00:00Z"), "NO_UNDELIVERED"],
    ["another sale's row", (w) => (w.rows = [row("r9", "Bounce/Permanent/General", "cs_live_other00000001")]), "NO_UNDELIVERED"],
    ["another event's sale", (w) => (w.sale!.eventId = "e0000000-0000-4000-8000-000000000999"), "NO_UNDELIVERED"],
    ["unknown sale", (w) => (w.sale = undefined), "NO_UNDELIVERED"],
  ];
  for (const [name, change, code] of cases) {
    const w = world();
    change(w);
    const f = fakes(w);
    const c = await heldCopy(f.deps, EVENT, SALE, ORGANISER);
    const r = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
    assert.ok(!c.ok && c.code === code && c.status === 404, name);
    assert.ok(!r.ok && r.code === code, name);
    assert.equal(f.sent.length, 0, name);
  }
});

test("refused: a void sale, a cancelled event, an unreadable cancellation record, an ended event", async () => {
  const cases: Array<[string, (w: World) => void, number, string]> = [
    ["void", (w) => (w.void = true), 409, "SALE_VOID"],
    ["cancelled", (w) => (w.cancellation = "cancelled"), 409, "EVENT_CANCELLED"],
    ["cancellations unreadable", (w) => (w.cancellation = "unknown"), 503, "CANCELLATIONS_UNREADABLE"],
    ["ended", (w) => (w.endMs = NOW - 1), 409, "EVENT_ENDED"],
  ];
  for (const [name, change, status, code] of cases) {
    const w = world();
    change(w);
    const f = fakes(w);
    const c = await heldCopy(f.deps, EVENT, SALE, ORGANISER);
    assert.ok(!c.ok && c.status === status && c.code === code, name);
    assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, false, name);
    assert.equal(f.sent.length, 0, name);
  }
});

test("an end the chain cannot tell does not block a buyer on the night", async () => {
  const w = world();
  w.endMs = null;
  assert.equal((await heldCopy(fakes(w).deps, EVENT, SALE, ORGANISER)).ok, true);
});

test("no copy says so (reissue is the remedy); an unreadable one is a 503", async () => {
  const w = world();
  w.hold = null;
  const none = await heldCopy(fakes(w).deps, EVENT, SALE, ORGANISER);
  assert.ok(!none.ok && none.status === 404 && none.code === "NO_HELD_COPY");
  w.hold = "unreadable";
  const bad = await heldCopy(fakes(w).deps, EVENT, SALE, ORGANISER);
  assert.ok(!bad.ok && bad.status === 503 && bad.code === "COPY_UNREADABLE");
});

// ── The resend ──────────────────────────────────────────────────────────────

test("a resend emails exactly the held tickets, and records what happened", async () => {
  const w = world();
  const f = fakes(w);
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER.toUpperCase().replace("0X", "0x"), goodBody(" buyer@example.com "));
  assert.ok(v.ok);
  assert.equal(v.data.sentTo, "buyer@example.com");
  assert.equal(v.data.resendsLeft, RESENDS_PER_SALE - 1);
  const m = f.sent[0]!;
  assert.equal(m.to, "buyer@example.com");
  assert.deepEqual(m.tickets, goodBody().tickets);
  assert.equal(m.eventTitle, "Warehouse Party");
  assert.equal(m.seriesName, "General");
  assert.equal(m.profileCta, true, "the corrected address is now the ticket's");
  assert.equal(m.linkOnly, false);
  assert.deepEqual(m.failureContext, { stripeSessionId: SALE, eventId: EVENT, resentBy: ORGANISER });
  assert.deepEqual(f.resends, [{ at: new Date(NOW).toISOString(), toHash: "h(buyer@example.com)", by: ORGANISER, accepted: true }], "recorded before, accepted after");
  assert.deepEqual(f.resolved, [{ id: "r1", by: ORGANISER, sentTo: { hash: "h(buyer@example.com)", address: "buyer@example.com" } }]);
  assert.deepEqual(f.door, [{ tickets: [{ seriesId: SERIES, edition: 1 }, { seriesId: SERIES, edition: 2 }], who: { email: "buyer@example.com" } }]);
  assert.deepEqual(f.attendees, ["h(buyer@example.com)"]);
  // Resolved: the gate is shut again.
  assert.equal((await heldCopy(f.deps, EVENT, SALE, ORGANISER)).ok, false);
});

test("every unresolved row of the sale is resolved by one resend", async () => {
  const w = world();
  w.rows.push(row("r2", "Bounce/Permanent/General"));
  const f = fakes(w);
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, true);
  assert.deepEqual(f.resolved.map((r) => r.id).sort(), ["r1", "r2"]);
});

test("exactly the tickets emailed: a missing, extra, duplicate or altered ticket is refused", async () => {
  const t = (edition: number, qrContent = qr(edition)) => ({ edition, qrContent });
  const reencoded = qr(1).replace(/0x.*$/, `0x${"01".repeat(64)}1c`);
  const cases: Array<[string, unknown]> = [
    ["missing", [t(1)]],
    ["extra", [t(1), t(2), t(3)]],
    ["duplicate", [t(1), t(1)]],
    ["altered signature", [t(1, reencoded), t(2)]],
    ["swapped", [t(1, qr(2)), t(2, qr(1))]],
    ["not an array", "x"],
    ["empty", []],
  ];
  for (const [name, tickets] of cases) {
    const f = fakes(world());
    const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, { to: "buyer@example.com", tickets });
    assert.ok(!v.ok && v.status === 400 && v.code === "TICKETS_MISMATCH", name);
    assert.equal(f.sent.length + f.resends.length, 0, name);
  }
});

test("the address: required and mailable, and never one that bounced or complained before", async () => {
  for (const to of ["", "not-an-address", "a".repeat(250) + "@x.co", 42]) {
    const v = await resendTickets(fakes(world()).deps, EVENT, SALE, ORGANISER, { ...goodBody(), to });
    assert.ok(!v.ok && v.code === "BAD_ADDRESS", String(to));
  }
  const w = world();
  w.suppressed.add("h(dead@example.com)");
  const f = fakes(w);
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("dead@example.com"));
  assert.ok(!v.ok && v.status === 409 && v.code === "ADDRESS_SUPPRESSED");
  assert.equal(f.sent.length, 0);
  // The same address again is fine when it was not suppressed (a full mailbox, emptied).
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("typo@exampl.com"))).ok, true);
});

test("a failed send resolves nothing and touches no door list - it is kept, as not accepted", async () => {
  const w = world();
  w.sendFails = true;
  const f = fakes(w);
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
  assert.ok(!v.ok && v.status === 502 && v.code === "SEND_FAILED");
  assert.deepEqual(f.resends.map((r) => r.accepted), [false]);
  assert.equal(f.resolved.length, 0);
  assert.equal(f.door.length + f.attendees.length, 0);
});

test("the cap counts accepted sends: a mailer failure never strands the buyer", async () => {
  const w = world();
  w.sendFails = true;
  const f = fakes(w);
  for (let i = 0; i < RESENDS_PER_SALE + 1; i++) await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
  w.sendFails = false;
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, true, "failures did not use up the cap");
  // Three ACCEPTED sends, each to a fresh bounce, and the fourth is refused.
  for (let i = 1; i < RESENDS_PER_SALE; i++) {
    w.rows.push(row(`again${i}`, "Bounce/Permanent/General"));
    assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody(`n${i}@example.com`))).ok, true);
  }
  w.rows.push(row("again-last", "Bounce/Permanent/General"));
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("last@example.com"));
  assert.ok(!v.ok && v.status === 429 && v.code === "RESEND_LIMIT");
  assert.equal(f.sent.length, RESENDS_PER_SALE);
});

test("nothing is sent unrecorded: a sale record that cannot be written refuses the resend", async () => {
  const w = world();
  w.recordFails = true;
  const f = fakes(w);
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
  assert.ok(!v.ok && v.status === 503 && v.code === "RESEND_NOT_RECORDED");
  assert.equal(f.sent.length, 0);
});

test("an unreadable suppression list is a 503, never 'that address bounced'", async () => {
  const w = world();
  w.suppressionUnreadable = true;
  const f = fakes(w);
  const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
  assert.ok(!v.ok && v.status === 503 && v.code === "SUPPRESSION_UNREADABLE");
  assert.equal(f.sent.length, 0);
});

test("a sale from an organiser site resends in the site's colours, with replies to the organiser", async () => {
  const w = world();
  w.rows = [{ ...row("r1", "Bounce/Permanent/General"), context: { stripeSessionId: SALE, eventId: EVENT, siteId: "site-1" } }];
  const f = fakes(w);
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, true);
  assert.deepEqual(f.sent[0]!.palette, { accent: "#ff0055" });
  assert.equal(f.sent[0]!.replyTo, "hello@venue.example");
  const plain = fakes(world());
  await resendTickets(plain.deps, EVENT, SALE, ORGANISER, goodBody());
  assert.equal(plain.sent[0]!.replyTo, undefined, "no site, no reply-to");
});

test("ten resends an hour per organiser, across every sale", async () => {
  const w = world();
  w.sendFails = true; // keeps the row open, so each call reaches the limiter
  w.sale!.resends = [];
  const f = fakes(w);
  let limited = 0;
  for (let i = 0; i < 11; i++) {
    w.sale!.resends = []; // a different sale each time, as far as the per-sale cap goes
    const v = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody());
    if (!v.ok && v.code === "RATE_LIMITED") limited++;
  }
  assert.equal(limited, 1);
});

test("link only when the message itself was refused - a full mailbox gets the full email", async () => {
  for (const [code, linkOnly] of [
    ["Bounce/Transient/MessageTooLarge", true],
    ["Bounce/Transient/ContentRejected", true],
    ["Bounce/Transient/AttachmentRejected", true],
    ["Reject", true],
    ["Bounce/Transient/MailboxFull", false],
    ["Bounce/Permanent/General", false],
  ] as const) {
    const w = world();
    w.rows = [row("r1", code)];
    const f = fakes(w);
    assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, true, code);
    assert.equal(f.sent[0]!.linkOnly, linkOnly, code);
  }
});

test("the QR never reaches a log line, on success or on a failed send", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await resendTickets(fakes(world()).deps, EVENT, SALE, ORGANISER, goodBody());
    const w = world();
    w.sendFails = true;
    await resendTickets(fakes(w).deps, EVENT, SALE, ORGANISER, goodBody());
  } finally {
    Object.assign(console, orig);
  }
  for (const l of lines) {
    assert.ok(!l.includes(SIG(1)) && !l.includes(SIG(2)), l);
    assert.ok(!l.includes("x@y.com") && !l.includes("buyer@example.com"), l);
  }
});

// ── The list ────────────────────────────────────────────────────────────────

test("the list: one line per sale, what the buyer typed, and why a sale cannot be resent", async () => {
  const w = world();
  w.rows.push(row("r2", "Bounce/Transient/MailboxFull"));
  w.sale!.resends = [{ at: "x", toHash: "y", by: ORGANISER, accepted: false }]; // a failed send uses nothing up
  const v = await listUndelivered(fakes(w).deps, EVENT, ORGANISER);
  assert.ok(v.ok);
  assert.equal(v.data.length, 1, "two rows, one sale");
  assert.deepEqual(v.data[0], {
    sessionId: SALE,
    failedAt: "2026-10-23T18:51:39Z",
    reason: "Bounce/Permanent/General",
    typedAddress: "typo@exampl.com",
    editions: [1, 2],
    resendsLeft: RESENDS_PER_SALE,
    blocked: null,
  });
  w.void = true;
  const blocked = await listUndelivered(fakes(w).deps, EVENT, ORGANISER);
  assert.ok(blocked.ok);
  assert.equal(blocked.data[0]!.blocked, "SALE_VOID");
});

test("two resends of one sale at once: one email, the other refused - the cap cannot be raced", { timeout: 5000 }, async () => {
  const w = world();
  const f = fakes(w);
  // Every send waits here until released, so a racing second send cannot strand the first.
  const waiting: Array<() => void> = [];
  const slowSend = f.deps.sendTicketEmail;
  f.deps.sendTicketEmail = async (opts) => {
    await new Promise<void>((r) => waiting.push(r));
    return slowSend(opts);
  };
  const first = resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("one@example.com"));
  await new Promise((r) => setImmediate(r));
  const second = resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("two@example.com"));
  await new Promise((r) => setImmediate(r));
  for (const go of waiting.splice(0)) go();
  const secondResult = await second;
  assert.ok(!secondResult.ok && secondResult.status === 409 && secondResult.code === "RESEND_IN_PROGRESS");
  assert.equal((await first).ok, true);
  assert.deepEqual(f.sent.map((m) => m.to), ["one@example.com"]);
  // Afterwards the row is resolved: the gate is shut, not the lock.
  const third = await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody("two@example.com"));
  assert.ok(!third.ok && third.code === "NO_UNDELIVERED");
});

test("the lock is released when a send throws", async () => {
  const w = world();
  w.sendFails = true;
  const f = fakes(w);
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, false);
  w.sendFails = false;
  assert.equal((await resendTickets(f.deps, EVENT, SALE, ORGANISER, goodBody())).ok, true);
});

test("step 4: the dashboard badge counts the caller's own events only", () => {
  const w = world();
  w.rows.push(row("r2", "Bounce/Permanent/General", "cs_live_second0000001"));
  w.rows.push({ ...row("r3", "Bounce/Permanent/General", "cs_live_third00000001"), context: { stripeSessionId: "cs_live_third00000001", eventId: "e0000000-0000-4000-8000-000000000999" } });
  const f = fakes(w);
  assert.deepEqual(undeliveredSummary(f.deps, ORGANISER.toUpperCase().replace("0X", "0x")), [{ eventId: EVENT, sales: 2 }]);
  assert.deepEqual(undeliveredSummary(f.deps, FEED_CREATOR), [], "the feed's creatorAddress sees none");
});

test("step 4: the name the organiser types goes to the door list, trimmed and bounded", async () => {
  const f = fakes(world());
  await resendTickets(f.deps, EVENT, SALE, ORGANISER, { ...goodBody(), buyerName: `  ${"A".repeat(150)}  ` });
  assert.equal(f.door[0]!.who.buyerName, "A".repeat(100));
  const plain = fakes(world());
  await resendTickets(plain.deps, EVENT, SALE, ORGANISER, { ...goodBody(), buyerName: 42 });
  assert.deepEqual(plain.door[0]!.who, { email: "buyer@example.com" }, "no name, no name field");
});
