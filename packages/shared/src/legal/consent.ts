/**
 * Point-of-collection consent wording — single source of truth.
 *
 * UK GDPR Art. 7(1) evidence is only worth anything if the stored record
 * matches what the person was actually shown. Client and server therefore build
 * it with the SAME pure function, `marketingWording`: the checkout renders what
 * it returns, and create-checkout rebuilds it from the event's own questions and
 * refuses a page whose text differs. Duplicating the wording in a Svelte
 * template would let the two drift silently and quietly void the evidence.
 *
 * Bump the version whenever the wording changes materially - old records keep
 * the text they were captured under. The server stores the entry in
 * MARKETING_WORDING for the mode and version the page sent, so a bump is a new
 * entry there, never an edit.
 */

/** v2 (2026-10-15): the wording names what the mailing list keeps. */
export const MARKETING_CONSENT_VERSION = 2;

/**
 * Shown next to an UNCHECKED opt-in control. Must stay unticked by default:
 * pre-ticked boxes are not valid consent (UK GDPR Recital 32; Planet49, C-673/17).
 * `{keeps}` names what the list keeps besides the email (`marketingWording`).
 */
export const MARKETING_CONSENT_NOTICE =
  "Email me about future events from this organiser. We'll keep your email{keeps} for this. You can unsubscribe at any time.";

// ---------------------------------------------------------------------------
// Two checkout controls (PECR reg. 22(3) soft opt-in, owner 2026-10-14)
// ---------------------------------------------------------------------------

/**
 * Which marketing control a buyer sees. The organiser's CONFIRMED privacy notice
 * decides it (`marketingBasis`, absent = consent), read by the server - never
 * by the page:
 *   - consent:    an unticked "Email me..." box. Ticked = consent, untouched = no.
 *   - own-events: a sentence saying we'll email about the organiser's similar
 *                 events, and an unticked "Don't email me" box. Untouched = the
 *                 soft opt-in, ticked = no.
 * An untouched box means YES in one mode and NO in the other, which is why the
 * page echoes the mode it rendered and create-checkout refuses a mismatch.
 */
export const MARKETING_MODES = ["consent", "own-events"] as const;
export type MarketingMode = (typeof MARKETING_MODES)[number];

/** Where the control was shown - recorded with the choice. */
export const MARKETING_SURFACES = ["order-form", "pay-panel", "embed"] as const;
export type MarketingSurface = (typeof MARKETING_SURFACES)[number];

/** The basis a stored record rests on. Attached when the choice is made, never re-read from the organiser's mode. */
export type MarketingBasis = "consent" | "soft-opt-in";

export const MARKETING_OWN_EVENTS_VERSION = 2;
/** `{organiser}` is the organiser's name from their confirmed notice; `{keeps}` as for consent. */
export const MARKETING_OWN_EVENTS_SENTENCE =
  "We'll email you about similar events from {organiser}, and keep your email{keeps} for this. You can unsubscribe from any email.";
/** Stands alone as a refusal, so the box reads correctly on its own. */
export const MARKETING_OWN_EVENTS_BOX = "Don't email me about similar events";

/** What a control shows: an optional sentence above it, and the box's label. */
export interface MarketingWording {
  sentence?: string;
  box: string;
}

/**
 * Every wording a checkout has ever shown, by mode then version. The server
 * stores the entry for the mode and version the page sent, so a record always
 * holds what that buyer saw. Never edit or remove an entry - add a version.
 */
export const MARKETING_WORDING: Readonly<Record<MarketingMode, Readonly<Record<number, MarketingWording>>>> = {
  consent: {
    1: { box: "Email me about future events from this organiser. You can unsubscribe at any time." },
    2: { box: MARKETING_CONSENT_NOTICE },
  },
  "own-events": {
    1: { sentence: "We'll email you about similar events from {organiser}. You can unsubscribe from any email.", box: MARKETING_OWN_EVENTS_BOX },
    2: { sentence: MARKETING_OWN_EVENTS_SENTENCE, box: MARKETING_OWN_EVENTS_BOX },
  },
};

/** The version each mode renders today. */
export const MARKETING_CURRENT_VERSION: Readonly<Record<MarketingMode, number>> = {
  consent: MARKETING_CONSENT_VERSION,
  "own-events": MARKETING_OWN_EVENTS_VERSION,
};

/**
 * The wording for a mode and version, with the organiser's name and what the
 * list keeps filled in; null for one never shown. `keeps` is `listKeeps` of the
 * event's questions (`event/order-field-kinds.ts`) - taken as plain data so the
 * page, the embed and the server share this one function and nothing else.
 */
export function marketingWording(
  mode: MarketingMode,
  version: number,
  organiser: string | undefined,
  keeps: { name: boolean; answers: readonly string[] },
): MarketingWording | null {
  const w = MARKETING_WORDING[mode]?.[version];
  if (!w) return null;
  const answers = keeps.answers.length ? `your answers to: ${keeps.answers.join(", ")}` : "";
  const values: Record<string, string> = {
    organiser: organiser?.trim() || "this organiser",
    // "your email", "your email and name", "your email and your answers to: A",
    // "your email, name and your answers to: A, B".
    keeps: keeps.name ? (answers ? `, name and ${answers}` : " and name") : answers ? ` and ${answers}` : "",
  };
  // One pass, so a name or label that itself reads "{keeps}" is never filled again.
  const fill = (t: string) => t.replace(/\{(organiser|keeps)\}/g, (_, k: string) => values[k]!);
  return w.sentence ? { sentence: fill(w.sentence), box: fill(w.box) } : { box: fill(w.box) };
}

/** Did the page show exactly this wording? */
export function sameMarketingWording(a: MarketingWording, b: MarketingWording): boolean {
  return a.box === b.box && (a.sentence ?? null) === (b.sentence ?? null);
}

/** What the buyer's box means in the mode they were shown. */
export function marketingDecision(mode: MarketingMode, ticked: boolean): MarketingBasis | "declined" {
  if (mode === "own-events") return ticked ? "declined" : "soft-opt-in";
  return ticked ? "consent" : "declined";
}

/** The control as the page reports it to create-checkout: what it showed, and what the buyer did. */
export interface MarketingChoice {
  mode: MarketingMode;
  ticked: boolean;
  version: number;
  surface: MarketingSurface;
  /**
   * The exact text the page rendered. create-checkout compares it with the text
   * it rebuilds and refuses a difference; absent from a paid session's metadata,
   * which carries a hash of the server's own text instead.
   */
  wording?: MarketingWording;
}

/** The choice for the control as rendered now, with the wording it rendered. */
export function marketingChoice(
  mode: MarketingMode,
  ticked: boolean,
  surface: MarketingSurface,
  wording: MarketingWording | undefined,
): MarketingChoice {
  return { mode, ticked, version: MARKETING_CURRENT_VERSION[mode], surface, ...(wording ? { wording } : {}) };
}

/** Longer than any form create-checkout accepts can produce (20 questions of 200 characters). */
const MAX_WORDING_TEXT = 16_000;
const isWordingText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_WORDING_TEXT;

/**
 * A choice from a request body. `undefined` = none sent (no control shown, so
 * nothing is recorded); `null` = sent but malformed, or a wording never shown.
 */
export function parseMarketingChoice(raw: unknown): MarketingChoice | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!(MARKETING_MODES as readonly unknown[]).includes(o.mode)) return null;
  if (typeof o.ticked !== "boolean") return null;
  if (!(MARKETING_SURFACES as readonly unknown[]).includes(o.surface)) return null;
  const mode = o.mode as MarketingMode;
  if (typeof o.version !== "number" || !MARKETING_WORDING[mode][o.version]) return null;
  const choice: MarketingChoice = { mode, ticked: o.ticked, version: o.version, surface: o.surface as MarketingSurface };
  if (o.wording === undefined) return choice;
  const w = o.wording as Record<string, unknown> | null;
  if (!w || typeof w !== "object" || Array.isArray(w) || !isWordingText(w.box)) return null;
  if (w.sentence !== undefined && !isWordingText(w.sentence)) return null;
  return { ...choice, wording: w.sentence === undefined ? { box: w.box } : { sentence: w.sentence, box: w.box } };
}

/**
 * The control a checkout shows, from its claim-status. The value is API JSON, so
 * anything but the one known value reads as consent mode (also what an older
 * server or an unreadable notice gives) - the server refuses the checkout if that
 * is not the organiser's mode, and the page re-reads and shows the right one.
 */
export function shownMarketingMode(status: { marketingMode?: unknown } | null | undefined): MarketingMode {
  return status?.marketingMode === "own-events" ? "own-events" : "consent";
}

/** create-checkout's refusal when the page showed another mode than the organiser's notice now sets. */
export const MARKETING_MODE_CHANGED = "MARKETING_MODE_CHANGED" as const;
/**
 * create-checkout's refusal when the page's wording is not the one it rebuilds:
 * the event's questions or the organiser's name changed since the page loaded,
 * or the page predates the current version.
 */
export const MARKETING_WORDING_CHANGED = "MARKETING_WORDING_CHANGED" as const;

/** Either refusal: nothing was charged, and the page shows the control again. */
export function isMarketingChanged(code: unknown): boolean {
  return code === MARKETING_MODE_CHANGED || code === MARKETING_WORDING_CHANGED;
}

/**
 * Always shown, regardless of the opt-in state. This is the transactional
 * carve-out — PECR does not treat it as marketing, and it must not be
 * presented as optional or bundled into the consent control.
 */
export const TRANSACTIONAL_EMAIL_NOTICE =
  "We'll email you your ticket and any updates about this event.";

/**
 * Point-of-collection privacy summary. Deliberately concrete about the three
 * things a buyer cannot infer from a generic policy link:
 *   1. the organiser — not WoCo — is the one who receives their details;
 *   2. answers are encrypted in-browser to a key only the organiser holds;
 *   3. order details on a public decentralised network are erased on request
 *      (within 90 days, #546), but the ticket's onchain record is permanent.
 * (3) in particular must be disclosed BEFORE submission, not buried in a policy.
 * Not stored with consent records (only the marketing wording is Art. 7(1)
 * evidence), so a wording change here needs no version bump.
 *
 * DO NOT reintroduce any claim that WoCo destroys a decryption key on request.
 * It was here until 2026-08-01 and was false three ways: WoCo never holds that
 * key (it is HKDF-derived from a identity seed derived client-side from the
 * organiser's wallet signature); no key-destruction code exists; and the key is
 * deterministically re-derivable on any device, so it cannot be destroyed at
 * all. There is also only ONE static X25519 key per organiser, so there is no
 * per-record key even in principle. Stating a capability we do not have, at the
 * point of collection, is the worst place to get this wrong.
 */
/**
 * The pay panel shown when an event has NO order form. The only thing a buyer
 * gives there is an email, and that email is NOT client-sealed: it reaches WoCo
 * in plaintext to send the ticket and Stripe as `customer_email`, and the server
 * seals the minimal record itself (DATA_INVENTORY §4 carve-outs 1-3). So this
 * panel must not borrow CHECKOUT_PRIVACY_SUMMARY's "encrypted in your browser".
 */
export const PAY_PANEL_PRIVACY_SUMMARY =
  "Your details go to the event organiser, who is responsible for them. WoCo uses your email to send your " +
  "ticket, and Stripe receives it with your payment. Your ticket's onchain record is public and permanent.";

export const CHECKOUT_PRIVACY_SUMMARY =
  "Your details go to the event organiser, who is responsible for them. Anything you enter here is " +
  "encrypted in your browser to a key only they hold - WoCo cannot read it. Your order details are " +
  "stored on a public decentralised network: on request we remove them from WoCo straight away and " +
  "erase them from the network within 90 days. Your ticket's onchain record is public and permanent.";
