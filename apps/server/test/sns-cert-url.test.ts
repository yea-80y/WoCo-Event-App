/**
 * `POST /api/ses/webhook` is unauthenticated by necessity — SNS cannot present
 * our session credentials, so the signature IS the authentication. But the
 * signing certificate has to be fetched BEFORE the signature can be checked,
 * and the certificate's URL comes out of the request body. An attacker
 * therefore chooses a string that causes an outbound HTTPS fetch from our
 * server before we are able to reject them (#104).
 *
 * The host allowlist already means this is not SSRF. What these tests pin is
 * the remaining property: the set of URLs an attacker can make us fetch is
 * finite and cacheable, so a burst of forged posts cannot become a burst of
 * uncached outbound requests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isSnsCertUrl, isSnsAwsHttpsUrl } from "../src/lib/email/sns-verify.js";

const REAL = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-a86cb10b4e1f29c941702d737128f7b6.pem";

test("a real SNS certificate URL is accepted", () => {
  assert.equal(isSnsCertUrl(REAL), true);
  assert.equal(isSnsCertUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem"), true);
  assert.equal(isSnsCertUrl("https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc123.pem"), true);
});

test("a novel path on a genuine SNS host is refused — this is the amplification fix", () => {
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/anything.pem"), false);
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/"), false);
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-.pem"), false);
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/x/SimpleNotificationService-abc.pem"), false);
});

test("a lookalike path that merely CONTAINS the real one is refused", () => {
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc.pem/extra"), false);
  assert.equal(isSnsCertUrl("https://sns.eu-west-2.amazonaws.com/evil/SimpleNotificationService-abc.pem"), false);
});

test("a query string or fragment is refused, because certCache is keyed by the whole URL", () => {
  assert.equal(isSnsCertUrl(REAL + "?1"), false, "?1 ?2 ?3 would be unlimited cache misses on one file");
  assert.equal(isSnsCertUrl(REAL + "#a"), false);
});

test("the host allowlist still holds, anchored at both ends", () => {
  assert.equal(isSnsCertUrl("https://evil.com/SimpleNotificationService-abc.pem"), false);
  assert.equal(
    isSnsCertUrl("https://sns.evil.com.amazonaws.com.attacker.net/SimpleNotificationService-abc.pem"),
    false,
  );
  assert.equal(isSnsCertUrl("http://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc.pem"), false);
  assert.equal(isSnsCertUrl("not a url"), false);
});

test("SubscribeURL keeps the looser check — pinning the cert path there would break every confirmation", () => {
  const subscribe =
    "https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-west-2:1:t&Token=abc";
  assert.equal(isSnsAwsHttpsUrl(subscribe), true, "confirmations are query-bearing and must still pass");
  assert.equal(isSnsCertUrl(subscribe), false, "but they are not certificates");
});
