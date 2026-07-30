/**
 * Amazon SNS HTTPS message verification.
 *
 * This is a security control, not a formality. SES delivers bounce and
 * complaint events through SNS, and those events feed the GLOBAL suppression
 * list. An unauthenticated endpoint would therefore let anyone permanently
 * block delivery to any address on the platform by POSTing a forged complaint —
 * a targeted denial of email, and one the victim could never diagnose. The same
 * reasoning is already recorded on the Resend webhook; it applies harder here
 * because SNS has no shared secret to fall back on.
 *
 * Implemented against the AWS procedure (docs checked 2026-07-30) with
 * `node:crypto` rather than a dependency: the whole job is "build a canonical
 * string, RSA-verify it against a cert fetched from a validated host", and a
 * third-party package for that is more supply-chain surface than code saved.
 */

import { X509Certificate, createVerify, type KeyObject } from "node:crypto";

export type SnsMessageType =
  | "Notification"
  | "SubscriptionConfirmation"
  | "UnsubscribeConfirmation";

export interface SnsEnvelope {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

/**
 * Field order for the canonical string, per the AWS procedure: byte-sort order,
 * ONLY these fields, `Subject` included only when present.
 */
const NOTIFICATION_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const CONFIRMATION_FIELDS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

/**
 * SNS signing certificates are served from `sns.<region>.amazonaws.com`.
 * Anchoring both ends of the pattern is the point: a `.endsWith("amazonaws.com")`
 * check passes `sns.evil.com.amazonaws.com.attacker.net`, and a `.includes()`
 * check passes almost anything.
 */
const CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * Is this an HTTPS URL on a real SNS host?
 *
 * Guards the two server-side fetches driven by message content: the signing
 * certificate and `SubscribeURL`. HTTPS is required for both — for the cert
 * because it is the trust anchor for everything that follows (and TLS is what
 * validates the AWS chain of trust for us), and for SubscribeURL because
 * confirming a subscription is a state change we must not make against an
 * attacker-chosen host.
 */
export function isSnsAwsHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && CERT_HOST_RE.test(parsed.hostname);
}

/**
 * The canonical string to sign: `name\nvalue\n` per field, in the documented
 * order, INCLUDING the trailing newline after the last pair.
 *
 * The AWS prose ("Do not add a newline character at the end of the string")
 * reads as if the final `\n` should be dropped, but its own shell example pipes
 * the result through `echo -e`, which appends one — and both AWS-authored
 * validators build the trailing form directly:
 *   aws-js-sns-message-validator:  `field + "\n" + message[field] + "\n"`
 *   aws-php-sns-message-validator: `"{$key}\n{$message[$key]}\n"`
 * Read correctly, the prose means "no EXTRA newline beyond the pairs".
 * Settled 2026-07-30; an earlier revision verified against both encodings.
 */
export function buildStringToSign(msg: Record<string, unknown>): string {
  const fields = msg.Type === "Notification" ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  const parts: string[] = [];
  for (const field of fields) {
    const value = msg[field];
    // "Optional fields, such as Subject, must be included only if present."
    if (value === undefined || value === null) continue;
    parts.push(`${field}\n${String(value)}\n`);
  }
  return parts.join("");
}

interface CachedCert {
  key: KeyObject;
  validTo: number;
}

const certCache = new Map<string, CachedCert>();

/**
 * Fetch and cache the signing certificate.
 *
 * Cached by URL because SNS reuses a cert for a long time and a network round
 * trip per bounce would make a bad-address burst into a latency problem.
 */
async function loadCert(url: string, fetchImpl: typeof fetch): Promise<CachedCert> {
  const cached = certCache.get(url);
  if (cached && cached.validTo > Date.now()) return cached;

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Could not fetch SNS signing certificate: HTTP ${res.status}`);
  const pem = await res.text();

  const cert = new X509Certificate(pem);
  const validTo = Date.parse(cert.validTo);
  const validFrom = Date.parse(cert.validFrom);
  const now = Date.now();
  if (Number.isFinite(validFrom) && now < validFrom) throw new Error("SNS signing certificate is not yet valid");
  if (Number.isFinite(validTo) && now > validTo) throw new Error("SNS signing certificate has expired");

  const entry: CachedCert = { key: cert.publicKey, validTo: Number.isFinite(validTo) ? validTo : now + 3_600_000 };
  certCache.set(url, entry);
  return entry;
}

export interface VerifyOptions {
  /** Only accept messages on these topic ARNs. Empty disables the check. */
  allowedTopicArns?: string[];
  /** Reject SignatureVersion 1 (SHA1). AWS recommends enabling v2 on the topic. */
  requireSignatureV2?: boolean;
  /** Reject messages older than this. Bounds replay of a captured message. */
  maxAgeMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class SnsVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnsVerificationError";
  }
}

/**
 * Verify an SNS envelope. Throws `SnsVerificationError` on any failure — there
 * is no partial success and no "probably fine" path.
 */
export async function verifySnsSignature(
  msg: SnsEnvelope,
  opts: VerifyOptions = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (msg.Type !== "Notification" && msg.Type !== "SubscriptionConfirmation" && msg.Type !== "UnsubscribeConfirmation") {
    throw new SnsVerificationError(`Unsupported SNS message type "${msg.Type}"`);
  }

  // Checked BEFORE the signature: a wrong-topic message with a valid AWS
  // signature is still an attack (any AWS customer can sign with a real SNS
  // cert by publishing on their own topic). AWS calls this out explicitly:
  // "Reject any message with an unexpected TopicArn to prevent spoofing."
  const allowed = opts.allowedTopicArns?.filter(Boolean) ?? [];
  if (allowed.length && !allowed.includes(msg.TopicArn)) {
    throw new SnsVerificationError(`Unexpected TopicArn "${msg.TopicArn}"`);
  }

  const version = String(msg.SignatureVersion);
  if (version !== "1" && version !== "2") {
    throw new SnsVerificationError(`Unsupported SignatureVersion "${version}"`);
  }
  if (opts.requireSignatureV2 && version !== "2") {
    throw new SnsVerificationError("SignatureVersion 1 (SHA1) rejected — enable v2 on the SNS topic");
  }

  if (opts.maxAgeMs !== undefined) {
    const ts = Date.parse(msg.Timestamp);
    if (!Number.isFinite(ts)) throw new SnsVerificationError("Timestamp is not parseable");
    if (now() - ts > opts.maxAgeMs) throw new SnsVerificationError("Message is too old");
  }

  if (!isSnsAwsHttpsUrl(msg.SigningCertURL)) {
    throw new SnsVerificationError(`SigningCertURL is not an AWS SNS HTTPS URL: ${msg.SigningCertURL}`);
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(msg.Signature, "base64");
  } catch {
    throw new SnsVerificationError("Signature is not valid base64");
  }
  if (!signature.length) throw new SnsVerificationError("Signature is empty");

  const { key } = await loadCert(msg.SigningCertURL, fetchImpl);
  const algorithm = version === "2" ? "RSA-SHA256" : "RSA-SHA1";

  const verifier = createVerify(algorithm);
  verifier.update(buildStringToSign(msg as unknown as Record<string, unknown>), "utf-8");
  verifier.end();
  if (verifier.verify(key, signature)) return;

  throw new SnsVerificationError("Signature does not verify against the SNS signing certificate");
}

/** Tests only. */
export function _clearCertCacheForTest(): void {
  certCache.clear();
}
