/**
 * The organiser's privacy notice (`legal/organiser-notice.ts`).
 *
 * MUTATION: drop the `expectedAddress` comparison and "another account's notice is
 * refused" goes red; let `cleanNoticeText` skip the control-character check and
 * "bidi overrides" goes red; drop the `todo` for a missing contact and "no contact,
 * no invented one" goes red; let `isSafeNoticeHref` accept any scheme and "never
 * script" goes red; render a todo's prompt in public mode and "the public never sees
 * the organiser's checklist" goes red; drop the duplicate or unknown-category check
 * and "a choice outside the list" goes red; drop the months check and the same test
 * goes red; ignore `tailoredMarketing` and "a tailored mailing list" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrganiserNotice,
  validateOrganiserNotice,
  isSafeNoticeHref,
  noticePlainText,
  noticeTodos,
  noticeDate,
  orderFieldLabels,
  organiserNoticeContentTopic,
  ORGANISER_NOTICE_FORMAT,
  NOTICE_NOT_ADDED,
  NOTICE_DEFAULTS,
  type OrganiserNotice,
  type OrganiserNoticeDoc,
} from "../src/legal/organiser-notice.js";
import { ORDER_EMAIL_FIELD_ID } from "../src/event/order-email.js";
import type { OrderField } from "../src/crypto/types.js";

const ADDR = "0x" + "ab".repeat(20);
const POLICY = "https://woco.eth.limo/#/legal/privacy";

function notice(over: Partial<OrganiserNotice> = {}): OrganiserNotice {
  return {
    format: ORGANISER_NOTICE_FORMAT,
    address: ADDR,
    organiserName: "Punk Pub Ltd",
    contactEmail: "privacy@punkpub.example",
    sharing: ["venue"],
    orderRetentionMonths: 6,
    confirmedAt: "2026-10-11T09:00:00.000Z",
    ...over,
  };
}

const fields: OrderField[] = [
  { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: true },
  { id: "name", type: "text", label: "Full name", required: true },
  { id: "diet", type: "select", label: "Dietary needs", required: false, options: ["None", "Vegan"] },
];

function allHrefs(doc: OrganiserNoticeDoc): string[] {
  const out: string[] = [];
  const walk = (c: unknown[]) => c.forEach((x) => typeof x === "object" && x && out.push((x as { href: string }).href));
  for (const s of doc.sections) for (const b of s.blocks) {
    if (b.kind === "p") walk(b.content);
    else if (b.kind === "list") b.items.forEach(walk);
    else if (b.fallback) walk(b.fallback);
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────

test("a well-formed notice validates and keeps only known fields", () => {
  const v = validateOrganiserNotice({ ...notice(), extraSharing: "  Our photographer  " }, ADDR);
  assert.ok(v);
  assert.equal(v.extraSharing, "Our photographer");
  assert.equal(v.organiserName, "Punk Pub Ltd");
});

test("another account's notice is refused, whoever signed it", () => {
  const other = "0x" + "cd".repeat(20);
  assert.equal(validateOrganiserNotice(notice({ address: other }), ADDR), null);
  // Checksummed or mixed case is not the lowercase identity the topic is keyed by.
  assert.equal(validateOrganiserNotice(notice({ address: ADDR.toUpperCase().replace("0X", "0x") }), ADDR), null);
});

test("closed schema: an unknown key or a wrong format refuses the whole notice", () => {
  assert.equal(validateOrganiserNotice({ ...notice(), html: "<b>x</b>" }, ADDR), null);
  // A v1 notice (free-text answers) is refused outright: its organiser re-confirms.
  assert.equal(validateOrganiserNotice({ ...notice(), format: "woco.privacy-notice.v1" }, ADDR), null);
  assert.equal(validateOrganiserNotice({ ...notice(), marketingSoftOptIn: true }, ADDR), null);
  assert.equal(validateOrganiserNotice([notice()], ADDR), null);
  assert.equal(validateOrganiserNotice(null, ADDR), null);
});

test("no name, a bad email, an over-long field or a bad date refuses it", () => {
  assert.equal(validateOrganiserNotice(notice({ organiserName: "   " }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ contactEmail: "not an email" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ contactEmail: "a@b.c\" onclick=\"x" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ extraSharing: "x".repeat(301) }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ confirmedAt: "yesterday" }), ADDR), null);
});

test("bidi overrides and control characters are refused; newlines only where a field is multi-line", () => {
  assert.equal(validateOrganiserNotice(notice({ organiserName: "Punk‮Pub" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ organiserName: "Punk\nPub" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ extraSharing: "a\u0000b" }), ADDR), null);
  // The "anything else" boxes end one of our sentences, so they are single lines.
  assert.equal(validateOrganiserNotice(notice({ extraOrderFormUse: "a\nb" }), ADDR), null);
  assert.ok(validateOrganiserNotice(notice({ postalAddress: "1 High St\nLondon" }), ADDR));
});

test("the topic is keyed by the lowercase account address", () => {
  assert.equal(organiserNoticeContentTopic(ADDR.toUpperCase().replace("0X", "0x")), `woco/legal/privacy-notice/${ADDR}`);
});

// ── Generation ──────────────────────────────────────────────────────────────

test("never blank: with nothing stored it still names the organiser, the processor and every right", () => {
  const doc = buildOrganiserNotice({ notice: null, fallback: { name: "Punk Pub" }, wocoPolicyUrl: POLICY });
  const text = noticePlainText(doc);
  assert.equal(doc.confirmed, false);
  assert.match(text, /This notice is from Punk Pub/);
  assert.match(text, /controller/);
  assert.match(text, /processor/);
  assert.match(text, /erased from the network within 90 days/);
  assert.match(text, /onchain record is public and permanent/);
  assert.match(text, /Information Commissioner's Office/);
  assert.match(text, /0303 123 1113/);
  assert.match(text, /Stripe/);
  assert.match(text, /Amazon SES, UK/);
  assert.match(text, /has not reviewed it yet/);
});

test("with no name at all it still renders, as the event organiser", () => {
  const doc = buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY });
  assert.match(noticePlainText(doc), /This notice is from the event organiser/);
  assert.match(doc.footer[0], /The organiser has not reviewed it yet/);
});

test("no contact, no invented one: a todo, and attendees are pointed at WoCo's address", () => {
  const doc = buildOrganiserNotice({ notice: null, fallback: { name: "Punk Pub" }, wocoPolicyUrl: POLICY });
  assert.ok(noticeTodos(doc).some((t) => t.field === "contactEmail"));
  const text = noticePlainText(doc);
  assert.match(text, /write to WoCo at privacy@woco-net\.com and they will pass your request to us/);
  assert.doesNotMatch(text, /email us at/);
});

test("a confirmed notice reads the organiser's choices and leaves nothing to fill", () => {
  const doc = buildOrganiserNotice({
    notice: notice({ sharing: ["team", "door"], extraSharing: "Our photographer.", extraOrderFormUse: "planning the running order;", orderRetentionMonths: 12 }),
    event: { title: "Gig", orderFields: fields },
    wocoPolicyUrl: POLICY,
  });
  assert.equal(doc.confirmed, true);
  assert.deepEqual(noticeTodos(doc), []);
  const text = noticePlainText(doc);
  assert.match(text, /only as far as they need them to run the event:\n- Our own team, staff and volunteers\n- Door and security staff\n- Our photographer\.\n/);
  assert.doesNotMatch(text, /The venue/);
  assert.match(text, /Our basis is our contract with you\. We also use them for: planning the running order\./);
  assert.match(text, /Your order-form answers: kept while we need them to run the event and deal with any refunds, disputes or questions, then deleted 12 months after the event\.\n/);
  assert.match(text, /Guest lists we download or put on a door scanner: deleted within 12 months of the event/);
  assert.match(text, /email us at privacy@punkpub\.example/);
  assert.match(doc.footer[0], /Last confirmed by Punk Pub Ltd on 11 October 2026/);
});

test("sharing with no one says so, and an 'anything else' answer alone still reads as a list", () => {
  const none = noticePlainText(buildOrganiserNotice({ notice: notice({ sharing: [] }), wocoPolicyUrl: POLICY }));
  assert.match(none, /We don't share your details with anyone else\./);
  assert.match(none, /We never sell your details/);
  const extra = noticePlainText(buildOrganiserNotice({ notice: notice({ sharing: [], extraSharing: "Our caterer" }), wocoPolicyUrl: POLICY }));
  assert.match(extra, /run the event:\n- Our caterer\.\n/);
  assert.doesNotMatch(extra, /don't share/);
});

test("a choice outside the list, a repeated one or a missing one refuses the notice", () => {
  assert.equal(validateOrganiserNotice({ ...notice(), sharing: ["venue", "sponsors"] }, ADDR), null);
  assert.equal(validateOrganiserNotice({ ...notice(), sharing: ["venue", "venue"] }, ADDR), null);
  assert.equal(validateOrganiserNotice({ ...notice(), sharing: "venue" }, ADDR), null);
  const { sharing: _s, ...noSharing } = notice();
  assert.equal(validateOrganiserNotice(noSharing, ADDR), null);
  assert.equal(validateOrganiserNotice({ ...notice(), orderRetentionMonths: 4 }, ADDR), null);
  // Shorter than a card dispute can arrive: never offered, never accepted.
  assert.equal(validateOrganiserNotice({ ...notice(), orderRetentionMonths: 3 }, ADDR), null);
  assert.equal(validateOrganiserNotice({ ...notice(), orderRetentionMonths: "6" }, ADDR), null);
  const { orderRetentionMonths: _m, ...noMonths } = notice();
  assert.equal(validateOrganiserNotice(noMonths, ADDR), null);
  // Stored in the list's own order, whatever order they were picked in.
  assert.deepEqual(validateOrganiserNotice({ ...notice(), sharing: ["partners", "team"] }, ADDR)?.sharing, ["team", "partners"]);
});

test("an unconfirmed draft reads with the defaults a new notice starts from", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  assert.equal(NOTICE_DEFAULTS.orderRetentionMonths, 6);
  assert.match(text, /deleted 6 months after the event/);
  for (const line of ["Our own team, staff and volunteers", "The venue", "Door and security staff", "Co-promoters and partners"]) {
    assert.match(text, new RegExp(`- ${line}`));
  }
  assert.match(text, /choose which events to tell you about/);
});
test("the event's own questions are listed by label; the email field is not repeated", () => {
  const doc = buildOrganiserNotice({ notice: null, event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY });
  const text = noticePlainText(doc);
  assert.match(text, /Your answers to the order form: Full name, Dietary needs\./);
  assert.deepEqual(orderFieldLabels(fields), ["Full name", "Dietary needs"]);
});

test("a site notice mentions its contact form only when it has one", () => {
  const without = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  const withForm = noticePlainText(buildOrganiserNotice({ notice: null, contactForm: true, wocoPolicyUrl: POLICY }));
  assert.doesNotMatch(without, /contact form/);
  assert.match(withForm, /through the contact form on this site/);
  assert.match(withForm, /Your name, email address and message/);
});

test("the public never sees the organiser's checklist; the editor does", () => {
  const doc = buildOrganiserNotice({ notice: null, event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY });
  // The contact email is the one thing only the organiser can supply.
  assert.deepEqual(noticeTodos(doc).map((t) => t.field), ["contactEmail"]);
  const pub = noticePlainText(doc, "public");
  const ed = noticePlainText(doc, "editor");
  assert.doesNotMatch(pub, /To complete/);
  assert.match(pub, new RegExp(NOTICE_NOT_ADDED.replace(".", "\\.")));
  assert.match(ed, /\[To complete: An email address attendees can write to/);
});
test("marketing is the unticked checkout opt-in only - never a soft opt-in the checkout cannot support", () => {
  for (const n of [null, notice(), notice({ tailoredMarketing: true })]) {
    const text = noticePlainText(buildOrganiserNotice({ notice: n, wocoPolicyUrl: POLICY }));
    assert.match(text, /if you tick the box at checkout/);
    assert.match(text, /never ticked for you/);
    assert.match(text, /one-click unsubscribe/);
    assert.doesNotMatch(text, /soft opt-in/);
  }
});

test("a tailored mailing list uses what is kept on it; order answers are never kept for marketing", () => {
  const plain = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY }));
  assert.doesNotMatch(plain, /choose which events to tell you about/);
  const tailored = noticePlainText(buildOrganiserNotice({ notice: notice({ tailoredMarketing: true }), event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY }));
  assert.match(tailored, /the answers kept on it, such as your area, to choose which events to tell you about\. This stops when you unsubscribe\./);
  // Fable 2026-10-13: the booking's answers are deleted on schedule for everyone;
  // only the mailing list keeps anything after that.
  assert.doesNotMatch(tailored, /for as long as you stay on it/);
  assert.equal(validateOrganiserNotice({ ...notice(), tailoredMarketing: "yes" }, ADDR), null);
  // false is stored as absent, so a stored notice never carries a meaningless false.
  assert.equal(validateOrganiserNotice({ ...notice(), tailoredMarketing: false }, ADDR)?.tailoredMarketing, undefined);
});

test("the mailing-list line names the questions kept on it - never a health one", () => {
  const kept: OrderField[] = [
    { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: true },
    { id: "name", type: "text", label: "Full name", required: true, keepOnList: true },
    { id: "area", type: "text", label: "Area", required: false, keepOnList: true },
    { id: "size", type: "text", label: "T-shirt size", required: false },
    { id: "allergy", type: "text", label: "Allergies", required: false, health: true, keepOnList: true },
  ];
  const text = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: kept }, wocoPolicyUrl: POLICY }));
  assert.match(text, /If you join our mailing list: your email address and your answers to Full name, Area, until you unsubscribe\./);
  const none = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY }));
  assert.match(none, /If you join our mailing list: your email address, until you unsubscribe\./);
  const site = noticePlainText(buildOrganiserNotice({ notice: notice(), wocoPolicyUrl: POLICY }));
  assert.match(site, /your email address and any answers an event's form says it keeps, until you unsubscribe/);
});

test("a health question brings its own purpose and basis; a form without one says nothing about health", () => {
  const withHealth: OrderField[] = [{ id: "allergy", type: "text", label: "Allergies", required: false, health: true }];
  const text = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: withHealth }, wocoPolicyUrl: POLICY }));
  assert.match(text, /Your answers about allergies, dietary or access needs: answering is optional, and we use your answer only to look after you at the event, never for marketing\. Our basis is your explicit consent/);
  const without = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY }));
  assert.doesNotMatch(without, /allergies/);
  // A site covers every event, so it says what happens if a form asks.
  const site = noticePlainText(buildOrganiserNotice({ notice: notice(), wocoPolicyUrl: POLICY }));
  assert.match(site, /If our form asks about allergies, dietary or access needs: answering is optional/);
  // Only a literal true counts: an organiser-signed form cannot half-set it.
  const odd = [{ id: "x", type: "text", label: "Allergies", required: false, health: "yes" }] as unknown as OrderField[];
  assert.doesNotMatch(noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: odd }, wocoPolicyUrl: POLICY })), /explicit consent/);
});
test("an event with no questions promises nothing about order-form answers", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: [] }, wocoPolicyUrl: POLICY }));
  assert.doesNotMatch(text, /order-form answers:/);
  assert.match(text, /Guest lists we download/);
});
test("the cancellation message is WoCo's own, not presented as the organiser's purpose", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  assert.match(text, /WoCo also uses some details in its own right[^\n]*refund is on its way/);
});

test("automated decisions are stated for everyone, never asked", () => {
  for (const n of [null, notice()]) {
    const doc = buildOrganiserNotice({ notice: n, wocoPolicyUrl: POLICY });
    assert.ok(!noticeTodos(doc).some((t) => (t.field as string) === "automatedDecisions"));
    assert.match(noticePlainText(doc), /Neither we nor WoCo make decisions about you purely by computer/);
  }
});
test("every link is safe, and only mailto or https", () => {
  const doc = buildOrganiserNotice({ notice: notice(), event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY });
  const hrefs = allHrefs(doc);
  assert.ok(hrefs.length >= 5);
  for (const h of hrefs) assert.ok(isSafeNoticeHref(h), h);
});

test("never script, however the href is spelled", () => {
  for (const h of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "http://example.com",
    "mailto:a@b.c?body=x\"", "mailto:not-an-email", "https://user:pw@example.com"]) {
    assert.equal(isSafeNoticeHref(h), false, h);
  }
  assert.equal(isSafeNoticeHref("mailto:privacy@woco-net.com"), true);
  assert.equal(isSafeNoticeHref("https://stripe.com/privacy"), true);
});

test("copy register: no em or en dashes, no 'Studio', no quantum, no calling email insecure", () => {
  for (const doc of [
    buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }),
    buildOrganiserNotice({ notice: notice({ extraSharing: "x", extraOrderFormUse: "z", tailoredMarketing: true }), event: { title: "Gig", orderFields: fields }, contactForm: true, wocoPolicyUrl: POLICY }),
  ]) {
    for (const mode of ["public", "editor"] as const) {
      const text = noticePlainText(doc, mode);
      assert.doesNotMatch(text, /[–—]/);
      assert.doesNotMatch(text, /studio/i);
      assert.doesNotMatch(text, /quantum/i);
      assert.doesNotMatch(text, /insecure|not secure/i);
      assert.doesNotMatch(text, /legal advice/i);
    }
  }
});

test("the confirm date reads in UTC with no locale", () => {
  assert.equal(noticeDate("2026-10-11T23:30:00.000Z"), "11 October 2026");
  assert.equal(noticeDate("nonsense"), "");
});

test("a stored notice that could not be read is never described as unreviewed", () => {
  const doc = buildOrganiserNotice({ notice: null, fallback: { name: "Punk Pub" }, storedUnavailable: true, wocoPolicyUrl: POLICY });
  assert.doesNotMatch(doc.footer.join(" "), /has not reviewed/);
  assert.match(doc.footer.join(" "), /couldn't be loaded/);
});

test("order-form answers, not the email, are what the browser encrypts", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  assert.match(text, /Your order-form answers are encrypted in your browser/);
  assert.doesNotMatch(text, /Your order details are encrypted/);
  assert.match(text, /Your email address is handled separately/);
});

test("a contact form brings a purpose and a basis, not only a line in what we collect", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, contactForm: true, wocoPolicyUrl: POLICY }));
  assert.match(text, /to reply to your message\. Our basis is our legitimate interest/);
});

test("a mailto can never carry extra headers", () => {
  assert.equal(isSafeNoticeHref("mailto:x?cc=evil@y.z"), false);
  assert.equal(isSafeNoticeHref("mailto:a&b@y.z"), false);
  assert.equal(validateOrganiserNotice(notice({ contactEmail: "a?b@c.d" }), ADDR), null);
});
