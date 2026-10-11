/**
 * The ORGANISER's privacy notice - the Art. 13 notice an attendee is owed by the
 * party that is actually responsible for their details.
 *
 * Roles (docs/legal/DATA_INVENTORY.md §1, DATA_PROCESSING_ADDENDUM.md §1-2): for
 * attendee email, order-form answers, attendance and contact-form messages the
 * organiser is the CONTROLLER and WoCo is their PROCESSOR. WoCo's own Privacy
 * Policy covers what WoCo controls (accounts, suppression, security); it is not
 * the organiser's notice and cannot stand in for one (ORGANISER_TERMS §4 item 1).
 *
 * Two halves, both pure so client, embed and tests read the same thing:
 *   - the STORED part: what only the organiser can say (who they are, how to
 *     reach them, who else they share with, how long they keep downloads). It is
 *     their own public content, written to their own client-signed feed
 *     (`organiserNoticeContentTopic`), validated here on every read.
 *   - the GENERATED part: every fact WoCo already knows, taken from docs/legal.
 *     A fact the docs do not settle is a `todo` block, never invented.
 *
 * If you change a fact here, the docs/legal sentence it came from must say the
 * same thing - the notice is a promise made in the organiser's name.
 */

import type { OrderField } from "../crypto/types.js";
import { ORDER_EMAIL_FIELD_ID } from "../event/order-email.js";

export const ORGANISER_NOTICE_FORMAT = "woco.privacy-notice.v1" as const;

/** WoCo's privacy contact, as PRIVACY_POLICY §2 names it. */
export const WOCO_PRIVACY_EMAIL = "privacy@woco-net.com";
export const STRIPE_PRIVACY_URL = "https://stripe.com/privacy";
export const ICO_COMPLAINT_URL = "https://ico.org.uk/make-a-complaint/";
export const ICO_PHONE = "0303 123 1113";

/** Link labels shared by every checkout, so the surfaces cannot drift apart. */
export const ORGANISER_NOTICE_LINK_LABEL = "Organiser's privacy notice";
export const WOCO_POLICY_LINK_LABEL = "WoCo Privacy Policy";

/** The organiser-written fields, and the longest each may be. */
export const ORGANISER_NOTICE_LIMITS = {
  organiserName: 120,
  contactEmail: 254,
  postalAddress: 300,
  icoRegistration: 20,
  orderFormPurpose: 1000,
  sharing: 1000,
  retention: 1000,
  automatedDecisions: 1000,
} as const;

export type OrganiserNoticeField = keyof typeof ORGANISER_NOTICE_LIMITS;

/** Fields that may hold line breaks; every other field is a single line. */
const MULTILINE: ReadonlySet<OrganiserNoticeField> = new Set([
  "postalAddress", "orderFormPurpose", "sharing", "retention", "automatedDecisions",
]);

/**
 * What the organiser confirmed. Written ONLY by an explicit confirm, so a stored
 * notice is a confirmed one and `confirmedAt` is when they did it.
 */
export interface OrganiserNoticeV1 {
  format: typeof ORGANISER_NOTICE_FORMAT;
  /** The organiser's account address (0x, lowercase) - must match the account the feed is read for. */
  address: string;
  organiserName: string;
  contactEmail?: string;
  postalAddress?: string;
  icoRegistration?: string;
  orderFormPurpose?: string;
  sharing?: string;
  retention?: string;
  /** Whether the organiser makes purely automated decisions with legal or similar effects (Art. 13(2)(f)). */
  automatedDecisions?: string;
  /**
   * The organiser also emails past buyers about similar events under the PECR
   * "soft opt-in" (ORGANISER_TERMS §5, PRIVACY_POLICY §5). Absent = checkout
   * opt-in only, which is all the platform itself collects.
   */
  marketingSoftOptIn?: boolean;
  /** ISO timestamp of the confirm. */
  confirmedAt: string;
}

/** The organiser's topic: keyed by the ACCOUNT address, owned by their content-feed signer. */
export function organiserNoticeContentTopic(address: string): string {
  return `woco/legal/privacy-notice/${address.toLowerCase()}`;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// C0 controls except tab/newline, DEL, C1 controls, and the bidi overrides that
// can make a rendered line read differently from its bytes.
const BAD_CHARS_SINGLE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const BAD_CHARS_MULTI = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export function isNoticeEmail(s: string): boolean {
  return s.length <= ORGANISER_NOTICE_LIMITS.contactEmail && EMAIL_RE.test(s);
}

/** A clean value for `field`, or null when it is unusable. Empty means absent. */
export function cleanNoticeText(field: OrganiserNoticeField, raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\r\n?/g, "\n").trim();
  if (v === "") return undefined;
  if (v.length > ORGANISER_NOTICE_LIMITS[field]) return null;
  if ((MULTILINE.has(field) ? BAD_CHARS_MULTI : BAD_CHARS_SINGLE).test(v)) return null;
  if (field === "contactEmail" && !isNoticeEmail(v)) return null;
  return v;
}

const KNOWN_KEYS = new Set<string>([
  "format", "address", "confirmedAt", "marketingSoftOptIn", ...Object.keys(ORGANISER_NOTICE_LIMITS),
]);
const OPTIONAL_FIELDS = [
  "contactEmail", "postalAddress", "icoRegistration", "orderFormPurpose", "sharing", "retention", "automatedDecisions",
] as const;

/**
 * The notice a feed holds, or null. Closed schema: an unknown key, a wrong type,
 * an over-long or control-character field, a bad email or a different account's
 * address all refuse the WHOLE payload, and the reader falls back to the
 * pre-filled notice. A half-trusted notice would put words in the organiser's
 * mouth that they did not sign.
 */
export function validateOrganiserNotice(raw: unknown, expectedAddress: string): OrganiserNoticeV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.has(k)) return null;
  if (o.format !== ORGANISER_NOTICE_FORMAT) return null;
  if (typeof o.address !== "string" || !ADDRESS_RE.test(o.address)) return null;
  if (o.address !== expectedAddress.toLowerCase()) return null;
  if (typeof o.confirmedAt !== "string" || !Number.isFinite(Date.parse(o.confirmedAt))) return null;
  const name = cleanNoticeText("organiserName", o.organiserName);
  if (!name) return null;
  const out: OrganiserNoticeV1 = {
    format: ORGANISER_NOTICE_FORMAT,
    address: o.address,
    organiserName: name,
    confirmedAt: o.confirmedAt,
  };
  for (const f of OPTIONAL_FIELDS) {
    const v = cleanNoticeText(f, o[f]);
    if (v === null) return null;
    if (v !== undefined) out[f] = v;
  }
  if (o.marketingSoftOptIn !== undefined) {
    if (typeof o.marketingSoftOptIn !== "boolean") return null;
    if (o.marketingSoftOptIn) out.marketingSoftOptIn = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generated document
// ---------------------------------------------------------------------------

/** Text, or a link. A link's href is one of the constants above or a `mailto:` built from a validated email. */
export type NoticeInline = string | { text: string; href: string };

export type NoticeBlock =
  | { kind: "p"; content: NoticeInline[] }
  | { kind: "list"; items: NoticeInline[][] }
  /**
   * A fact only the organiser can supply. `fallback` (when present) is what the
   * public sees until they do - always a sentence the docs support. Without one
   * the public sees that the organiser has not added it yet.
   */
  | { kind: "todo"; field: OrganiserNoticeField; prompt: string; lead?: string; fallback?: NoticeInline[] };

export interface NoticeSection {
  id: string;
  heading: string;
  blocks: NoticeBlock[];
}

export interface OrganiserNoticeDoc {
  title: string;
  organiserName: string;
  confirmed: boolean;
  sections: NoticeSection[];
  /** The closing lines: who prepared it, and when the organiser confirmed it. */
  footer: string[];
}

export interface OrganiserNoticeInput {
  /** The confirmed notice, already validated; null when there is none. */
  notice: OrganiserNoticeV1 | null;
  /** What the page already knows about the organiser - used only when `notice` is null. */
  fallback?: { name?: string; contactEmail?: string; postalAddress?: string };
  /** The event this notice is shown for. Absent = an organiser-wide notice (a site). */
  event?: { title: string; orderFields?: readonly OrderField[] };
  /** The page also has a contact form (organiser sites). */
  contactForm?: boolean;
  /** Where WoCo's own Privacy Policy is served (always the canonical host). */
  wocoPolicyUrl: string;
}

/** Shown publicly in place of a `todo` with no fallback. */
export const NOTICE_NOT_ADDED = "The organiser has not added this yet.";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `11 October 2026`, in UTC, with no locale dependency. */
export function noticeDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The order-form questions an attendee is asked, by the label they see. Email is listed on its own. */
export function orderFieldLabels(fields: readonly OrderField[] | undefined): string[] {
  const out: string[] = [];
  for (const f of fields ?? []) {
    if (!f || f.id === ORDER_EMAIL_FIELD_ID) continue;
    const label = String(f.label || f.placeholder || f.type || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= 30) break;
  }
  return out;
}

function single(raw: string | undefined, field: OrganiserNoticeField): string | undefined {
  const v = cleanNoticeText(field, raw);
  return v ?? undefined;
}

export function buildOrganiserNotice(input: OrganiserNoticeInput): OrganiserNoticeDoc {
  const n = input.notice;
  const confirmed = n !== null;
  const name = n?.organiserName ?? single(input.fallback?.name, "organiserName") ?? "the event organiser";
  const email = n ? n.contactEmail : single(input.fallback?.contactEmail, "contactEmail");
  const postal = n ? n.postalAddress : single(input.fallback?.postalAddress, "postalAddress");
  const policy: NoticeInline = { text: WOCO_POLICY_LINK_LABEL, href: input.wocoPolicyUrl };
  const wocoMail: NoticeInline = { text: WOCO_PRIVACY_EMAIL, href: `mailto:${WOCO_PRIVACY_EMAIL}` };
  const ev = input.event;
  const labels = orderFieldLabels(ev?.orderFields);

  const where = ev ? `when you book for ${ev.title}` : "when you book with us";
  const intro: NoticeBlock = {
    kind: "p",
    content: [
      `This notice is from ${name}. It explains how we use the details you give us ${where}` +
        (input.contactForm ? " or through the contact form on this site" : "") +
        `. We are responsible for your details (the "controller"). WoCo runs our booking system and handles ` +
        `your details only on our instructions (our "processor").`,
    ],
  };

  // ── Who we are ───────────────────────────────────────────────────────────
  const who: NoticeBlock[] = [{ kind: "p", content: [name] }];
  if (email) {
    who.push({ kind: "p", content: ["Privacy contact: ", { text: email, href: `mailto:${email}` }] });
  } else {
    who.push({ kind: "todo", field: "contactEmail", prompt: "An email address attendees can write to about their details." });
  }
  if (postal) who.push({ kind: "p", content: [`Postal address: ${postal}`] });
  if (n?.icoRegistration) who.push({ kind: "p", content: [`ICO registration number: ${n.icoRegistration}`] });
  who.push({
    kind: "p",
    content: ["You can also write to WoCo at ", wocoMail, " and they will pass your message on to us."],
  });

  // ── What we collect ──────────────────────────────────────────────────────
  const collect: NoticeInline[][] = [
    ["Your email address, so we can send your ticket and any updates about the event."],
  ];
  if (ev) {
    if (labels.length) collect.push([`Your answers to the order form: ${labels.join(", ")}.`]);
  } else {
    collect.push(["Your answers to the questions on our order forms - each event's form shows what it asks."]);
  }
  collect.push(["Your ticket, and whether it was checked in at the door."]);
  if (input.contactForm) collect.push(["Your name, email address and message, if you use the contact form on this site."]);
  collect.push([
    "If you choose to hear about future events: that you agreed, when, and the exact wording you were shown.",
  ]);

  // ── Why, and the legal basis ─────────────────────────────────────────────
  const orderPurpose: NoticeBlock | null =
    n?.orderFormPurpose
      ? { kind: "p", content: [`Your order-form answers: ${n.orderFormPurpose}`] }
      : ev && labels.length === 0
        ? null
        : {
            kind: "todo",
            field: "orderFormPurpose",
            lead: "Your order-form answers: ",
            prompt:
              "Why you ask each order-form question, and your legal basis for it. Questions about health, " +
              "such as dietary or access needs, are special category data and need extra care.",
            fallback: ["Your order-form answers: to run the event you booked. Our basis is usually our contract with you."],
          };

  const why: NoticeBlock[] = [
    {
      kind: "list",
      items: [
        ["To sell you your ticket, send it to you and run the event. Our basis is our contract with you."],
        [
          "To email you about our future events, if you tick the box at checkout. Our basis is your consent. " +
            "The box is never ticked for you, saying no does not affect your ticket, and every email has a " +
            "one-click unsubscribe.",
        ],
        ...(n?.marketingSoftOptIn
          ? [[
              "We may also email people who have bought tickets from us before about similar events, where they " +
                "were given a clear chance to say no and in every email since (the \"soft opt-in\" in the UK's " +
                "electronic marketing rules). You can unsubscribe at any time.",
            ]]
          : []),
      ],
    },
  ];
  if (orderPurpose) why.push(orderPurpose);
  why.push({
    kind: "p",
    content: [
      "WoCo also uses some details in its own right: your IP address, to keep the booking system secure; its " +
        "own list of people who have unsubscribed, so an unsubscribe always sticks; and, if the event is " +
        "cancelled, the email you paid with, to tell you your refund is on its way - a message about your " +
        "booking, not marketing, sent even if you have unsubscribed. Its ",
      policy,
      " explains these.",
    ],
  });

  // ── Who handles it ───────────────────────────────────────────────────────
  const handlers: NoticeBlock[] = [
    {
      kind: "list",
      items: [
        [
          "WoCo Network Ltd (UK) runs our checkout, issues and emails your ticket, stores your order details and " +
            "runs check-in, on our instructions. Your order-form answers are encrypted in your browser to a key " +
            "only we hold, so WoCo cannot read them.",
        ],
        ["Amazon Web Services (Amazon SES, London) sends ticket and event emails for WoCo."],
        [
          "Hetzner (Germany) hosts WoCo's servers, Cloudflare delivers its pages, and Etherna (Italy) is a " +
            "storage gateway for the network described below.",
        ],
        [
          "Stripe takes card payments on our own Stripe account, so we are the seller and our name is on your " +
            "statement. Your card details go straight to Stripe and never pass through WoCo. Stripe is " +
            "responsible for them under ",
          { text: "its own privacy policy", href: STRIPE_PRIVACY_URL },
          ".",
        ],
        ["WoCo's full list of suppliers is in the ", policy, "."],
      ],
    },
  ];
  handlers.push(
    n?.sharing
      ? { kind: "p", content: [`We also share your details with: ${n.sharing}`] }
      : {
          kind: "todo",
          field: "sharing",
          lead: "We also share your details with: ",
          prompt: "Anyone else you share attendee details with, such as the venue, door staff or a co-promoter - or \"no one else\".",
        },
  );

  // ── Storage ──────────────────────────────────────────────────────────────
  const storage: NoticeBlock[] = [
    {
      kind: "p",
      content: [
        "Your order details are encrypted in your browser and, once your payment is confirmed, stored on Swarm - " +
          "a public decentralised storage network run by independent computers around the world. What reaches " +
          "the network cannot be read without our key.",
      ],
    },
    {
      kind: "p",
      content: [
        "Your ticket is a numbered slot on a public blockchain ledger (Arbitrum), held by a single-use address " +
          "created for your purchase - not your email address or your wallet. The slot also records a reference " +
          "to your encrypted order details. This onchain record is public and permanent, and cannot be erased.",
      ],
    },
    {
      kind: "p",
      content: [
        "If your details are corrected, the new version is what is used from then on. The earlier version can " +
          "still be retrieved from the network until its storage lapses.",
      ],
    },
  ];

  // ── Transfers ────────────────────────────────────────────────────────────
  const transfers: NoticeBlock[] = [
    {
      kind: "p",
      content: [
        "Because Swarm's computers are worldwide, your encrypted order details are transferred outside the UK, " +
          "including to countries without a UK adequacy decision. Standard contractual clauses are not possible, " +
          "as there is no one to sign them with. The safeguard is technical: the content is encrypted on your " +
          "device first, so what crosses borders is unreadable data and pseudonymous identifiers.",
      ],
    },
    {
      kind: "p",
      content: [
        "For Stripe (US and Ireland) and WoCo's other conventional suppliers, transfers rely on the UK " +
          "International Data Transfer Addendum or an adequacy decision.",
      ],
    },
  ];

  // ── Retention ────────────────────────────────────────────────────────────
  const retentionItem: NoticeInline[] = n?.retention
    ? [`Your order details: ${n.retention}`]
    : [];
  const retention: NoticeBlock[] = [
    {
      kind: "list",
      items: [
        ["Your ticket and attendance record: until you ask for it to be erased. It is your record of having been there."],
        ...(retentionItem.length ? [retentionItem] : []),
        ["A record of your marketing consent: while we can still email you on that basis, plus 6 months."],
        ["If your ticket email cannot be delivered, WoCo keeps your address until it is put right, or 90 days at most."],
        ["Payment records: 6 years, as tax and company law require."],
        ["WoCo's record that you unsubscribed: kept for good, so it can keep honouring your choice."],
        ["The onchain record of your ticket: permanent."],
      ],
    },
  ];
  if (!n?.retention) {
    retention.push({
      kind: "todo",
      field: "retention",
      lead: "Your order details: ",
      prompt:
        "How long you keep attendee details, including guest lists you download or put on a door scanner.",
      fallback: [
        "Your order details: for as long as we need them to run the event. They are erased when we ask WoCo, " +
          "when we stop using WoCo, or when you ask.",
      ],
    });
  }

  // ── Rights ───────────────────────────────────────────────────────────────
  const contactLine: NoticeInline[] = email
    ? ["To use any of these rights, email us at ", { text: email, href: `mailto:${email}` },
       ". We reply within one month. You can also write to WoCo at ", wocoMail, " and they will pass your request to us."]
    : ["To use any of these rights, write to WoCo at ", wocoMail,
       " and they will pass your request to us. We reply within one month."];
  const rights: NoticeBlock[] = [
    {
      kind: "p",
      content: [
        "You can ask to see your details, correct them, have them erased, restrict or object to how we use " +
          "them, and get a copy to take elsewhere. Where we rely on your consent, you can withdraw it at any " +
          "time - for marketing, the unsubscribe link in every email does it in one click.",
      ],
    },
    { kind: "p", content: contactLine },
    {
      kind: "p",
      content: [
        "We do remove your details when you ask. They are removed from WoCo straight away, and erased from the " +
          "network within 90 days. We also delete you from any guest lists we have downloaded. Erasure cannot " +
          "reach a copy someone else stored on the network and pays for themselves, short-lived caches, or the " +
          "onchain record of your ticket. If the event is later cancelled, WoCo still tells you your refund is " +
          "on its way.",
      ],
    },
    {
      kind: "p",
      content: [
        "A few records are kept after erasure: WoCo's record that you unsubscribed, so you are not emailed " +
          "again, and payment records the law requires.",
      ],
    },
  ];

  // ── Complaints ───────────────────────────────────────────────────────────
  const complaints: NoticeBlock[] = [
    {
      kind: "p",
      content: [
        "If you are unhappy with how we handle your details, please tell us first. You also have the right to " +
          "complain to the Information Commissioner's Office (ICO) at ",
        { text: "ico.org.uk/make-a-complaint", href: ICO_COMPLAINT_URL },
        ` or on ${ICO_PHONE}.`,
      ],
    },
  ];

  // ── Automated decisions (Art. 13(2)(f)) - the docs do not settle this ────
  const automated: NoticeBlock = n?.automatedDecisions
    ? { kind: "p", content: [n.automatedDecisions] }
    : {
        kind: "todo",
        field: "automatedDecisions",
        prompt:
          "Whether you make decisions about attendees by purely automated means that have legal or similarly " +
          "significant effects on them. Say so either way.",
      };

  // ── Required? ────────────────────────────────────────────────────────────
  const required: NoticeBlock[] = [
    {
      kind: "p",
      content: [
        "To book, you need to give an email address and answer the questions marked as required - without " +
          "them we cannot sell you a ticket or run the event. Hearing about future events is always optional.",
      ],
    },
  ];

  const footer = confirmed
    ? [`Last confirmed by ${name} on ${noticeDate(n!.confirmedAt)}.`, "Prepared with WoCo's privacy notice tool."]
    : [
        `Pre-filled by WoCo from the details it holds. ${name === "the event organiser" ? "The organiser" : name} ` +
          "has not reviewed it yet.",
      ];

  return {
    title: `Privacy notice - ${name}`,
    organiserName: name,
    confirmed,
    footer,
    sections: [
      { id: "intro", heading: "", blocks: [intro] },
      { id: "who", heading: "Who we are", blocks: who },
      { id: "collect", heading: "What we collect", blocks: [{ kind: "list", items: collect }] },
      { id: "why", heading: "Why we use it, and our legal basis", blocks: why },
      { id: "handlers", heading: "Who handles your details for us", blocks: handlers },
      { id: "storage", heading: "Where your details are stored", blocks: storage },
      { id: "transfers", heading: "International transfers", blocks: transfers },
      { id: "retention", heading: "How long we keep your details", blocks: retention },
      { id: "rights", heading: "Your rights", blocks: rights },
      { id: "complaints", heading: "Complaints", blocks: complaints },
      { id: "automated", heading: "Automated decisions", blocks: [automated] },
      { id: "required", heading: "Do you have to give us your details?", blocks: required },
    ],
  };
}

/**
 * Hrefs a notice may render. Everything the generator emits is one of these;
 * a renderer checks again so a future edit cannot slip a `javascript:` in.
 */
export function isSafeNoticeHref(href: string): boolean {
  if (href.startsWith("mailto:")) return isNoticeEmail(href.slice("mailto:".length));
  try {
    const u = new URL(href);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Every todo the organiser has not filled - the editor's checklist. */
export function noticeTodos(doc: OrganiserNoticeDoc): Extract<NoticeBlock, { kind: "todo" }>[] {
  return doc.sections.flatMap((s) => s.blocks.filter((b): b is Extract<NoticeBlock, { kind: "todo" }> => b.kind === "todo"));
}

/** The notice as plain text - for a copy button, and so tests can read it whole. */
export function noticePlainText(doc: OrganiserNoticeDoc, mode: "public" | "editor" = "public"): string {
  const inline = (c: NoticeInline[]) => c.map((x) => (typeof x === "string" ? x : x.text)).join("");
  const lines: string[] = [doc.title, ""];
  for (const s of doc.sections) {
    if (s.heading) lines.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === "p") lines.push(inline(b.content));
      else if (b.kind === "list") for (const it of b.items) lines.push(`- ${inline(it)}`);
      else if (mode === "editor") lines.push(`[To complete: ${b.prompt}]`);
      else lines.push(b.fallback ? inline(b.fallback) : `${b.lead ?? ""}${NOTICE_NOT_ADDED}`);
    }
    lines.push("");
  }
  lines.push(...doc.footer);
  return lines.join("\n");
}
