/**
 * SNS message verification — the access control on global suppression.
 *
 * A forged bounce or complaint would let anyone permanently block delivery to
 * any address on the platform, and the victim could never diagnose it. So these
 * tests are adversarial: each one is an attack that must be rejected, not a
 * happy path that must be accepted.
 *
 * A throwaway self-signed certificate is generated per run rather than checked
 * in, so no private key ever lives in the repo. It is issued for the real SNS
 * hostname because the host allowlist is one of the things under test.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";

import {
  verifySnsSignature,
  buildStringToSign,
  isSnsAwsHttpsUrl,
  SnsVerificationError,
  _clearCertCacheForTest,
  type SnsEnvelope,
} from "../src/lib/email/sns-verify.js";

const CERT_URL = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc123.pem";
const TOPIC = "arn:aws:sns:eu-west-2:123456789012:woco-ses-events";

let privateKeyPem: string;
let certPem: string;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "woco-sns-test-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath, "-out", certPath,
      "-days", "3650", "-nodes",
      "-subj", "/CN=sns.eu-west-2.amazonaws.com",
    ],
    { stdio: "ignore" },
  );
  privateKeyPem = readFileSync(keyPath, "utf-8");
  certPem = readFileSync(certPath, "utf-8");
});

beforeEach(() => {
  _clearCertCacheForTest();
});

/** A fetch that always serves our generated certificate. */
const certFetch = (async () =>
  new Response(certPem, { status: 200 })) as unknown as typeof fetch;

/** Build a correctly-signed envelope, then let callers corrupt one field. */
function signedEnvelope(
  overrides: Partial<SnsEnvelope> = {},
  opts: { trailingNewline?: boolean; version?: "1" | "2" } = {},
): SnsEnvelope {
  const version = opts.version ?? "2";
  const msg: SnsEnvelope = {
    Type: "Notification",
    MessageId: "11111111-2222-3333-4444-555555555555",
    TopicArn: TOPIC,
    Message: JSON.stringify({ eventType: "Bounce" }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: version,
    Signature: "",
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  const stringToSign = buildStringToSign(
    msg as unknown as Record<string, unknown>,
    opts.trailingNewline ?? true,
  );
  const signer = createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(stringToSign, "utf-8");
  signer.end();
  msg.Signature = signer.sign(privateKeyPem, "base64");
  return msg;
}

const verify = (msg: SnsEnvelope, extra = {}) =>
  verifySnsSignature(msg, {
    allowedTopicArns: [TOPIC],
    fetchImpl: certFetch,
    ...extra,
  });

describe("canonical string", () => {
  test("uses the documented field order for a Notification", () => {
    const s = buildStringToSign(
      { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "body", Timestamp: "ts" },
      false,
    );
    assert.equal(s, "Message\nbody\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification");
  });

  test("includes Subject in position only when present", () => {
    const withSubject = buildStringToSign(
      { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "b", Timestamp: "ts", Subject: "s" },
      false,
    );
    assert.equal(withSubject.includes("Subject\ns\nTimestamp"), true);
    const without = buildStringToSign(
      { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "b", Timestamp: "ts" },
      false,
    );
    assert.equal(without.includes("Subject"), false);
  });

  test("uses the confirmation field set for SubscriptionConfirmation", () => {
    const s = buildStringToSign(
      {
        Type: "SubscriptionConfirmation",
        MessageId: "m",
        TopicArn: "t",
        Message: "b",
        Timestamp: "ts",
        Token: "tok",
        SubscribeURL: "https://sns.eu-west-2.amazonaws.com/x",
      },
      false,
    );
    assert.equal(s.includes("SubscribeURL\nhttps://sns.eu-west-2.amazonaws.com/x"), true);
    assert.equal(s.includes("Token\ntok"), true);
  });

  test("ignores fields outside the documented set", () => {
    // "Only the explicitly required fields must be included."
    const s = buildStringToSign(
      { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "b", Timestamp: "ts", Evil: "x" },
      false,
    );
    assert.equal(s.includes("Evil"), false);
  });
});

describe("signing cert URL", () => {
  const bad = [
    "http://sns.eu-west-2.amazonaws.com/cert.pem",          // not HTTPS
    "https://evil.com/cert.pem",
    "https://sns.eu-west-2.amazonaws.com.evil.com/cert.pem", // suffix attack
    "https://evil-sns.eu-west-2.amazonaws.com/cert.pem",     // prefix attack
    "https://amazonaws.com/cert.pem",
    "not a url",
  ];
  for (const url of bad) {
    test(`rejects ${url}`, () => assert.equal(isSnsAwsHttpsUrl(url), false));
  }

  test("accepts a real SNS host", () => {
    assert.equal(isSnsAwsHttpsUrl(CERT_URL), true);
    assert.equal(isSnsAwsHttpsUrl("https://sns.us-east-1.amazonaws.com/x.pem"), true);
  });
});

describe("verifySnsSignature", () => {
  test("accepts a correctly signed v2 message", async () => {
    await verify(signedEnvelope());
  });

  test("accepts a correctly signed v1 (SHA1) message", async () => {
    await verify(signedEnvelope({}, { version: "1" }));
  });

  test("accepts either trailing-newline encoding — the AWS reference is ambiguous", async () => {
    await verify(signedEnvelope({}, { trailingNewline: true }));
    await verify(signedEnvelope({}, { trailingNewline: false }));
  });

  test("REJECTS a tampered Message body", async () => {
    // The attack this whole module exists to stop: a real envelope whose
    // payload has been swapped for a complaint against someone else.
    const msg = signedEnvelope();
    msg.Message = JSON.stringify({
      eventType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "victim@example.com" }] },
    });
    await assert.rejects(verify(msg), SnsVerificationError);
  });

  test("REJECTS a tampered TopicArn", async () => {
    const msg = signedEnvelope();
    msg.TopicArn = TOPIC;
    const forged = { ...msg, TopicArn: TOPIC, Signature: signedEnvelope({ Message: "other" }).Signature };
    await assert.rejects(verify(forged as SnsEnvelope), SnsVerificationError);
  });

  test("REJECTS a message on an unexpected topic even if validly signed", async () => {
    // Any AWS customer can obtain a genuine SNS signature on their own topic.
    const msg = signedEnvelope({ TopicArn: "arn:aws:sns:eu-west-2:999999999999:attacker" });
    await assert.rejects(verify(msg), /Unexpected TopicArn/);
  });

  test("REJECTS a certificate served from a non-AWS host", async () => {
    const msg = signedEnvelope({ SigningCertURL: "https://evil.com/cert.pem" });
    await assert.rejects(verify(msg), /not an AWS SNS HTTPS URL/);
  });

  test("REJECTS an empty signature", async () => {
    const msg = signedEnvelope();
    msg.Signature = "";
    await assert.rejects(verify(msg), /Signature is empty/);
  });

  test("REJECTS an unsupported SignatureVersion", async () => {
    const msg = signedEnvelope();
    msg.SignatureVersion = "3";
    await assert.rejects(verify(msg), /Unsupported SignatureVersion/);
  });

  test("REJECTS v1 when requireSignatureV2 is on", async () => {
    const msg = signedEnvelope({}, { version: "1" });
    await assert.rejects(verify(msg, { requireSignatureV2: true }), /rejected/);
  });

  test("REJECTS a message older than maxAgeMs — bounds replay", async () => {
    const msg = signedEnvelope({ Timestamp: new Date(Date.now() - 90_000).toISOString() });
    await assert.rejects(verify(msg, { maxAgeMs: 60_000 }), /too old/);
  });

  test("REJECTS an unsupported message type", async () => {
    const msg = signedEnvelope();
    (msg as { Type: string }).Type = "Nonsense";
    await assert.rejects(verify(msg), /Unsupported SNS message type/);
  });

  test("REJECTS when the certificate cannot be fetched", async () => {
    const failing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(
      verifySnsSignature(signedEnvelope(), {
        allowedTopicArns: [TOPIC],
        fetchImpl: failing,
      }),
      /Could not fetch SNS signing certificate/,
    );
  });

  test("REJECTS a signature made with a different key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woco-sns-other-"));
    const otherKey = join(dir, "k.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-keyout", otherKey, "-out", join(dir, "c.pem"),
        "-days", "3650", "-nodes", "-subj", "/CN=sns.eu-west-2.amazonaws.com"],
      { stdio: "ignore" },
    );
    const msg = signedEnvelope();
    const signer = createSign("RSA-SHA256");
    signer.update(buildStringToSign(msg as unknown as Record<string, unknown>, true), "utf-8");
    signer.end();
    msg.Signature = signer.sign(readFileSync(otherKey, "utf-8"), "base64");
    await assert.rejects(verify(msg), /does not verify/);
  });
});
