/**
 * Marketing must fail closed when the platform marketing from-address is unset (#96).
 *
 * The property being defended is one sentence: a marketing send never goes out
 * from the address that delivers tickets.
 *
 * WoCo permanently has two organiser classes. One has a verified sending domain
 * of its own; the other — every platform-tier organiser — relies on WoCo's
 * address, and they ALL share that single sending reputation. So the three
 * lanes must stay separate: transactional (tickets, receipts), platform
 * marketing, and the organiser's own domain. The bug this file locks shut was a
 * silent third hop, `getMarketingFromAddress()` → `getFromAddress()`, which put
 * imported cold-list mail — the highest-complaint traffic there is — on the
 * ticket-delivery domain, where a burned reputation means event-day tickets
 * land in spam.
 *
 * The event lane is deliberately asymmetric and is asserted here too, so that a
 * future change which "fixes the inconsistency" fails a test that explains why
 * the inconsistency is intended.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-marketing-from";

const ORG = "0xAbCd000000000000000000000000000000000001";

let client: typeof import("../src/lib/email/client.js");
let store: typeof import("../src/lib/marketing/sending-domain-store.js");
let jobs: typeof import("../src/lib/email/broadcast-jobs.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-marketing-from-test-")));
  client = await import("../src/lib/email/client.js");
  store = await import("../src/lib/marketing/sending-domain-store.js");
  jobs = await import("../src/lib/email/broadcast-jobs.js");
});

/** Every env key that can name a from-address, cleared between cases. */
function clearFromEnv(): void {
  delete process.env.EMAIL_FROM_MARKETING;
  delete process.env.RESEND_FROM_MARKETING;
  delete process.env.EMAIL_FROM;
  delete process.env.RESEND_FROM;
}

beforeEach(() => {
  clearFromEnv();
  store.deleteDomain(ORG);
});

// ── getMarketingFromAddress: presence, not plausibility ────────────────────

describe("getMarketingFromAddress", () => {
  test("returns null when nothing is configured", () => {
    assert.equal(client.getMarketingFromAddress(), null);
  });

  /**
   * The production shape on the day this was written: the key is PRESENT in
   * apps/server/.env with an empty value. A `!== undefined` guard would have
   * read that as configured and sent anyway.
   */
  test("an empty value is unset, not configured", () => {
    process.env.EMAIL_FROM_MARKETING = "";
    assert.equal(client.getMarketingFromAddress(), null);
  });

  test("a whitespace-only value is unset, not configured", () => {
    process.env.EMAIL_FROM_MARKETING = "   \t ";
    assert.equal(client.getMarketingFromAddress(), null);
  });

  test("a configured address is returned trimmed", () => {
    process.env.EMAIL_FROM_MARKETING = "  news@news.woco-net.com  ";
    assert.equal(client.getMarketingFromAddress(), "news@news.woco-net.com");
  });

  test("the legacy Resend name still works, so the SES cutover needed no rename", () => {
    process.env.RESEND_FROM_MARKETING = "news@news.woco-net.com";
    assert.equal(client.getMarketingFromAddress(), "news@news.woco-net.com");
  });

  test("the provider-neutral name wins over the legacy one", () => {
    process.env.EMAIL_FROM_MARKETING = "new@news.woco-net.com";
    process.env.RESEND_FROM_MARKETING = "old@news.woco-net.com";
    assert.equal(client.getMarketingFromAddress(), "new@news.woco-net.com");
  });

  /** The regression itself. This assertion is the whole point of the file. */
  test("NEVER falls back to the transactional address", () => {
    process.env.EMAIL_FROM = "events@woco-net.com";
    assert.equal(client.getFromAddress(), "events@woco-net.com");
    assert.equal(client.getMarketingFromAddress(), null);
  });
});

// ── resolveMarketingFrom: the organiser's own domain is the only rescue ────

describe("resolveMarketingFrom", () => {
  function putDomain(status: string): void {
    store.putDomain(ORG, {
      resendDomainId: "d_1",
      domain: "mail.venue.com",
      fromLocalPart: "news",
      status,
      records: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }

  test("a verified organiser domain answers even when the platform address is unset", () => {
    putDomain("verified");
    assert.equal(store.resolveMarketingFrom(ORG), "news@mail.venue.com");
  });

  test("the organiser's domain beats the platform address", () => {
    process.env.EMAIL_FROM_MARKETING = "news@news.woco-net.com";
    putDomain("verified");
    assert.equal(store.resolveMarketingFrom(ORG), "news@mail.venue.com");
  });

  /**
   * Unverified means SES/Resend has no DKIM identity for it, so sending from it
   * would be rejected outright. A pending domain must not read as a rescue.
   */
  test("a pending domain does not rescue an unset platform address", () => {
    putDomain("pending");
    assert.equal(store.resolveMarketingFrom(ORG), null);
  });

  test("no domain and no platform address is a refusal", () => {
    assert.equal(store.resolveMarketingFrom(ORG), null);
  });

  /**
   * Exhaustive over the ways the platform address can be absent. Any future
   * re-introduction of a transactional fallback — in either function — trips
   * every case here at once.
   */
  test("no unconfigured state resolves to the transactional address", () => {
    for (const absent of [undefined, "", "   "]) {
      clearFromEnv();
      process.env.EMAIL_FROM = "events@woco-net.com";
      if (absent !== undefined) {
        process.env.EMAIL_FROM_MARKETING = absent;
        process.env.RESEND_FROM_MARKETING = absent;
      }
      const resolved = store.resolveMarketingFrom(ORG);
      assert.equal(resolved, null, `marketing resolved to "${resolved}" with platform address ${JSON.stringify(absent)}`);
      assert.notEqual(resolved, client.getFromAddress());
    }
  });
});

// ── The event lane keeps the fallback, on purpose ──────────────────────────

describe("the event lane", () => {
  /**
   * `routes/broadcast-jobs.ts` spells this fallback out at the call site:
   * `resolveMarketingFrom(org) ?? getFromAddress()`.
   *
   * These recipients consented by buying a ticket, so complaint risk is near
   * zero, and the message is "the venue moved" or "the event is cancelled" —
   * mail an organiser must be able to send whatever state WoCo's marketing env
   * is in. Refusing here would convert a platform config gap into attendee harm.
   */
  test("falls back to the transactional address rather than refusing", () => {
    process.env.EMAIL_FROM = "events@woco-net.com";
    const eventLane = store.resolveMarketingFrom(ORG) ?? client.getFromAddress();
    assert.equal(eventLane, "events@woco-net.com");
  });

  test("still prefers a configured marketing address over the transactional one", () => {
    process.env.EMAIL_FROM = "events@woco-net.com";
    process.env.EMAIL_FROM_MARKETING = "news@news.woco-net.com";
    const eventLane = store.resolveMarketingFrom(ORG) ?? client.getFromAddress();
    assert.equal(eventLane, "news@news.woco-net.com");
  });
});

// ── A job cannot be created without a sender ──────────────────────────────

describe("createJob", () => {
  beforeEach(() => {
    jobs._resetForTest();
  });

  /**
   * The route refuses before reaching here, so this is the backstop for the
   * coercion that would quietly undo it — `resolveMarketingFrom(org) ?? ""`.
   * Failing at create keeps the organiser's draft intact; failing at drain
   * would mean recipients already encrypted to disk and a "queued" they were
   * already told about.
   */
  for (const [label, fromAddress] of [
    ["empty", ""],
    ["whitespace-only", "  "],
  ] as const) {
    test(`refuses a ${label} fromAddress`, () => {
      assert.throws(
        () =>
          jobs.createJob({
            org: ORG,
            kind: "marketing",
            subject: "s",
            html: "<p>h</p>",
            fromDisplayName: "Venue",
            fromAddress,
          }),
        /fromAddress is required/,
      );
    });
  }

  test("accepts a real address", () => {
    const job = jobs.createJob({
      org: ORG,
      kind: "marketing",
      subject: "s",
      html: "<p>h</p>",
      fromDisplayName: "Venue",
      fromAddress: "news@news.woco-net.com",
    });
    assert.equal(job.fromAddress, "news@news.woco-net.com");
  });
});

// ── The alarm an operator reads ───────────────────────────────────────────

describe("marketingSenderHealth", () => {
  test("is not ok while the platform marketing address is unset", () => {
    const health = client.marketingSenderHealth();
    assert.equal(health.ok, false);
    assert.match(health.reason ?? "", /EMAIL_FROM_MARKETING/, "names the key to set");
  });

  test("is ok once configured", () => {
    process.env.EMAIL_FROM_MARKETING = "news@news.woco-net.com";
    assert.deepEqual(client.marketingSenderHealth(), { ok: true });
  });

  /** /api/health is public — the flag is actionable, the address is nobody's business. */
  test("never leaks the address on a public endpoint", () => {
    process.env.EMAIL_FROM_MARKETING = "secret-alias@news.woco-net.com";
    assert.doesNotMatch(JSON.stringify(client.marketingSenderHealth()), /secret-alias/);
    clearFromEnv();
    process.env.EMAIL_FROM = "events@woco-net.com";
    assert.doesNotMatch(JSON.stringify(client.marketingSenderHealth()), /events@woco-net\.com/);
  });
});

// ── The refusal the organiser actually reads ──────────────────────────────

describe("MARKETING_SENDER_UNCONFIGURED", () => {
  /**
   * `apps/web/src/lib/api/broadcasts.ts` rethrows the response `error` and
   * drops `code`, so this string is the entire explanation the organiser gets.
   * It has to say that nothing was sent, and that it is not their fault.
   */
  test("tells the organiser nothing was sent and it is not their account", () => {
    const msg = store.MARKETING_SENDER_UNCONFIGURED;
    assert.match(msg, /nothing was sent/i);
    assert.match(msg, /not a problem with your account/i);
    assert.doesNotMatch(msg, /EMAIL_FROM_MARKETING|env|null/i, "written for an organiser, not an operator");
  });
});
