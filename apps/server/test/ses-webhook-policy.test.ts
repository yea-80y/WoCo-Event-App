/**
 * The bounce/complaint suppression POLICY at the route.
 *
 * `sns-verify.test.ts` proves a forged event cannot get in. This proves that a
 * genuine one has the right effect — which is a separate and equally expensive
 * mistake to get wrong in either direction:
 *
 *   - suppressing a `Transient` bounce (a full mailbox) permanently blocks a
 *     real attendee, so they never receive a ticket again;
 *   - failing to suppress a `Permanent` bounce or a complaint is what gets the
 *     sending domain blocked by Gmail, taking down ticket delivery for everyone.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";

process.env.EMAIL_HASH_SECRET = "test-secret-ses-webhook";
const TOPIC = "arn:aws:sns:eu-west-2:123456789012:woco-ses-events";
process.env.SES_SNS_TOPIC_ARN = TOPIC;

const CERT_URL = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-test.pem";
const ORG = "0xAbCd000000000000000000000000000000000011";

let privateKeyPem: string;
let certPem: string;
let route: typeof import("../src/routes/ses-webhook.js");
let suppression: typeof import("../src/lib/marketing/suppression-store.js");
let hashEmail: (typeof import("../src/lib/event/claim-service.js"))["hashEmail"];
let snsVerify: typeof import("../src/lib/email/sns-verify.js");
let consumed: typeof import("../src/lib/email/consumed-sns-events.js");
let ledger: typeof import("../src/lib/email/failure-ledger.js");
let tags: typeof import("../src/lib/email/message-tags.js");

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-ses-webhook-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "3650", "-nodes", "-subj", "/CN=sns.eu-west-2.amazonaws.com"],
    { stdio: "ignore" },
  );
  privateKeyPem = readFileSync(keyPath, "utf-8");
  certPem = readFileSync(certPath, "utf-8");

  // Stores write .data/ relative to cwd — chdir BEFORE importing them.
  process.chdir(mkdtempSync(join(tmpdir(), "woco-ses-webhook-test-")));

  // The route fetches the signing certificate; serve ours instead of the network.
  globalThis.fetch = (async () => new Response(certPem, { status: 200 })) as unknown as typeof fetch;

  route = await import("../src/routes/ses-webhook.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
  snsVerify = await import("../src/lib/email/sns-verify.js");
  consumed = await import("../src/lib/email/consumed-sns-events.js");
  ledger = await import("../src/lib/email/failure-ledger.js");
  tags = await import("../src/lib/email/message-tags.js");
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

beforeEach(() => {
  snsVerify._clearCertCacheForTest();
  consumed._resetForTest();
  ledger._resetForTest();
  route._resetUntaggedWarningForTest();
});

let messageSeq = 0;

/** Post a genuinely-signed SES event through the real route. */
async function post(sesEvent: unknown, messageId?: string): Promise<Response> {
  const envelope: Record<string, unknown> = {
    Type: "Notification",
    MessageId: messageId ?? `msg-${messageSeq++}`,
    TopicArn: TOPIC,
    Message: JSON.stringify(sesEvent),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
  };
  const signer = createSign("RSA-SHA256");
  signer.update(snsVerify.buildStringToSign(envelope), "utf-8");
  signer.end();
  envelope.Signature = signer.sign(privateKeyPem, "base64");

  return route.sesWebhook.request("/webhook", {
    method: "POST",
    body: JSON.stringify(envelope),
    headers: { "content-type": "text/plain" },
  });
}

const bounce = (type: string, subType: string, email: string) => ({
  eventType: "Bounce",
  bounce: { bounceType: type, bounceSubType: subType, bouncedRecipients: [{ emailAddress: email }] },
});

describe("bounce policy", () => {
  test("a Permanent bounce suppresses globally", async () => {
    const email = "dead@example.com";
    const res = await post(bounce("Permanent", "NoEmail", email));
    assert.equal(res.status, 200);
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
  });

  test("a Permanent/Suppressed bounce also suppresses", async () => {
    const email = "onlist@example.com";
    await post(bounce("Permanent", "Suppressed", email));
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
  });

  test("a Transient MailboxFull bounce does NOT suppress", async () => {
    // A full inbox is temporary. Blocking it permanently means this attendee
    // never receives a ticket again.
    const email = "full@example.com";
    const res = await post(bounce("Transient", "MailboxFull", email));
    assert.equal(res.status, 200);
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), false);
  });

  test("a Transient General bounce does NOT suppress", async () => {
    const email = "temp@example.com";
    await post(bounce("Transient", "General", email));
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), false);
  });

  test("an Undetermined bounce does NOT suppress", async () => {
    // Guessing towards a permanent block is the expensive direction to be wrong.
    const email = "unknown@example.com";
    await post(bounce("Undetermined", "Undetermined", email));
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), false);
  });
});

describe("complaint policy", () => {
  test("any complaint suppresses globally", async () => {
    const email = "angry@example.com";
    await post({
      eventType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: "abuse" },
    });
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
  });

  test("a complaint with no feedback type still suppresses", async () => {
    // The person said stop; the ISP's classification does not change that.
    const email = "quiet@example.com";
    await post({ eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: email }] } });
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
  });
});

describe("event handling", () => {
  test("the legacy notificationType shape is handled too", async () => {
    // Identity-level notifications use `notificationType`, config-set event
    // destinations use `eventType`. The setup choice must not disable suppression.
    const email = "legacy@example.com";
    await post({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: email }] },
    });
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
  });

  test("a Delivery event is acknowledged and suppresses nothing", async () => {
    const res = await post({ eventType: "Delivery", delivery: { recipients: ["ok@example.com"] } });
    assert.equal(res.status, 200);
    assert.equal(suppression.isSuppressed(hashEmail("ok@example.com"), ORG), false);
  });

  test("a redelivered event is deduped", async () => {
    const id = "duplicate-message-id";
    const first = await post(bounce("Permanent", "General", "dup@example.com"), id);
    const second = await post(bounce("Permanent", "General", "dup@example.com"), id);
    assert.equal((await first.json() as { data: { suppressed: number } }).data.suppressed, 1);
    assert.deepEqual((await second.json() as { data: unknown }).data, { deduped: true });
  });

  test("an unsigned request is refused", async () => {
    const res = await route.sesWebhook.request("/webhook", {
      method: "POST",
      body: JSON.stringify({ Type: "Notification", TopicArn: TOPIC, MessageId: "x" }),
      headers: { "content-type": "text/plain" },
    });
    assert.equal(res.status, 403);
  });

  test("a malformed body is refused", async () => {
    const res = await route.sesWebhook.request("/webhook", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    assert.equal(res.status, 400);
  });
});

/**
 * #99 — the async half of silent ticket loss.
 *
 * SES ACCEPTS a message to a typo'd address and hard-bounces it minutes later.
 * `send()` resolved, so nothing retried and nothing was ledgered: the buyer paid
 * and the first anyone knew was the door. These assert the record now exists,
 * carries the order it belongs to, and respects the PLAINTEXT POLICY split.
 */
describe("the failure ledger (#99)", () => {
  /** A bounce shaped like the real event: `mail` block, tags and all. */
  function bounceEvent(opts: {
    email: string;
    kind?: "transactional" | "marketing";
    context?: Record<string, string>;
    bounceType?: string;
    subType?: string;
    diagnosticCode?: string;
    messageId?: string;
    subject?: string;
  }) {
    const emailTags: Record<string, string[]> = {
      "ses:configuration-set": ["woco-events"],
      "ses:source-ip": ["192.0.2.0"],
    };
    if (opts.kind) {
      for (const [k, v] of Object.entries(tags.buildMessageTags(opts.kind, opts.context))) {
        emailTags[k] = [v];
      }
    }
    return {
      eventType: "Bounce",
      bounce: {
        bounceType: opts.bounceType ?? "Permanent",
        bounceSubType: opts.subType ?? "General",
        bouncedRecipients: [
          {
            emailAddress: opts.email,
            action: "failed",
            status: "5.1.1",
            diagnosticCode: opts.diagnosticCode ?? "smtp; 550 5.1.1 user unknown",
          },
        ],
      },
      mail: {
        timestamp: "2026-08-02T10:00:00.000Z",
        messageId: opts.messageId ?? `ses-msg-${opts.email}`,
        destination: [opts.email],
        commonHeaders: { subject: opts.subject ?? "Your ticket #001 — Warehouse Party" },
        tags: emailTags,
      },
    };
  }

  test("a bounced TICKET becomes an unresolved entry naming the order", async () => {
    const email = "typo@exampl.com";
    await post(
      bounceEvent({
        email,
        kind: "transactional",
        context: { stripeSessionId: "cs_test_paid1", eventId: "3f2504e0-4f89-11d3" },
      }),
    );

    const [entry] = ledger.listFailures();
    assert.ok(entry, "a bounce that follows acceptance must still be recorded");
    assert.equal(entry.kind, "transactional");
    assert.equal(entry.recipients[0]?.address, email, "a paid buyer has to be contactable");
    assert.equal(entry.recipients[0]?.hash, hashEmail(email));
    assert.equal(entry.context?.stripeSessionId, "cs_test_paid1");
    assert.equal(entry.context?.eventId, "3f2504e0-4f89-11d3");
    assert.equal(entry.context?.asyncEvent, "Bounce");
    assert.equal(entry.code, "Bounce/Permanent/General");
    assert.equal(entry.retryable, false, "re-sending to a dead address bounces again");
    assert.equal(entry.subject, "Your ticket #001 — Warehouse Party");
    assert.equal(entry.resolvedAt, undefined);
  });

  test("and it turns /api/health red — the whole point of the record", async () => {
    assert.equal(ledger.failureHealth().ok, true);
    await post(bounceEvent({ email: "gone@example.com", kind: "transactional" }));
    const health = ledger.failureHealth();
    assert.equal(health.ok, false);
    assert.equal(health.unresolvedTransactional, 1);
  });

  test("a bounced MARKETING send keeps the hash and never the address", async () => {
    const email = "cold@example.com";
    await post(bounceEvent({ email, kind: "marketing", context: { organiser: "0xAbCd11" } }));

    const [entry] = ledger.listFailures();
    assert.equal(entry?.kind, "marketing");
    assert.equal(entry?.recipients[0]?.hash, hashEmail(email));
    assert.equal(entry?.recipients[0]?.address, undefined, "PLAINTEXT POLICY");
    assert.equal(entry?.context?.organiser, "0xAbCd11");
    assert.equal(ledger.failureHealth().ok, true, "a bad list is not a ticket alarm");
  });

  test("the SMTP diagnostic is kept, minus any address it quotes", async () => {
    await post(
      bounceEvent({
        email: "quoted@example.com",
        kind: "transactional",
        diagnosticCode: "smtp; 550 5.1.1 <quoted@example.com>: Recipient address rejected",
      }),
    );
    const [entry] = ledger.listFailures();
    assert.match(entry!.error, /550 5\.1\.1/, "the operator still learns why");
    assert.ok(!entry!.error.includes("quoted@example.com"), "but not a second copy of the address");
  });

  test("a Transient bounce is neither suppressed nor ledgered", async () => {
    await post(bounceEvent({ email: "full@example.com", kind: "transactional", bounceType: "Transient", subType: "MailboxFull" }));
    assert.equal(ledger.listFailures().length, 0, "it may still arrive; a self-clearing alarm teaches operators to ignore alarms");
    assert.equal(suppression.isSuppressed(hashEmail("full@example.com"), ORG), false);
  });

  /**
   * The message WAS delivered. Recording it as undelivered would be false, and
   * the suppression it triggers is only consumed by the marketing path, so it
   * cannot cost this person a future ticket either.
   */
  test("a complaint suppresses but does NOT ledger", async () => {
    const email = "spam-button@example.com";
    await post({
      eventType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: "abuse" },
      mail: { messageId: "m-complaint", destination: [email], tags: {} },
    });
    assert.equal(suppression.isSuppressed(hashEmail(email), ORG), true);
    assert.equal(ledger.listFailures().length, 0);
  });

  test("Permanent/OnAccountSuppressionList — AWS dropped it silently — is ledgered", async () => {
    await post(
      bounceEvent({ email: "onlist@example.com", kind: "transactional", subType: "OnAccountSuppressionList" }),
    );
    const [entry] = ledger.listFailures();
    assert.equal(entry?.code, "Bounce/Permanent/OnAccountSuppressionList");
    assert.equal(ledger.failureHealth().ok, false);
  });

  /**
   * SES accepted the message and then discarded it on a content verdict. Our
   * ticket mail carries a composite PNG, so a false positive is a live path —
   * and there is no `bounce` object to read recipients from.
   */
  test("a Reject event is ledgered from mail.destination, and suppresses nobody", async () => {
    const email = "innocent@example.com";
    await post({
      eventType: "Reject",
      reject: { reason: "Bad content" },
      mail: {
        messageId: "m-reject",
        destination: [email],
        commonHeaders: { subject: "Your ticket #002" },
        tags: Object.fromEntries(
          Object.entries(tags.buildMessageTags("transactional", { eventId: "evt-9" })).map(
            ([k, v]) => [k, [v]],
          ),
        ),
      },
    });

    const [entry] = ledger.listFailures();
    assert.equal(entry?.kind, "transactional");
    assert.equal(entry?.code, "Reject");
    assert.equal(entry?.recipients[0]?.address, email);
    assert.equal(entry?.context?.eventId, "evt-9");
    assert.match(entry!.error, /Bad content/);
    assert.equal(
      suppression.isSuppressed(hashEmail(email), ORG),
      false,
      "the fault is our content — blocking them would deny every future ticket",
    );
  });

  test("every bounced addressee is recorded, not just the first", async () => {
    const event = bounceEvent({ email: "one@example.com", kind: "transactional" });
    event.bounce.bouncedRecipients.push({
      emailAddress: "two@example.com",
      action: "failed",
      status: "5.1.1",
      diagnosticCode: "smtp; 550 unknown",
    });
    event.mail.destination = ["one@example.com", "two@example.com"];
    await post(event);

    const [entry] = ledger.listFailures();
    assert.equal(entry?.recipients.length, 2);
    assert.deepEqual(
      entry?.recipients.map((r) => r.address),
      ["one@example.com", "two@example.com"],
    );
  });

  test("a partial bounce records only the addressee that failed", async () => {
    const event = bounceEvent({ email: "bad@example.com", kind: "transactional" });
    event.mail.destination = ["bad@example.com", "fine@example.com"];
    await post(event);

    const [entry] = ledger.listFailures();
    assert.equal(entry?.recipients.length, 1);
    assert.equal(entry?.recipients[0]?.address, "bad@example.com");
  });

  /**
   * `SES_SNS_TOPIC_ARN` is a comma-separated list, and a config-set destination
   * alongside identity-level notifications delivers one failure twice with
   * different envelope ids. Two unresolved entries is doubled evidence of one
   * incident, and doubles the work of clearing the alarm.
   */
  test("one SES failure delivered over two subscriptions writes ONE entry", async () => {
    const event = bounceEvent({ email: "dual@example.com", kind: "transactional", messageId: "ses-dual" });
    await post(event, "sns-envelope-a");
    await post(event, "sns-envelope-b");
    assert.equal(ledger.listFailures().length, 1);
  });

  test("but separate events for different recipients of one message both count", async () => {
    const messageId = "ses-multi";
    await post(bounceEvent({ email: "r1@example.com", kind: "transactional", messageId }), "env-1");
    await post(bounceEvent({ email: "r2@example.com", kind: "transactional", messageId }), "env-2");
    assert.equal(ledger.listFailures().length, 2);
  });

  describe("when the event carries no tags", () => {
    /**
     * Identity-level notifications publish none, and so does every message
     * already in flight when this ships. Classifying on a guess is the one
     * mistake that cannot be undone — storing a stranger's plaintext — so it
     * takes the hash-only path, and the ALARM is that correlation is broken,
     * not that this particular message failed.
     */
    test("it is recorded hash-only rather than guessed into transactional", async () => {
      const email = "untagged@example.com";
      await post(bounceEvent({ email }));

      const [entry] = ledger.listFailures();
      assert.ok(entry);
      assert.equal(entry.kind, "marketing");
      assert.equal(entry.recipients[0]?.address, undefined);
      assert.equal(entry.recipients[0]?.hash, hashEmail(email));
      assert.equal(entry.context?.untagged, "true");
      assert.equal(ledger.failureHealth().ok, true, "no false ticket alarm");
    });

    test("and /api/health says correlation is broken", async () => {
      assert.deepEqual(ledger.bounceLedgerHealth(), { ok: true, correlated: 0, untagged: 0 });
      await post(bounceEvent({ email: "untagged@example.com" }));
      assert.deepEqual(ledger.bounceLedgerHealth(), { ok: false, correlated: 0, untagged: 1 });
    });

    test("a working config set reports healthy correlation", async () => {
      await post(bounceEvent({ email: "tagged@example.com", kind: "transactional" }));
      assert.deepEqual(ledger.bounceLedgerHealth(), { ok: true, correlated: 1, untagged: 0 });
    });

    test("an unrecognised classifier value is treated as untagged, not coerced", async () => {
      const email = "weird@example.com";
      await post({
        ...bounceEvent({ email }),
        mail: { ...bounceEvent({ email }).mail, tags: { woco_kind: ["something-else"] } },
      });
      assert.equal(ledger.listFailures()[0]?.context?.untagged, "true");
    });
  });
});
