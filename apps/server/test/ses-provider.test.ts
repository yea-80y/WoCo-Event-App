/**
 * SESv2 request mapping.
 *
 * Every limit asserted here is one SES enforces server-side, so the failure
 * these tests prevent is a `BadRequestException` in production on a message
 * that looked fine locally. The inline-attachment case is the important one:
 * `ContentDisposition: INLINE` + `ContentId` is what makes `cid:woco-card-0`
 * resolve, and if it regressed to ATTACHMENT the ticket QR would silently stop
 * rendering in the body while the email still "sent" successfully.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  buildSendEmailInput,
  encodeFromAddress,
  toSesHeaders,
  classifySesError,
  getSesClient,
  _resetSesClientForTest,
} from "../src/lib/email/ses-provider.js";
import { EmailSendError, type OutboundEmail } from "../src/lib/email/types.js";

const base: OutboundEmail = {
  from: '"Acme Events" <events@woco-net.com>',
  to: ["buyer@example.com"],
  subject: "Your ticket",
  html: "<p>hi</p>",
  text: "hi",
};

describe("encodeFromAddress", () => {
  test("keeps a plain ASCII display name quoted", () => {
    assert.equal(encodeFromAddress('"Acme" <a@b.com>'), '"Acme" <a@b.com>');
  });

  test("accepts an unquoted display name", () => {
    assert.equal(encodeFromAddress("Acme <a@b.com>"), '"Acme" <a@b.com>');
  });

  test("passes a bare address through", () => {
    assert.equal(encodeFromAddress("a@b.com"), "a@b.com");
  });

  test("RFC 2047-encodes a non-ASCII display name", () => {
    // Organiser-supplied event titles are free text, so "Café" is ordinary
    // input. Sent raw, SES rejects the header.
    const out = encodeFromAddress('"Café Night" <a@b.com>');
    assert.equal(out, `=?UTF-8?B?${Buffer.from("Café Night", "utf-8").toString("base64")}?= <a@b.com>`);
    assert.match(out, /^=\?UTF-8\?B\?.+\?= <a@b\.com>$/);
  });

  test("neutralises a quote inside the display name", () => {
    // Otherwise the display name closes its own quoted string early.
    assert.equal(encodeFromAddress('"He said "hi"" <a@b.com>').includes('""'), false);
  });

  test("drops an empty display name rather than sending empty quotes", () => {
    assert.equal(encodeFromAddress('"" <a@b.com>'), "a@b.com");
  });
});

describe("buildSendEmailInput", () => {
  test("maps the basic message onto Simple content", () => {
    const input = buildSendEmailInput(base);
    assert.equal(input.FromEmailAddress, '"Acme Events" <events@woco-net.com>');
    assert.deepEqual(input.Destination.ToAddresses, ["buyer@example.com"]);
    assert.equal(input.Content.Simple.Subject.Data, "Your ticket");
    assert.equal(input.Content.Simple.Subject.Charset, "UTF-8");
    assert.equal(input.Content.Simple.Body.Html?.Data, "<p>hi</p>");
    assert.equal(input.Content.Simple.Body.Text?.Data, "hi");
  });

  test("omits ReplyToAddresses when there is no reply-to", () => {
    assert.equal("ReplyToAddresses" in buildSendEmailInput(base), false);
  });

  test("includes ReplyToAddresses when set", () => {
    const input = buildSendEmailInput({ ...base, replyTo: ["organiser@venue.com"] });
    assert.deepEqual(input.ReplyToAddresses, ["organiser@venue.com"]);
  });

  test("an attachment with a contentId is INLINE — this is what makes cid: resolve", () => {
    const input = buildSendEmailInput({
      ...base,
      attachments: [
        {
          filename: "ticket-001.png",
          content: Buffer.from("PNGDATA"),
          contentId: "woco-card-0",
          contentType: "image/png",
        },
      ],
    });
    const att = input.Content.Simple.Attachments?.[0];
    assert.ok(att);
    assert.equal(att.ContentDisposition, "INLINE");
    assert.equal(att.ContentId, "woco-card-0");
    assert.equal(att.ContentType, "image/png");
    assert.equal(att.FileName, "ticket-001.png");
    assert.equal(att.ContentTransferEncoding, "BASE64");
    // The SDK base64-encodes RawContent; we must hand it the raw bytes.
    assert.deepEqual(Buffer.from(att.RawContent as Uint8Array), Buffer.from("PNGDATA"));
  });

  test("an attachment without a contentId is a normal ATTACHMENT", () => {
    const input = buildSendEmailInput({
      ...base,
      attachments: [{ filename: "receipt.pdf", content: Buffer.from("PDF") }],
    });
    assert.equal(input.Content.Simple.Attachments?.[0]?.ContentDisposition, "ATTACHMENT");
  });

  test("rejects more than 50 recipients — the SES per-message quota", () => {
    const to = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    assert.throws(() => buildSendEmailInput({ ...base, to }), (err: unknown) => {
      assert.ok(err instanceof EmailSendError);
      assert.equal(err.retryable, false);
      assert.match(err.message, /51 recipients exceeds/);
      return true;
    });
  });

  test("rejects a message over the 40MB post-base64 limit", () => {
    // 30MB raw becomes ~40MB base64 — accepted locally, rejected by SES.
    assert.throws(
      () =>
        buildSendEmailInput({
          ...base,
          attachments: [{ filename: "big.bin", content: Buffer.alloc(30 * 1024 * 1024) }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof EmailSendError);
        assert.equal(err.retryable, false);
        assert.match(err.message, /40MB/);
        return true;
      },
    );
  });

  test("rejects a ContentId over 78 chars", () => {
    assert.throws(
      () =>
        buildSendEmailInput({
          ...base,
          attachments: [
            { filename: "a.png", content: Buffer.from("x"), contentId: "c".repeat(79) },
          ],
        }),
      /ContentId exceeds/,
    );
  });

  test("rejects a FileName over 255 chars", () => {
    assert.throws(
      () =>
        buildSendEmailInput({
          ...base,
          attachments: [{ filename: `${"a".repeat(252)}.png`, content: Buffer.from("x") }],
        }),
      /FileName exceeds/,
    );
  });
});

describe("toSesHeaders", () => {
  test("maps the RFC 8058 unsubscribe headers", () => {
    const headers = toSesHeaders({
      "List-Unsubscribe": "<https://api.example.com/u/tok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    assert.deepEqual(headers, [
      { Name: "List-Unsubscribe", Value: "<https://api.example.com/u/tok>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  test("drops headers SES composes itself rather than duplicating them", () => {
    assert.deepEqual(toSesHeaders({ From: "x@y.com", Subject: "nope", "Return-Path": "z@y.com" }), []);
  });

  test("throws on a header name containing a colon", () => {
    // Would otherwise smuggle a second header into the value.
    assert.throws(() => toSesHeaders({ "Bad:Name": "v" }), /Header name is not valid/);
  });

  test("throws on a non-ASCII header value", () => {
    assert.throws(() => toSesHeaders({ "X-Test": "café" }), /Header value is not valid/);
  });

  test("throws when name + value exceed the combined 996-char limit", () => {
    assert.throws(() => toSesHeaders({ "X-Test": "v".repeat(991) }), /combined 996-char limit/);
  });

  test("accepts a value at exactly the 995-char limit", () => {
    const headers = toSesHeaders({ X: "v".repeat(995) });
    assert.equal(headers[0]?.Value.length, 995);
  });
});

describe("classifySesError", () => {
  const permanent = [
    "MessageRejected",
    "BadRequestException",
    "AccountSuspendedException",
    "MailFromDomainNotVerifiedException",
    "SendingPausedException",
    "NotFoundException",
    "LimitExceededException",
  ];

  for (const name of permanent) {
    test(`${name} is permanent — retrying cannot help`, () => {
      const err = classifySesError({ name, message: "nope", $metadata: { httpStatusCode: 400 } });
      assert.equal(err.retryable, false);
      assert.equal(err.code, name);
    });
  }

  test("TooManyRequestsException is retryable — this is the 14/s ceiling", () => {
    const err = classifySesError({
      name: "TooManyRequestsException",
      message: "Maximum sending rate exceeded",
      $metadata: { httpStatusCode: 429 },
    });
    assert.equal(err.retryable, true);
  });

  test("a 5xx is retryable", () => {
    const err = classifySesError({ name: "InternalServerError", message: "boom", $metadata: { httpStatusCode: 500 } });
    assert.equal(err.retryable, true);
  });

  test("an unrecognised error defaults to retryable", () => {
    // Deliberate bias: one wasted retry costs a request, giving up on a
    // deliverable message costs a ticket.
    assert.equal(classifySesError(new Error("socket hang up")).retryable, true);
  });

  test("an already-classified EmailSendError passes through unchanged", () => {
    const original = new EmailSendError("local guard", { retryable: false });
    assert.equal(classifySesError(original), original);
  });
});

/**
 * The SDK's retry configuration is not a style preference here: it is what
 * decides whether a broadcast can delay a paid buyer's ticket.
 */
describe("SDK retry configuration", () => {
  before(() => {
    process.env.AWS_REGION = process.env.AWS_REGION || "eu-west-2";
    _resetSesClientForTest();
  });

  test("uses standard retry, never adaptive", async () => {
    // Adaptive mode's rate limiter is per-CLIENT and can delay the INITIAL
    // request. One client serves ticket email and broadcasts, so adaptive would
    // let a marketing throttle stall transactional mail underneath the priority
    // queue in rate-limiter.ts. AWS: "Adaptive mode is not recommended as a
    // general default."
    // Assert on the strategy the SDK actually resolved, not the string we
    // passed in — an unrecognised mode would silently fall back.
    const strategy = await getSesClient().config.retryStrategy();
    assert.equal((strategy as { mode?: string }).mode, "standard");
    assert.equal(strategy.constructor.name, "StandardRetryStrategy");
  });

  test("leaves retrying to send.ts rather than doing it twice", async () => {
    // Two retriers compose multiplicatively: the ledger would record 3 attempts
    // for a message the provider was called 9 times about, and the token bucket
    // would never see the calls the SDK absorbed.
    assert.equal(await getSesClient().config.maxAttempts(), 1);
  });
});
