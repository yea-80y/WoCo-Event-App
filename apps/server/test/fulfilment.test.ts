/**
 * Paid-session fulfilment (#314).
 *
 * The webhook has told Stripe 200 and consumed the session id before this code
 * runs, so nothing here is ever retried by Stripe. The suite therefore pins ONE
 * property above all others, by making every collaborator throw in turn:
 *
 *   Every paid ticket is issued or refunded, and every issued ticket is either
 *   emailed or recorded in the undelivered ledger. The function never rejects.
 *
 * Plus the ordering that property depends on (ledger before mint, hold release
 * before refund, refund before email, void only on a full refund), and the
 * specific outcome each failure is meant to produce.
 *
 * Everything is driven through `FulfilmentDeps` — no Stripe, chain, bee or
 * `.data` is touched. The fake mirrors the one contract the orchestration
 * relies on: a mailer rejection carrying `ledgered: true` means the mailer has
 * already written the undelivered row.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import {
  fulfilPaidSession,
  type FulfilmentDeps,
  type FulfilmentSession,
  type FulfilmentOutcome,
} from "../src/lib/stripe/fulfilment.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENT_ID = "ev-000000000001";
const SERIES_ID = "sr-000000000001";
const ON_CHAIN_EVENT_ID = "0x" + "ab".repeat(32);
const MANIFEST_REF = "cd".repeat(32);
const ORDER_REF = "ef".repeat(32);
const ORGANISER = "0x" + "11".repeat(20);
const BUYER_WALLET = "0x" + "22".repeat(20);
const ACCT = "acct_test_1";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
/** Unix seconds, the Stripe `event.created` of the test payment. */
const PAID_AT = 1_800_000_000;

function eventFeed(over: Partial<EventFeed> = {}, series: Partial<EventFeed["series"][number]> = {}): EventFeed {
  return {
    v: 1,
    eventId: EVENT_ID,
    title: "Test Night",
    description: "",
    imageHash: "00".repeat(32),
    startDate: FUTURE,
    endDate: FUTURE,
    location: "The Venue",
    creatorAddress: ORGANISER as `0x${string}`,
    creatorPodKey: "",
    createdAt: PAST,
    series: [
      {
        seriesId: SERIES_ID,
        name: "General",
        description: "",
        totalSupply: 100,
        price: 2000,
        onChainEventId: ON_CHAIN_EVENT_ID,
        swarmManifestRef: MANIFEST_REF,
        ...series,
      },
    ],
    ...over,
  } as EventFeed;
}

interface SessionOpts {
  quantity?: number;
  email?: string | null;
  wallet?: string | null;
  orderRef?: string | null;
  reservationId?: string | null;
  siteId?: string | null;
  consent?: "1" | "0" | null;
  connectedAccountId?: string | null;
  paymentIntent?: string | null;
  amountTotal?: number;
  /** Drop eventId/seriesId entirely — "not our session". */
  noEventKeys?: boolean;
}

function session(o: SessionOpts = {}): FulfilmentSession {
  const md: Record<string, string> = {};
  if (!o.noEventKeys) {
    md.eventId = EVENT_ID;
    md.seriesId = SERIES_ID;
  }
  md.claimerEmail = o.email === null ? "" : (o.email ?? "buyer@example.com");
  md.claimerAddress = o.wallet === null || o.wallet === undefined ? "" : o.wallet;
  md.quantity = String(o.quantity ?? 2);
  if (o.orderRef !== null) md.orderRef = o.orderRef ?? ORDER_REF;
  if (o.reservationId !== null) md.reservationId = o.reservationId ?? "res-1";
  if (o.siteId !== null) md.siteId = o.siteId ?? "site-1";
  if (o.consent !== null) md.marketingConsent = o.consent ?? "1";
  if (o.connectedAccountId !== null) md.connectedAccountId = o.connectedAccountId ?? ACCT;
  return {
    id: "cs_test_1",
    metadata: md,
    amount_total: o.amountTotal ?? 4400,
    currency: "gbp",
    payment_intent: o.paymentIntent === null ? null : (o.paymentIntent ?? "pi_1"),
    customer_details: { name: "  Ada Lovelace " },
  };
}

// ---------------------------------------------------------------------------
// Fake deps — records every call, and can make any one step throw
// ---------------------------------------------------------------------------

type Step =
  | "hashEmail"
  | "resolveSiteEventSigner"
  | "getEvent"
  | "chainEventEndMs"
  | "recordHeldPayout"
  | "getOrganiserByStripeAccount"
  | "uploadToBytes"
  | "downloadFromBytes"
  | "generateBurner"
  | "signMessage"
  | "batchClaimForOnChain"
  | "bindTicket"
  | "consumeReservation"
  | "createRefund"
  | "markPayoutVoid"
  | "captureCheckoutConsent"
  | "getSiteTheme"
  | "sendTicketEmail"
  | "sendTicketEmailLedgered"
  | "recordUndeliveredTicket";

interface FakeOpts {
  /** The step that throws. `sendTicketEmailLedgered` rejects with `ledgered: true`. */
  fail?: Step;
  /** Event feed returned by getEvent (`null` = not found). Default: registered v2 series. */
  event?: EventFeed | null;
  /** Value of chainEventEndMs. Default: far future. */
  chainEndMs?: number | null;
  /** Contract batch cap. Default 100 (one chunk for any test quantity). */
  batchMax?: number;
  /** Chunk index (0-based) at which batchClaimFor reverts. Default: never. */
  revertAtChunk?: number;
  /** Ticket index at which signMessage throws (with fail = "signMessage"). Default 0. */
  signFailAt?: number;
}

function fakeDeps(o: FakeOpts = {}) {
  const calls: string[] = [];
  const refunds: Array<{ params: Record<string, unknown>; account: string | undefined }> = [];
  const emails: Array<Parameters<FulfilmentDeps["sendTicketEmail"]>[0]> = [];
  const ledgerRows: Array<Parameters<FulfilmentDeps["recordUndeliveredTicket"]>[0]> = [];
  /** Rows the MAILER wrote before rejecting with `ledgered: true`. */
  const mailerLedger: string[] = [];
  const held: Array<Record<string, unknown>> = [];
  const voided: string[] = [];
  const bindings: Array<Record<string, unknown>> = [];
  const consents: Array<Record<string, unknown>> = [];
  const consumed: string[] = [];
  const minted: string[][] = [];
  let nextSlot = 0;
  let chunkIdx = 0;
  let burnerSeq = 0;

  const boom = (step: Step) => {
    calls.push(step);
    if (o.fail === step) throw new Error(`${step} exploded`);
  };

  const deps: FulfilmentDeps = {
    hashEmail: (e) => {
      boom("hashEmail");
      return `h(${e})`;
    },
    resolveSiteEventSigner: async () => {
      boom("resolveSiteEventSigner");
      return null;
    },
    getEvent: async () => {
      boom("getEvent");
      return o.event === undefined ? eventFeed() : o.event;
    },
    chainEventEndMs: async () => {
      boom("chainEventEndMs");
      return o.chainEndMs === undefined ? Date.parse(FUTURE) : o.chainEndMs;
    },
    recordHeldPayout: (entry) => {
      boom("recordHeldPayout");
      held.push(entry as unknown as Record<string, unknown>);
    },
    markPayoutVoid: (sessionId) => {
      // Attempt recorded BEFORE the throw: the invariant checks that a full
      // refund always REACHES the void, whether or not the store accepted it.
      voided.push(sessionId);
      boom("markPayoutVoid");
    },
    getOrganiserByStripeAccount: () => {
      boom("getOrganiserByStripeAccount");
      return ORGANISER;
    },
    uploadToBytes: async () => {
      boom("uploadToBytes");
      return "aa".repeat(32);
    },
    downloadFromBytes: async () => {
      boom("downloadFromBytes");
      return JSON.stringify({ v: 2, podRefs: [], manifestDigestHex: "0x", signedManifest: {} });
    },
    generateBurner: () => {
      boom("generateBurner");
      const n = burnerSeq++;
      return {
        address: `0xburner${n}`,
        signMessage: async () => {
          calls.push("signMessage");
          if (o.fail === "signMessage" && n === (o.signFailAt ?? 0)) throw new Error("signMessage exploded");
          return `sig${n}`;
        },
      };
    },
    batchClaimForOnChain: async (_ev, burners) => {
      boom("batchClaimForOnChain");
      const idx = chunkIdx++;
      if (o.revertAtChunk === idx) throw new Error("execution reverted: Insufficient supply");
      minted.push(burners);
      const slots = burners.map(() => nextSlot++);
      return slots;
    },
    onChainBatchMax: o.batchMax ?? 100,
    bindTicket: (b) => {
      boom("bindTicket");
      bindings.push(b as unknown as Record<string, unknown>);
      return true;
    },
    consumeReservation: (id) => {
      boom("consumeReservation");
      consumed.push(id);
      return { quantity: 2 };
    },
    createRefund: async (params, account) => {
      boom("createRefund");
      refunds.push({ params: params as unknown as Record<string, unknown>, account });
      return { id: `re_${refunds.length}` };
    },
    captureCheckoutConsent: (input) => {
      boom("captureCheckoutConsent");
      consents.push(input as unknown as Record<string, unknown>);
    },
    getSiteTheme: async () => {
      boom("getSiteTheme");
      return {
        palette: { bg: "#000", text: "#fff", muted: "#888", accent: "#c7f23a", accentHover: "#b2d92f", border: "#333", cardBg: "#111" },
        contactEmail: "org@example.com",
      };
    },
    sendTicketEmail: async (opts) => {
      calls.push("sendTicketEmail");
      if (o.fail === "sendTicketEmail") throw new Error("renderTicketCardPng exploded");
      if (o.fail === "sendTicketEmailLedgered") {
        // What sendEmail does: write the row, then throw a marked error.
        mailerLedger.push(opts.to);
        const err = new Error("SES MessageRejected") as Error & { ledgered: boolean };
        err.ledgered = true;
        throw err;
      }
      emails.push(opts);
    },
    recordUndeliveredTicket: (input) => {
      boom("recordUndeliveredTicket");
      ledgerRows.push(input);
    },
  };

  return { deps, calls, refunds, emails, ledgerRows, mailerLedger, held, voided, bindings, consents, consumed, minted };
}

/** Units the refund covers: `full` = everything; a partial is pro-rata per unit. */
function refundedUnits(outcome: FulfilmentOutcome, s: FulfilmentSession): number {
  if (outcome.refund.kind !== "created") return 0;
  if (outcome.refund.amount === "full") return outcome.quantity;
  const perUnit = (s.amount_total ?? 0) / outcome.quantity;
  return Math.round(outcome.refund.amount / perUnit);
}

/**
 * The property. Asserted after EVERY run in this suite, including the ones
 * that check something more specific.
 */
function assertInvariant(
  outcome: FulfilmentOutcome,
  s: FulfilmentSession,
  f: ReturnType<typeof fakeDeps>,
): void {
  if (outcome.kind === "skipped") {
    // Not ours to act on: nothing minted, nothing refunded, nothing emailed.
    assert.equal(f.minted.length, 0, "skipped session must not mint");
    assert.equal(f.refunds.length, 0, "skipped session must not refund");
    assert.equal(f.emails.length, 0, "skipped session must not email");
    return;
  }
  // 1. Every paid ticket is issued or refunded (or the refund call itself
  //    failed — #367 — which the outcome names rather than hides).
  const unfilled = outcome.quantity - outcome.issued;
  if (unfilled > 0) {
    assert.ok(outcome.stoppedReason, "unfilled tickets need a stop reason");
    if (outcome.refund.kind === "created") {
      assert.equal(refundedUnits(outcome, s), unfilled, "refund covers exactly the unfilled units");
    } else {
      assert.ok(
        outcome.refund.kind === "failed" || outcome.refund.kind === "no-payment-intent",
        `unfilled=${unfilled} but refund=${JSON.stringify(outcome.refund)}`,
      );
    }
  } else {
    assert.equal(outcome.refund.kind, "not-needed");
  }
  // 2. Every issued ticket is delivered or recorded as undelivered.
  const hasEmail = !!s.metadata?.claimerEmail;
  if (outcome.issued > 0 && hasEmail) {
    const sent = f.emails.length === 1 && f.emails[0].tickets.length === outcome.issued;
    const ledgered = f.ledgerRows.length + f.mailerLedger.length === 1;
    assert.ok(sent !== ledgered, `issued=${outcome.issued}: exactly one of sent (${sent}) / ledgered (${ledgered})`);
    assert.equal(outcome.email, sent ? "sent" : "failed");
  } else if (outcome.issued > 0) {
    assert.equal(outcome.email, "no-address");
  } else {
    assert.equal(outcome.email, "nothing-issued");
    assert.equal(f.emails.length, 0);
  }
  // 3. A full refund voids the payout entry; a partial leaves it held; a
  //    refund that did not land leaves it held too (the money is still there).
  if (outcome.refund.kind === "created" && outcome.issued === 0) {
    assert.deepEqual(f.voided, [s.id], "full refund voids the payout entry");
  } else {
    assert.equal(f.voided.length, 0, "only a landed full refund voids the payout entry");
  }
}

async function run(sessionOpts: SessionOpts = {}, fakeOpts: FakeOpts = {}) {
  const s = session(sessionOpts);
  const f = fakeDeps(fakeOpts);
  const outcome = await fulfilPaidSession(s, PAID_AT, f.deps);
  assertInvariant(outcome, s, f);
  return { s, f, outcome };
}

// ---------------------------------------------------------------------------
// Happy path + ordering
// ---------------------------------------------------------------------------

describe("happy path", () => {
  test("two tickets: held → minted → bound → hold released → emailed, no refund", async () => {
    const { f, outcome } = await run({ wallet: BUYER_WALLET });
    assert.equal(outcome.kind, "processed");
    assert.equal(outcome.issued, 2);
    assert.equal(outcome.stoppedReason, null);
    assert.deepEqual(outcome.refund, { kind: "not-needed" });
    assert.equal(outcome.email, "sent");

    assert.equal(f.held.length, 1);
    assert.equal(f.held[0].sessionId, "cs_test_1");
    assert.equal(f.held[0].stripeAccountId, ACCT);
    assert.equal(f.held[0].grossAmount, 4400);
    assert.equal(f.held[0].paymentIntentId, "pi_1");
    assert.equal(f.held[0].recordedAt, new Date(PAID_AT * 1000).toISOString());

    assert.deepEqual(f.minted, [["0xburner0", "0xburner1"]]);
    // First edition bound to the signed-in buyer; the rest stay bearer.
    assert.equal(f.bindings.length, 1);
    assert.equal(f.bindings[0].edition, 1);
    assert.equal(f.bindings[0].parentAddress, BUYER_WALLET);
    assert.deepEqual(f.consumed, ["res-1"]);

    const mail = f.emails[0];
    assert.equal(mail.to, "buyer@example.com");
    assert.equal(mail.eventTitle, "Test Night");
    assert.equal(mail.buyerName, "Ada Lovelace");
    assert.deepEqual(
      mail.tickets.map((t) => t.edition),
      [1, 2],
    );
    assert.match(mail.tickets[0].qrContent, new RegExp(`^woco://t/${EVENT_ID}/${SERIES_ID}/1/sig0$`));
    assert.equal(mail.replyTo, "org@example.com");
    assert.equal(mail.siteId, "site-1");
    assert.equal(mail.profileCta, true, "multi-ticket order keeps per-ticket links");
    assert.deepEqual(mail.failureContext, { stripeSessionId: "cs_test_1", eventId: EVENT_ID, siteId: "site-1" });

    // Consent: opt-in recorded against the organiser, keyed on the email hash.
    assert.equal(f.consents.length, 1);
    assert.equal(f.consents[0].granted, true);
    assert.equal(f.consents[0].emailHash, "h(buyer@example.com)");
    assert.equal(f.consents[0].organiserAddress, ORGANISER);
  });

  test("ordering: ledger before mint, hold release before refund decision, refund before email", async () => {
    const { f } = await run({}, { revertAtChunk: 0 });
    const idx = (s: string) => f.calls.indexOf(s);
    assert.ok(idx("recordHeldPayout") < idx("batchClaimForOnChain"), "held BEFORE mint");
    assert.ok(idx("consumeReservation") < idx("createRefund"), "hold released BEFORE refund");
    // And on the happy path, the refund step is skipped and email comes after the mint.
    const { f: g } = await run();
    assert.ok(g.calls.indexOf("batchClaimForOnChain") < g.calls.indexOf("sendTicketEmail"));
    assert.ok(g.calls.indexOf("consumeReservation") < g.calls.indexOf("sendTicketEmail"));
    assert.equal(g.calls.includes("createRefund"), false);
  });

  test("single ticket for a signed-in buyer: bound, and the email skips the profile CTA", async () => {
    const { f } = await run({ quantity: 1, wallet: BUYER_WALLET });
    assert.equal(f.bindings.length, 1);
    assert.equal(f.emails[0].profileCta, false);
  });

  test("anonymous email buyer: no binding, profile CTA on", async () => {
    const { f } = await run({ quantity: 1 });
    assert.equal(f.bindings.length, 0);
    assert.equal(f.emails[0].profileCta, true);
  });

  test("wallet-only buyer (no email): first edition bound, nothing to email, nothing ledgered", async () => {
    // Documented behaviour, not a hole: the frontend always sends an email, so
    // this is the shape of a hand-built session. Tickets beyond the first have
    // no carrier — the outcome says so rather than pretending to deliver.
    const { f, outcome } = await run({ email: null, wallet: BUYER_WALLET });
    assert.equal(outcome.issued, 2);
    assert.equal(outcome.email, "no-address");
    assert.equal(f.bindings.length, 1);
    assert.equal(f.ledgerRows.length, 0);
    // And no consent capture without an email hash.
    assert.equal(f.consents.length, 0);
  });

  test("consent: '0' suppresses, absent records nothing", async () => {
    const { f: a } = await run({ consent: "0" });
    assert.equal(a.consents.length, 1);
    assert.equal(a.consents[0].granted, false);
    const { f: b } = await run({ consent: null });
    assert.equal(b.consents.length, 0);
  });

  test("no prefetched orderRef: the fallback seal is uploaded and used", async () => {
    const { f } = await run({ orderRef: null }, { event: eventFeed({ encryptionKey: "ab".repeat(32) }) });
    assert.ok(f.calls.includes("uploadToBytes"));
    assert.equal(f.minted.length, 1);
  });

  test("no orderRef at all (no encryption key to seal with): stops, refunds in full", async () => {
    const { f, outcome } = await run({ orderRef: null });
    assert.equal(outcome.issued, 0);
    assert.equal(outcome.stoppedReason, "No orderRef available for on-chain claim");
    assert.equal(f.minted.length, 0);
    assert.equal(outcome.refund.kind, "created");
  });
});

// ---------------------------------------------------------------------------
// Not ours / cannot act
// ---------------------------------------------------------------------------

describe("skips", () => {
  test("a paid session without eventId/seriesId is not a WoCo sale — nothing happens, including no refund", async () => {
    const { outcome, f } = await run({ noEventKeys: true });
    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.skipReason, "missing eventId/seriesId");
    assert.equal(f.calls.length, 0, "no collaborator is touched");
  });

  test("no claimer identifier: skipped before any side effect", async () => {
    const { outcome, f } = await run({ email: null, wallet: null });
    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.skipReason, "no claimer identifier");
    assert.equal(f.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stop reasons → refund
// ---------------------------------------------------------------------------

describe("stop reasons", () => {
  test("mint reverts: zero issued, FULL refund through the connected account, payout voided, no email", async () => {
    const { f, outcome } = await run({}, { revertAtChunk: 0 });
    assert.equal(outcome.issued, 0);
    assert.match(outcome.stoppedReason!, /Insufficient supply/);
    assert.equal(outcome.refund.kind, "created");
    assert.equal(f.refunds.length, 1);
    assert.equal(f.refunds[0].account, ACCT);
    assert.equal(f.refunds[0].params.amount, undefined, "full refund omits amount");
    assert.equal(f.refunds[0].params.payment_intent, "pi_1");
    // #121: an infrastructure-caused refund returns our fee to the organiser.
    assert.equal(f.refunds[0].params.refund_application_fee, true);
    const md = f.refunds[0].params.metadata as Record<string, string>;
    assert.equal(md.reason, "ticket-claim-failed");
    assert.equal(md.quantityUnfilled, "2");
    assert.deepEqual(f.voided, ["cs_test_1"]);
    assert.equal(f.emails.length, 0);
    assert.equal(outcome.email, "nothing-issued");
    // No ticket landed → no marketing permission left behind.
    assert.equal(f.consents.length, 0);
  });

  test("second chunk reverts: first chunk's tickets emailed, the rest refunded pro-rata, payout stays held", async () => {
    const { f, outcome } = await run({ quantity: 3, amountTotal: 6600 }, { batchMax: 2, revertAtChunk: 1 });
    assert.equal(outcome.issued, 2);
    assert.equal(outcome.refund.kind, "created");
    assert.equal(f.refunds[0].params.amount, 2200, "one unfilled unit of three");
    assert.equal(f.refunds[0].params.refund_application_fee, true, "pro-rata fee return on a partial (#121)");
    assert.equal(f.voided.length, 0);
    assert.equal(f.emails[0].tickets.length, 2);
    assert.deepEqual(f.emails[0].tickets.map((t) => t.edition), [1, 2]);
  });

  test("series not registered on chain: refunded in full without touching the chain", async () => {
    const { f, outcome } = await run(
      {},
      { event: eventFeed({}, { onChainEventId: undefined, swarmManifestRef: undefined }) },
    );
    assert.equal(outcome.stoppedReason, "Series is not registered on chain — no mint path");
    assert.equal(f.calls.includes("batchClaimForOnChain"), false);
    assert.equal(outcome.refund.kind, "created");
    assert.deepEqual(f.voided, ["cs_test_1"]);
  });

  test("event feed says the event has ended: refund without broadcasting", async () => {
    const { f, outcome } = await run({}, { event: eventFeed({ startDate: PAST, endDate: PAST }) });
    assert.equal(outcome.stoppedReason, "Event ended before payment completed — sales closed");
    assert.equal(f.calls.includes("batchClaimForOnChain"), false);
    assert.equal(f.calls.includes("chainEventEndMs"), false, "feed verdict is enough; chain not asked");
    assert.equal(outcome.refund.kind, "created");
  });

  test("chain says sales ended (feed still open): refund without broadcasting", async () => {
    const { f, outcome } = await run({}, { chainEndMs: Date.parse(PAST) });
    assert.equal(outcome.stoppedReason, "Event ended before payment completed — sales closed");
    assert.equal(f.calls.includes("batchClaimForOnChain"), false);
    assert.equal(outcome.refund.kind, "created");
  });

  test("chain end unknown (null): fails OPEN and mints", async () => {
    const { outcome } = await run({}, { chainEndMs: null });
    assert.equal(outcome.issued, 2);
  });

  test("event feed unreadable (null): no v2 path known → refund, never a blind mint", async () => {
    const { f, outcome } = await run({}, { event: null });
    assert.equal(outcome.issued, 0);
    assert.equal(f.calls.includes("batchClaimForOnChain"), false);
    assert.equal(outcome.refund.kind, "created");
  });

  test("stopped with no payment intent on the session: outcome says so, nothing else breaks", async () => {
    const { outcome } = await run({ paymentIntent: null }, { revertAtChunk: 0 });
    assert.deepEqual(outcome.refund, { kind: "no-payment-intent" });
  });
});

// ---------------------------------------------------------------------------
// THE TABLE — every collaborator throws, the property still holds
// ---------------------------------------------------------------------------

describe("every collaborator throws", () => {
  // (step, what the sale must look like afterwards)
  const TABLE: Array<{
    step: Step;
    issued: number;
    refund: FulfilmentOutcome["refund"]["kind"];
    email: FulfilmentOutcome["email"];
    note: string;
  }> = [
    { step: "hashEmail", issued: 2, refund: "not-needed", email: "sent", note: "consent hash is an accessory" },
    { step: "resolveSiteEventSigner", issued: 0, refund: "created", email: "nothing-issued", note: "event feed unread → no v2 path → refund" },
    { step: "getEvent", issued: 0, refund: "created", email: "nothing-issued", note: "same" },
    { step: "chainEventEndMs", issued: 2, refund: "not-needed", email: "sent", note: "fail OPEN" },
    { step: "recordHeldPayout", issued: 2, refund: "not-needed", email: "sent", note: "bookkeeping never fails a paid claim" },
    { step: "getOrganiserByStripeAccount", issued: 2, refund: "not-needed", email: "sent", note: "inside the ledger fence" },
    { step: "downloadFromBytes", issued: 0, refund: "created", email: "nothing-issued", note: "manifest read — see #368" },
    { step: "generateBurner", issued: 0, refund: "created", email: "nothing-issued", note: "unknown throw before the mint" },
    { step: "batchClaimForOnChain", issued: 0, refund: "created", email: "nothing-issued", note: "revert" },
    { step: "bindTicket", issued: 2, refund: "not-needed", email: "sent", note: "the #313 hole — accessory" },
    { step: "consumeReservation", issued: 2, refund: "not-needed", email: "sent", note: "store hiccup" },
    { step: "captureCheckoutConsent", issued: 2, refund: "not-needed", email: "sent", note: "store hiccup" },
    { step: "getSiteTheme", issued: 2, refund: "not-needed", email: "sent", note: "default palette" },
    { step: "sendTicketEmail", issued: 2, refund: "not-needed", email: "failed", note: "never reached the mailer → WE ledger it" },
    { step: "sendTicketEmailLedgered", issued: 2, refund: "not-needed", email: "failed", note: "mailer ledgered it → no second row" },
  ];

  for (const row of TABLE) {
    test(`${row.step} throws — ${row.note}`, async () => {
      const { outcome, f } = await run({ wallet: BUYER_WALLET }, { fail: row.step });
      assert.equal(outcome.kind, "processed");
      assert.equal(outcome.issued, row.issued, "issued");
      assert.equal(outcome.refund.kind, row.refund, "refund");
      assert.equal(outcome.email, row.email, "email");
      if (row.step === "sendTicketEmail") {
        assert.equal(f.ledgerRows.length, 1);
        assert.equal(f.ledgerRows[0].to, "buyer@example.com");
        assert.match(f.ledgerRows[0].error, /never sent: renderTicketCardPng exploded/);
        assert.equal(f.ledgerRows[0].context.stripeSessionId, "cs_test_1");
      }
      if (row.step === "sendTicketEmailLedgered") {
        assert.equal(f.ledgerRows.length, 0, "no duplicate row");
        assert.equal(f.mailerLedger.length, 1);
      }
    });
  }

  test("signMessage throws mid-batch: the signed tickets are emailed, the unsigned remainder refunded", async () => {
    // The chain minted both; the second key was lost before it signed. The
    // buyer gets ticket 1 and their money back for ticket 2. (The second slot
    // is dead supply — unrecoverable, and logged.)
    const { outcome, f } = await run({}, { fail: "signMessage", signFailAt: 1 });
    assert.equal(outcome.issued, 1);
    assert.match(outcome.stoppedReason!, /Fulfilment failed: signMessage exploded/);
    assert.equal(outcome.refund.kind, "created");
    assert.equal(f.refunds[0].params.amount, 2200);
    assert.equal(f.emails[0].tickets.length, 1);
    assert.equal(f.voided.length, 0);
  });

  test("createRefund throws: the outcome names it — buyer still charged (#367 makes it durable)", async () => {
    const { outcome, f } = await run({}, { fail: "createRefund", revertAtChunk: 0 });
    assert.equal(outcome.issued, 0);
    assert.deepEqual(outcome.refund, { kind: "failed", error: "createRefund exploded" });
    assert.equal(f.voided.length, 0, "payout entry must NOT be voided when no refund landed");
    assert.equal(f.emails.length, 0);
  });

  test("markPayoutVoid throws after a successful refund: the refund stands", async () => {
    const { outcome } = await run({}, { fail: "markPayoutVoid", revertAtChunk: 0 });
    assert.equal(outcome.refund.kind, "created");
  });

  test("recordUndeliveredTicket throws too: still resolves, email outcome is failed", async () => {
    // Double fault on the last line of the error path. Nothing left to do but
    // not reject — the outcome is still honest.
    const f = fakeDeps({ fail: "sendTicketEmail" });
    f.deps.recordUndeliveredTicket = () => {
      throw new Error("ledger disk full");
    };
    const outcome = await fulfilPaidSession(session(), PAID_AT, f.deps);
    assert.equal(outcome.email, "failed");
    assert.equal(outcome.issued, 2);
  });

  test("uploadToBytes throws on the fallback seal: stops before the mint, refunds", async () => {
    const { outcome, f } = await run(
      { orderRef: null },
      { event: eventFeed({ encryptionKey: "ab".repeat(32) }), fail: "uploadToBytes" },
    );
    assert.equal(outcome.issued, 0);
    assert.equal(outcome.stoppedReason, "No orderRef available for on-chain claim");
    assert.equal(f.minted.length, 0);
    assert.equal(outcome.refund.kind, "created");
  });
});

// ---------------------------------------------------------------------------
// Never rejects
// ---------------------------------------------------------------------------

test("never rejects, whichever step throws", async () => {
  const steps: Step[] = [
    "hashEmail", "resolveSiteEventSigner", "getEvent", "chainEventEndMs", "recordHeldPayout",
    "getOrganiserByStripeAccount", "uploadToBytes", "downloadFromBytes", "generateBurner",
    "signMessage", "batchClaimForOnChain", "bindTicket", "consumeReservation", "createRefund",
    "markPayoutVoid", "captureCheckoutConsent", "getSiteTheme", "sendTicketEmail",
    "sendTicketEmailLedgered", "recordUndeliveredTicket",
  ];
  for (const step of steps) {
    const f = fakeDeps({ fail: step, revertAtChunk: step === "createRefund" || step === "markPayoutVoid" ? 0 : undefined });
    await assert.doesNotReject(() => fulfilPaidSession(session({ wallet: BUYER_WALLET }), PAID_AT, f.deps), step);
  }
});
