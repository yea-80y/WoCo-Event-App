/**
 * Amazon SES v2 provider.
 *
 * Uses `Content.Simple` rather than `Content.Raw`. SESv2's Simple content gained
 * an `Attachments` list with `ContentId` + `ContentDisposition: INLINE`, which is
 * exactly what our ticket email needs (`<img src="cid:woco-card-0">`), so SES
 * assembles the MIME. Hand-rolling multipart/related to use Raw content would be
 * a correctness liability — header folding, transfer encodings and boundary
 * generation are easy to get subtly wrong and hard to notice, because the failure
 * mode is "renders in Gmail, not in Outlook".
 *
 * All limits enforced here come from the SES API reference and service quotas
 * (checked 2026-07-30) and are asserted BEFORE the call: a `BadRequestException`
 * costs a round trip and tells the caller less than we can tell them locally.
 */

import {
  SESv2Client,
  SendEmailCommand,
  type Attachment,
  type MessageHeader,
} from "@aws-sdk/client-sesv2";
import type { EmailProvider, OutboundEmail, OutboundAttachment } from "./types.js";
import { EmailSendError } from "./types.js";

// --- Limits, from the SES API reference / service quotas -------------------
/** Max message size is 40MB AFTER base64. Guard below it to leave header room. */
const MAX_ENCODED_BYTES = 38 * 1024 * 1024;
const MAX_RECIPIENTS_PER_MESSAGE = 50;
const MAX_FILENAME_LEN = 255;
const MAX_CONTENT_ID_LEN = 78;
const MAX_CONTENT_TYPE_LEN = 78;
const MAX_HEADER_NAME_LEN = 126;
const MAX_HEADER_VALUE_LEN = 995;
const MAX_HEADER_COMBINED_LEN = 996;
/** MessageHeader Name: printable ASCII 33–126 except colon. */
const HEADER_NAME_RE = /^[!-9;-@A-~]+$/;
/** MessageHeader Value: printable ASCII plus space. */
const HEADER_VALUE_RE = /^[ -~]*$/;

/**
 * Headers SES composes itself. Passing any of these produces a duplicate or a
 * rejected request depending on the header, and silently overriding e.g.
 * Return-Path would break bounce routing — so we drop them rather than pass them
 * through. Nothing in this codebase sets them via `headers`; this is a guard
 * against a future caller doing it by accident.
 */
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "return-path",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
]);

let client: SESv2Client | null = null;

export function getSesClient(): SESv2Client {
  if (!client) {
    const region = process.env.AWS_REGION || process.env.SES_REGION;
    if (!region) {
      // Fail loud at first send rather than defaulting to us-east-1, where our
      // domain identity does not exist and every message would be rejected.
      throw new Error("AWS_REGION (or SES_REGION) is not set — refusing to guess an SES region");
    }
    client = new SESv2Client({
      region,
      // Adaptive retry adds client-side rate limiting on top of exponential
      // backoff, which is the AWS-documented behaviour for throttled workloads.
      // The token bucket in rate-limiter.ts shapes traffic so this rarely fires;
      // when it does, it is the difference between a blip and a lost ticket.
      retryMode: "adaptive",
      maxAttempts: Number(process.env.SES_MAX_ATTEMPTS) || 3,
    });
  }
  return client;
}

/** Tests only. */
export function _resetSesClientForTest(): void {
  client = null;
}

/**
 * Split `"Display Name" <addr@host>` into its parts and RFC 2047-encode the
 * display name when it is not pure ASCII.
 *
 * SES takes `FromEmailAddress` as a formatted header value, and a raw non-ASCII
 * display name is not legal there. Event titles are organiser-supplied free
 * text, so "Café Night" is an ordinary input, not an edge case.
 */
export function encodeFromAddress(from: string): string {
  const match = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return from.trim(); // bare address
  const [, rawName, addr] = match;
  const name = (rawName ?? "").trim();
  if (!name) return addr!.trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/"/g, "'")}" <${addr!.trim()}>`;
  const b64 = Buffer.from(name, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?= <${addr!.trim()}>`;
}

function toSesAttachment(a: OutboundAttachment, index: number): Attachment {
  if (!a.filename) throw new EmailSendError(`attachment[${index}]: FileName is required`, { retryable: false });
  if (a.filename.length > MAX_FILENAME_LEN) {
    throw new EmailSendError(
      `attachment[${index}]: FileName exceeds ${MAX_FILENAME_LEN} chars`,
      { retryable: false },
    );
  }
  if (a.contentId && a.contentId.length > MAX_CONTENT_ID_LEN) {
    throw new EmailSendError(
      `attachment[${index}]: ContentId exceeds ${MAX_CONTENT_ID_LEN} chars`,
      { retryable: false },
    );
  }
  if (a.contentType && a.contentType.length > MAX_CONTENT_TYPE_LEN) {
    throw new EmailSendError(
      `attachment[${index}]: ContentType exceeds ${MAX_CONTENT_TYPE_LEN} chars`,
      { retryable: false },
    );
  }
  return {
    FileName: a.filename,
    RawContent: new Uint8Array(a.content),
    // INLINE is what makes `cid:` resolve; an inline part sent as ATTACHMENT
    // renders as a download stub and the ticket QR never appears in the body.
    ContentDisposition: a.contentId ? "INLINE" : "ATTACHMENT",
    ...(a.contentId ? { ContentId: a.contentId } : {}),
    ...(a.contentType ? { ContentType: a.contentType } : {}),
    ContentTransferEncoding: "BASE64",
  };
}

/**
 * Map our header bag onto SES `MessageHeader`s, enforcing the documented
 * constraints.
 *
 * Throws rather than dropping. The only headers we set are RFC 8058
 * `List-Unsubscribe` / `List-Unsubscribe-Post`, and silently sending marketing
 * without them is a compliance breach — `marketing-send.ts` guarantees they are
 * present, so this layer must not quietly undo that guarantee.
 */
export function toSesHeaders(headers: Record<string, string>): MessageHeader[] {
  const out: MessageHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    if (!HEADER_NAME_RE.test(name) || name.length > MAX_HEADER_NAME_LEN) {
      throw new EmailSendError(`Header name is not valid for SES: "${name}"`, { retryable: false });
    }
    if (!HEADER_VALUE_RE.test(value) || value.length > MAX_HEADER_VALUE_LEN) {
      throw new EmailSendError(`Header value is not valid for SES: "${name}"`, { retryable: false });
    }
    if (name.length + value.length > MAX_HEADER_COMBINED_LEN) {
      throw new EmailSendError(
        `Header "${name}" exceeds the combined ${MAX_HEADER_COMBINED_LEN}-char limit`,
        { retryable: false },
      );
    }
    out.push({ Name: name, Value: value });
  }
  return out;
}

/** Approximate on-the-wire size, base64 expansion included. */
function encodedSize(msg: OutboundEmail): number {
  const body = Buffer.byteLength(msg.html ?? "", "utf-8") + Buffer.byteLength(msg.text ?? "", "utf-8");
  const attachments = (msg.attachments ?? []).reduce(
    (sum, a) => sum + Math.ceil(a.content.length / 3) * 4,
    0,
  );
  return body + attachments;
}

/** The request we would send. Exported so tests assert the mapping without AWS. */
export function buildSendEmailInput(msg: OutboundEmail) {
  if (msg.to.length > MAX_RECIPIENTS_PER_MESSAGE) {
    throw new EmailSendError(
      `${msg.to.length} recipients exceeds the SES limit of ${MAX_RECIPIENTS_PER_MESSAGE} per message`,
      { retryable: false },
    );
  }
  const size = encodedSize(msg);
  if (size > MAX_ENCODED_BYTES) {
    throw new EmailSendError(
      `Message is ~${Math.round(size / 1024 / 1024)}MB base64-encoded, over the SES 40MB limit`,
      { retryable: false },
    );
  }

  const attachments = (msg.attachments ?? []).map(toSesAttachment);
  const headers = msg.headers ? toSesHeaders(msg.headers) : [];

  return {
    FromEmailAddress: encodeFromAddress(msg.from),
    Destination: { ToAddresses: msg.to },
    ...(msg.replyTo?.length ? { ReplyToAddresses: msg.replyTo } : {}),
    ...(process.env.SES_CONFIGURATION_SET
      ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET }
      : {}),
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: "UTF-8" },
        Body: {
          ...(msg.html ? { Html: { Data: msg.html, Charset: "UTF-8" } } : {}),
          ...(msg.text ? { Text: { Data: msg.text, Charset: "UTF-8" } } : {}),
        },
        ...(headers.length ? { Headers: headers } : {}),
        ...(attachments.length ? { Attachments: attachments } : {}),
      },
    },
  };
}

/**
 * Errors that no number of retries will fix. Everything not listed — network
 * faults, 5xx, throttles — is treated as retryable, which is the safe default:
 * retrying a deliverable message costs a request, giving up on one costs a
 * ticket.
 */
const PERMANENT_ERRORS = new Set([
  "AccountSuspendedException",
  "BadRequestException",
  "MailFromDomainNotVerifiedException",
  "MessageRejected",
  "NotFoundException",
  "LimitExceededException",
  // The account's sending is paused. Retrying cannot lift it and would burn the
  // retry budget on every queued message; it needs an operator, so fail fast and
  // let the failure ledger raise it.
  "SendingPausedException",
]);

interface AwsErrorShape {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: { throttling?: boolean };
}

export function classifySesError(err: unknown): EmailSendError {
  if (err instanceof EmailSendError) return err;
  const e = (err ?? {}) as AwsErrorShape;
  const name = e.name ?? "UnknownError";
  const message = e.message ?? String(err);
  const status = e.$metadata?.httpStatusCode;

  const permanent = PERMANENT_ERRORS.has(name) || (status !== undefined && status >= 400 && status < 500 && status !== 429);
  const retryable = !permanent || name === "TooManyRequestsException" || Boolean(e.$retryable?.throttling);

  return new EmailSendError(`SES ${name}: ${message}`, {
    retryable,
    code: name,
    ...(status !== undefined ? { status } : {}),
    cause: err,
  });
}

export const sesProvider: EmailProvider = {
  name: "ses",
  async send(msg) {
    const input = buildSendEmailInput(msg);
    try {
      await getSesClient().send(new SendEmailCommand(input));
    } catch (err) {
      throw classifySesError(err);
    }
  },
};
