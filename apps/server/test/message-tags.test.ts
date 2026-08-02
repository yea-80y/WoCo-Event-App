/**
 * Per-message tags — the correlation key for an ASYNC delivery failure.
 *
 * These are the properties #99 rests on. If a tag is missing or mangled, a hard
 * bounce arriving minutes after SES said "accepted" cannot be tied back to the
 * order that paid for it, and the ledger entry it produces is either absent or
 * unactionable. The charset rules asserted here are SES's, not ours
 * (API_MessageTag: ASCII letters, digits, `_`, `-`, 256 max, both required).
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMessageTags,
  readMessageTags,
  isLegalTagToken,
  TAG_KIND,
  TAG_CONTEXT_PREFIX,
  MAX_MESSAGE_TAGS,
} from "../src/lib/email/message-tags.js";
import { toSesEmailTags, buildSendEmailInput } from "../src/lib/email/ses-provider.js";
import { EmailSendError, type EmailProvider, type OutboundEmail } from "../src/lib/email/types.js";

process.env.EMAIL_HASH_SECRET = "test-secret-message-tags";

let send: typeof import("../src/lib/email/send.js");
let ledger: typeof import("../src/lib/email/failure-ledger.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-message-tags-test-")));
  send = await import("../src/lib/email/send.js");
  ledger = await import("../src/lib/email/failure-ledger.js");
});

beforeEach(() => {
  ledger._resetForTest();
});

const noSleep = async () => {};

describe("building tags", () => {
  test("the classifier is always present, so a bounce is always classifiable", () => {
    assert.equal(buildMessageTags("transactional")[TAG_KIND], "transactional");
    assert.equal(buildMessageTags("marketing")[TAG_KIND], "marketing");
  });

  test("context becomes namespaced tags", () => {
    const tags = buildMessageTags("transactional", {
      stripeSessionId: "cs_test_a1B2c3",
      eventId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
    assert.equal(tags[`${TAG_CONTEXT_PREFIX}stripeSessionId`], "cs_test_a1B2c3");
    assert.equal(tags[`${TAG_CONTEXT_PREFIX}eventId`], "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  /**
   * `requirement-nudge.ts` sends `context: { kind: "stripe-requirement-nudge" }`.
   * Flattened into one namespace that is a duplicate tag name on every nudge —
   * at best undefined behaviour, at worst a rejected send, and either way the
   * classifier is the thing that gets corrupted.
   */
  test("a context key called `kind` does NOT collide with the classifier", () => {
    const tags = buildMessageTags("transactional", { kind: "stripe-requirement-nudge" });
    assert.equal(tags[TAG_KIND], "transactional");
    assert.equal(tags[`${TAG_CONTEXT_PREFIX}kind`], "stripe-requirement-nudge");
    assert.equal(new Set(Object.keys(tags)).size, Object.keys(tags).length);
  });

  test("a recipient-identifying value is refused, not encoded", () => {
    const tags = buildMessageTags("marketing", {
      buyer: "someone@example.com",
      emailHash: "a".repeat(64),
      organiser: "0xAbCd000000000000000000000000000000000011",
    });
    assert.equal(tags[`${TAG_CONTEXT_PREFIX}buyer`], undefined);
    assert.equal(tags[`${TAG_CONTEXT_PREFIX}emailHash`], undefined);
    assert.equal(
      tags[`${TAG_CONTEXT_PREFIX}organiser`],
      "0xAbCd000000000000000000000000000000000011",
      "a wallet address is not recipient plaintext and stays",
    );
  });

  test("values SES cannot carry are dropped rather than mangled", () => {
    const tags = buildMessageTags("transactional", {
      spaced: "has spaces",
      dotted: "a.b.c",
      colon: "ns:value",
      ok: "plain-value_1",
    });
    assert.deepEqual(Object.keys(tags).sort(), [`${TAG_CONTEXT_PREFIX}ok`, TAG_KIND].sort());
  });

  test("the tag count is bounded and the classifier survives the cap", () => {
    const context: Record<string, string> = {};
    for (let i = 0; i < 40; i++) context[`k${i}`] = `v${i}`;
    const tags = buildMessageTags("transactional", context);
    assert.equal(Object.keys(tags).length, MAX_MESSAGE_TAGS);
    assert.equal(tags[TAG_KIND], "transactional");
  });

  test("an over-long value is refused (SES caps both name and value at 256)", () => {
    assert.equal(isLegalTagToken("a".repeat(256)), true);
    assert.equal(isLegalTagToken("a".repeat(257)), false);
    assert.equal(isLegalTagToken(""), false);
  });
});

describe("reading tags back off an event", () => {
  test("SES returns every tag value as an ARRAY, even single-valued ones", () => {
    const decoded = readMessageTags({
      "ses:configuration-set": ["woco-events"],
      [TAG_KIND]: ["transactional"],
      [`${TAG_CONTEXT_PREFIX}eventId`]: ["abc-123"],
    });
    assert.equal(decoded.kind, "transactional");
    assert.deepEqual(decoded.context, { eventId: "abc-123" });
  });

  test("provider-owned ses:* tags never leak into the ledger context", () => {
    const decoded = readMessageTags({
      "ses:source-ip": ["192.0.2.0"],
      "ses:caller-identity": ["woco"],
      [TAG_KIND]: ["marketing"],
    });
    assert.deepEqual(decoded.context, {});
  });

  /**
   * An unrecognised classifier must not be coerced. Guessing "transactional"
   * would store a marketing recipient's plaintext against the PLAINTEXT POLICY;
   * guessing the other way would silence a real ticket alarm. Neither guess is
   * ours to make, so it takes the untagged path.
   */
  test("an unknown classifier value yields no kind at all", () => {
    assert.equal(readMessageTags({ [TAG_KIND]: ["something-else"] }).kind, null);
    assert.equal(readMessageTags({}).kind, null);
    assert.equal(readMessageTags(undefined).kind, null);
    assert.equal(readMessageTags("not an object").kind, null);
  });

  test("what buildMessageTags writes, readMessageTags recovers", () => {
    const context = { stripeSessionId: "cs_live_XYZ_123", eventId: "3f2504e0-4f89-11d3" };
    const decoded = readMessageTags(
      Object.fromEntries(
        Object.entries(buildMessageTags("transactional", context)).map(([k, v]) => [k, [v]]),
      ),
    );
    assert.equal(decoded.kind, "transactional");
    assert.deepEqual(decoded.context, context);
  });
});

describe("the SES mapping", () => {
  test("tags reach EmailTags on the request", () => {
    const input = buildSendEmailInput({
      from: "a@woco-net.com",
      to: ["b@example.com"],
      subject: "Your ticket",
      html: "<p>hi</p>",
      tags: { [TAG_KIND]: "transactional", [`${TAG_CONTEXT_PREFIX}eventId`]: "abc-123" },
    });
    assert.deepEqual(input.EmailTags, [
      { Name: TAG_KIND, Value: "transactional" },
      { Name: `${TAG_CONTEXT_PREFIX}eventId`, Value: "abc-123" },
    ]);
  });

  test("a message with no tags sends no EmailTags key", () => {
    const input = buildSendEmailInput({
      from: "a@woco-net.com",
      to: ["b@example.com"],
      subject: "s",
      text: "t",
    });
    assert.equal("EmailTags" in input, false);
  });

  /**
   * The opposite choice to `toSesHeaders`, which throws. A dropped
   * `List-Unsubscribe` is a compliance breach; a dropped breadcrumb is a
   * degraded diagnostic. Only one of those is worth failing a paid buyer's
   * ticket over.
   */
  test("an illegal tag is DROPPED, never thrown — the ticket still sends", () => {
    assert.doesNotThrow(() => toSesEmailTags({ "bad name": "v", ok: "v" }));
    assert.deepEqual(toSesEmailTags({ "bad name": "v", ok: "v" }), [{ Name: "ok", Value: "v" }]);
    assert.deepEqual(toSesEmailTags({ ok: "has spaces" }), []);
  });
});

describe("the send path stamps them", () => {
  /** Captures what the provider was actually asked to send. */
  function capturing(fail: boolean) {
    const seen: OutboundEmail[] = [];
    const provider: EmailProvider = {
      name: "ses",
      async send(msg) {
        seen.push(msg);
        if (fail) throw new EmailSendError("nope", { retryable: false });
      },
    };
    return { provider, seen };
  }

  const MSG: OutboundEmail = {
    from: '"Acme" <events@woco-net.com>',
    to: ["buyer@example.com"],
    subject: "Your ticket",
    html: "<p>ticket</p>",
  };

  test("priority becomes the classifier and context becomes breadcrumbs", async () => {
    const { provider, seen } = capturing(false);
    await send.sendVia({ primary: provider, secondary: null, sleep: noSleep }, MSG, {
      priority: "transactional",
      context: { stripeSessionId: "cs_test_1", eventId: "evt-1" },
    });
    assert.equal(seen[0]?.tags?.[TAG_KIND], "transactional");
    assert.equal(seen[0]?.tags?.[`${TAG_CONTEXT_PREFIX}stripeSessionId`], "cs_test_1");
  });

  test("marketing is tagged marketing", async () => {
    const { provider, seen } = capturing(false);
    await send.sendVia({ primary: provider, secondary: null, sleep: noSleep }, MSG, {
      priority: "marketing",
    });
    assert.equal(seen[0]?.tags?.[TAG_KIND], "marketing");
  });

  test("the caller's message object is not mutated", async () => {
    const { provider } = capturing(false);
    const msg: OutboundEmail = { ...MSG };
    await send.sendVia({ primary: provider, secondary: null, sleep: noSleep }, msg);
    assert.equal(msg.tags, undefined);
  });

  /**
   * The drain worker re-sends the message it queued. Recomputing tags on that
   * path would drop `context`, so a retried ticket that is accepted and then
   * bounces would come back classifiable but with no idea which order it was.
   */
  test("a queued retry keeps the ORIGINAL context tags", async () => {
    const failing = capturing(true);
    await assert.rejects(
      send.sendVia({ primary: failing.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        context: { stripeSessionId: "cs_test_keepme" },
      }),
    );

    const succeeding = capturing(false);
    // The retry path sends the stored message with no `context` in scope.
    await send.sendVia(
      { primary: succeeding.provider, secondary: null, sleep: noSleep },
      failing.seen[0]!,
      { noLedger: true },
    );
    assert.equal(
      succeeding.seen[0]?.tags?.[`${TAG_CONTEXT_PREFIX}stripeSessionId`],
      "cs_test_keepme",
    );
  });
});
