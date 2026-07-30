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
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

beforeEach(() => {
  snsVerify._clearCertCacheForTest();
  consumed._resetForTest();
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
