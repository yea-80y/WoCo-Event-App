/**
 * Per-message tags — the correlation key that makes an ASYNC delivery failure
 * attributable.
 *
 * THE PROBLEM THEY SOLVE. A provider ACCEPTS a message and then fails to
 * deliver it minutes later: a typo'd address at checkout hard-bounces, or the
 * address is already on the provider's own suppression list. `send()` resolved,
 * so nothing retried, nothing failed over, and nothing reached the ledger — a
 * buyer paid and the first anyone knew was the door (#99). The bounce arrives
 * later on a separate channel (SNS) and carries no memory of why we sent it.
 *
 * WHY TAGS AND NOT THE MESSAGE ID. AWS: "on rare occasions, SES may accept an
 * email for delivery even though the send request returns an error to the
 * caller… use message tags rather than relying solely on the message ID."
 * MessageId is assigned at acceptance; tags are chosen by us before it.
 * (docs.aws.amazon.com/ses/latest/dg/send-email-concepts-process.html)
 *
 * WHAT COMES BACK. Tags return on the SNS event as `mail.tags`, a map of string
 * to an ARRAY of strings, alongside auto-populated `ses:*` entries. Only sends
 * that name a configuration set with an SNS destination carry them — AWS is
 * explicit that "if using feedback notifications directly on the identity, SES
 * does not publish tags", which is why an untagged bounce is treated as a
 * misconfiguration signal rather than as ordinary input.
 *
 * CHARSET. SES `MessageTag` allows ASCII letters, digits, `_` and `-` in BOTH
 * name and value, 256 chars max, both required. No `:`, no `.`, no `@`, no
 * base64 padding — so nothing here may assume a value survives verbatim.
 * (docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageTag.html)
 *
 * PRIVACY. Tags leave our systems and land in the provider's event stream, so
 * this module refuses to emit anything recipient-identifying. Today's contexts
 * are safe by construction (a Stripe session id, a UUID event id, an organiser
 * wallet), but `context` is a free-form `Record<string, string>` and tomorrow's
 * caller is not bound by today's habits. See docs/legal/DATA_INVENTORY.md.
 */

/** Classifier tag. Reserved: context keys are namespaced away from it. */
export const TAG_KIND = "woco_kind";

/**
 * Namespace for caller breadcrumbs.
 *
 * Separate from `TAG_KIND` because a context key called `kind` already exists —
 * `requirement-nudge.ts` sends `{ kind: "stripe-requirement-nudge" }`. Flattened
 * into one namespace that collides with the classifier on every nudge, and a
 * duplicate tag name is at best undefined behaviour and at worst a rejected
 * send.
 */
export const TAG_CONTEXT_PREFIX = "woco_ctx_";

/** Kept well under any provider ceiling; the tail of a context bag is noise. */
export const MAX_MESSAGE_TAGS = 10;

const MAX_TAG_LEN = 256;
const LEGAL_TAG = /^[A-Za-z0-9_-]+$/;
/** 32-byte hex — the shape of `hashEmail` output. */
const LOOKS_LIKE_HASH = /^[a-f0-9]{64}$/i;

export type MessageKind = "transactional" | "marketing";

export function isLegalTagToken(s: string): boolean {
  return s.length >= 1 && s.length <= MAX_TAG_LEN && LEGAL_TAG.test(s);
}

/**
 * Would this value identify the recipient?
 *
 * An address cannot survive the charset rule anyway (`@` and `.` are illegal),
 * but rejecting it explicitly means the log line says what actually happened
 * rather than "invalid characters", and it keeps the rule visible to the next
 * person who widens the charset.
 */
function isRecipientIdentifying(value: string): boolean {
  return value.includes("@") || LOOKS_LIKE_HASH.test(value);
}

/**
 * The tags for one outbound message.
 *
 * Built at the send chokepoint rather than by callers, so a send cannot opt out
 * of being correlatable. `woco_kind` is always present and always legal, which
 * is what lets the webhook honour the PLAINTEXT POLICY split — without it a
 * bounce cannot be told apart from a marketing one, and storing plaintext would
 * be a guess.
 */
export function buildMessageTags(
  kind: MessageKind,
  context?: Record<string, string>,
): Record<string, string> {
  const tags: Record<string, string> = { [TAG_KIND]: kind };

  for (const [key, value] of Object.entries(context ?? {})) {
    if (Object.keys(tags).length >= MAX_MESSAGE_TAGS) {
      console.warn(`[email-tags] Dropped context key "${key}" — over ${MAX_MESSAGE_TAGS} tags`);
      break;
    }
    if (isRecipientIdentifying(value)) {
      console.warn(`[email-tags] Refusing to tag "${key}" — the value identifies the recipient`);
      continue;
    }
    const name = `${TAG_CONTEXT_PREFIX}${key}`;
    if (!isLegalTagToken(name) || !isLegalTagToken(value)) continue;
    tags[name] = value;
  }
  return tags;
}

export interface DecodedMessageTags {
  /** null when the message carried no usable classifier — see the webhook. */
  kind: MessageKind | null;
  /** Caller breadcrumbs, `woco_ctx_` stripped. */
  context: Record<string, string>;
}

/**
 * Read our tags back off a provider event.
 *
 * `mail.tags` values are ARRAYS even for a single-valued tag, and the map also
 * holds provider-owned `ses:*` entries. The `woco_` prefix filter excludes
 * those, and an unrecognised `woco_kind` value yields `kind: null` rather than
 * being coerced — a message we cannot classify must take the untagged path, not
 * be guessed into one that stores plaintext.
 */
export function readMessageTags(raw: unknown): DecodedMessageTags {
  const out: DecodedMessageTags = { kind: null, context: {} };
  if (!raw || typeof raw !== "object") return out;

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string") continue;

    if (name === TAG_KIND) {
      if (first === "transactional" || first === "marketing") out.kind = first;
      continue;
    }
    if (name.startsWith(TAG_CONTEXT_PREFIX)) {
      const key = name.slice(TAG_CONTEXT_PREFIX.length);
      if (key) out.context[key] = first.slice(0, MAX_TAG_LEN);
    }
  }
  return out;
}
