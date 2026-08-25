/**
 * Referral-link capture: the localStorage side of `#/ref/{address}`.
 *
 * Split out of api/campaign.ts and kept DEPENDENCY-FREE on purpose. The router
 * runs capture on every hash change and previously reached it through
 * api/campaign.js, which imports the API client, which imports a runes module —
 * a lot of graph for a regex and a localStorage write. Nothing here imports
 * anything, so the router's lazy chunk stays a few lines and this module can be
 * exercised by the plain-tsx test suite.
 *
 * Capture is deliberately silent to the SERVER (the referral posts at the
 * visitor's first authenticated moment, so landing on a link never triggers a
 * signing prompt) — but it was silent to the VISITOR too, which is #34: neither
 * they nor anyone testing the flow could tell it had worked.
 */

const REF_STORAGE_KEY = "woco:ref";
const REF_NAME_KEY = "woco:ref-name";
const NOTICE_DISMISSED_KEY = "woco:ref-notice-dismissed";

/** Lowercased 0x address, or null. */
export type CapturedRef = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** A WoCo sub-ENS label, with or without the `.woco.eth` suffix. Same shape the
 *  registrar accepts (see sub-ens-resolve.ts), so a link can never carry a
 *  label the resolver would reject out of hand. */
const LABEL_RE = /^[a-z0-9-]{1,63}$/;

/** What a `#/ref/{…}` link carried. A name has to be resolved to an address
 *  before it can be posted, and resolution can fail, so the two are stored
 *  separately rather than one being derived and thrown away. */
export type RefToken =
  | { kind: "address"; address: CapturedRef }
  | { kind: "name"; label: string }
  | { kind: "invalid" };

/** Classify the token in a referral link. Pure — the router calls this before
 *  deciding whether it needs the resolver at all, so an address link still
 *  costs nothing. */
export function classifyRefToken(raw: string): RefToken {
  const input = raw.trim();
  if (ADDRESS_RE.test(input)) return { kind: "address", address: input.toLowerCase() as CapturedRef };
  // An `0x…` token that is not a valid address is a broken link, never a name.
  // Hex characters are all valid label characters, so without this a truncated
  // address like `0x1234` would be looked up as a NAME — and a label of that
  // shape can be registered, which would route a mistyped invite's credit to
  // whoever registered it.
  if (/^0x/i.test(input)) return { kind: "invalid" };
  const label = input.toLowerCase().replace(/\.woco\.eth$/, "");
  if (LABEL_RE.test(label)) return { kind: "name", label };
  return { kind: "invalid" };
}

/** Every access is wrapped: private mode and storage-blocked browsers throw on
 *  read as well as write, and a referral is never worth taking a screen down. */
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

/** Persist a referral capture (from `#/ref/{address}`) until first sign-in. */
export function storeCapturedRef(referrer: string): void {
  if (!ADDRESS_RE.test(referrer)) return;
  // No dismissal bookkeeping here: the dismissal is stored AS the address it
  // applies to, so a different referrer is already un-dismissed and the same
  // referrer already stays dismissed. (Written the other way first; reverting
  // the extra clear changed no test, which is what showed it was dead.)
  write(REF_STORAGE_KEY, referrer.toLowerCase());
}

export function readCapturedRef(): CapturedRef | null {
  const v = read(REF_STORAGE_KEY);
  return v && LOWER_ADDRESS_RE.test(v) ? (v as CapturedRef) : null;
}

export function clearCapturedRef(): void {
  try {
    globalThis.localStorage?.removeItem(REF_STORAGE_KEY);
    globalThis.localStorage?.removeItem(REF_NAME_KEY);
  } catch {
    /* best-effort */
  }
  clearNoticeDismissal();
}

/**
 * Remember the NAME a referral link carried, so the visitor is told who invited
 * them in the form the sharer chose rather than as hex.
 *
 * Stored even before the name resolves to an address: resolution is a network
 * read that can fail, and losing the referrer because a registrar lookup timed
 * out would be a worse bug than the one #34 is about. `pendingRefName()` is
 * what the post path retries against.
 */
export function storeCapturedRefName(label: string): void {
  const l = label.trim().toLowerCase().replace(/\.woco\.eth$/, "");
  if (LABEL_RE.test(l)) write(REF_NAME_KEY, l);
}

/** The name behind the current capture, if the link carried one. */
export function capturedRefName(): string | null {
  const v = read(REF_NAME_KEY);
  return v && LABEL_RE.test(v) ? v : null;
}

/**
 * A name that was captured but has no address yet — the link carried a name and
 * resolution has not succeeded. The post path re-resolves this, so a lookup
 * that failed on the landing page still gets its credit later.
 */
export function unresolvedRefName(): string | null {
  return readCapturedRef() ? null : capturedRefName();
}

function clearNoticeDismissal(): void {
  try {
    globalThis.localStorage?.removeItem(NOTICE_DISMISSED_KEY);
  } catch {
    /* best-effort */
  }
}

/** Stop showing the capture notice for the referrer currently held. */
export function dismissReferralNotice(): void {
  // Same ordering as referralNoticeFor, for the same reason.
  const key = capturedRefName() ?? readCapturedRef();
  if (key) write(NOTICE_DISMISSED_KEY, key);
}

/**
 * The referrer to acknowledge on screen, or null.
 *
 * Null once dismissed, and null once the referral has been posted and cleared —
 * so the notice cannot outlive the thing it describes. Keyed on the address
 * rather than a bare flag so a second, different invite is still acknowledged.
 */
export function referralNoticeFor(): { display: string; key: string } | null {
  const name = capturedRefName();
  const ref = readCapturedRef();
  // A name-carrying link is worth acknowledging BEFORE it resolves — the
  // visitor followed an invite either way, and telling them so must not wait
  // on a registrar read.
  // Keyed on the NAME first, not the address: a name-carrying link is
  // acknowledged before it resolves, and if the key flipped to the address once
  // resolution landed, a visitor who had already dismissed the notice would see
  // it come back. The name is present from the start and never changes.
  const key = name ?? ref;
  if (!key) return null;
  if (read(NOTICE_DISMISSED_KEY) === key) return null;
  return { display: name ? `${name}.woco.eth` : shortRef(ref!), key };
}

/** `0x1234…cdef` — enough to recognise, short enough to read. */
export function shortRef(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
