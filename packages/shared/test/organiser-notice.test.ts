/**
 * The organiser's privacy notice (`legal/organiser-notice.ts`).
 *
 * MUTATION: drop the `expectedAddress` comparison and "another account's notice is
 * refused" goes red; let `cleanNoticeText` skip the control-character check and
 * "bidi overrides" goes red; drop the `todo` for a missing contact and "no contact,
 * no invented one" goes red; let `isSafeNoticeHref` accept any scheme and "never
 * script" goes red; render a todo's prompt in public mode and "the public never sees
 * the organiser's checklist" goes red.
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
  type OrganiserNoticeV1,
  type OrganiserNoticeDoc,
} from "../src/legal/organiser-notice.js";
import { ORDER_EMAIL_FIELD_ID } from "../src/event/order-email.js";
import type { OrderField } from "../src/crypto/types.js";

const ADDR = "0x" + "ab".repeat(20);
const POLICY = "https://woco.eth.limo/#/legal/privacy";

function notice(over: Partial<OrganiserNoticeV1> = {}): OrganiserNoticeV1 {
  return {
    format: ORGANISER_NOTICE_FORMAT,
    address: ADDR,
    organiserName: "Punk Pub Ltd",
    contactEmail: "privacy@punkpub.example",
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
  const v = validateOrganiserNotice({ ...notice(), sharing: "  The venue's door staff  " }, ADDR);
  assert.ok(v);
  assert.equal(v.sharing, "The venue's door staff");
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
  assert.equal(validateOrganiserNotice({ ...notice(), format: "woco.privacy-notice.v2" }, ADDR), null);
  assert.equal(validateOrganiserNotice([notice()], ADDR), null);
  assert.equal(validateOrganiserNotice(null, ADDR), null);
});

test("no name, a bad email, an over-long field or a bad date refuses it", () => {
  assert.equal(validateOrganiserNotice(notice({ organiserName: "   " }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ contactEmail: "not an email" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ contactEmail: "a@b.c\" onclick=\"x" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ sharing: "x".repeat(1001) }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ confirmedAt: "yesterday" }), ADDR), null);
});

test("bidi overrides and control characters are refused; newlines only where a field is multi-line", () => {
  assert.equal(validateOrganiserNotice(notice({ organiserName: "Punk‮Pub" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ organiserName: "Punk\nPub" }), ADDR), null);
  assert.equal(validateOrganiserNotice(notice({ sharing: "a\u0000b" }), ADDR), null);
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
  assert.match(text, /Amazon SES, London/);
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

test("a confirmed notice uses the organiser's words and drops the todos they filled", () => {
  const doc = buildOrganiserNotice({
    notice: notice({ sharing: "No one else.", retention: "Until 3 months after the event.", orderFormPurpose: "To seat you.", automatedDecisions: "We do not." }),
    event: { title: "Gig", orderFields: fields },
    wocoPolicyUrl: POLICY,
  });
  assert.equal(doc.confirmed, true);
  assert.deepEqual(noticeTodos(doc), []);
  const text = noticePlainText(doc);
  assert.match(text, /We also share your details with: No one else\./);
  assert.match(text, /Your order details: Until 3 months after the event\./);
  assert.match(text, /email us at privacy@punkpub\.example/);
  assert.match(doc.footer[0], /Last confirmed by Punk Pub Ltd on 11 October 2026/);
});

test("the event's own questions are listed by label; the email field is not repeated", () => {
  const doc = buildOrganiserNotice({ notice: null, event: { title: "Gig", orderFields: fields }, wocoPolicyUrl: POLICY });
  const text = noticePlainText(doc);
  assert.match(text, /Your answers to the order form: Full name, Dietary needs\./);
  assert.deepEqual(orderFieldLabels(fields), ["Full name", "Dietary needs"]);
});

test("an event with no questions asks the organiser for no order-form purpose", () => {
  const doc = buildOrganiserNotice({ notice: null, event: { title: "Gig", orderFields: [] }, wocoPolicyUrl: POLICY });
  assert.ok(!noticeTodos(doc).some((t) => t.field === "orderFormPurpose"));
  assert.doesNotMatch(noticePlainText(doc), /order-form answers:/);
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
  const pub = noticePlainText(doc, "public");
  const ed = noticePlainText(doc, "editor");
  assert.doesNotMatch(pub, /To complete/);
  assert.match(pub, new RegExp(`We also share your details with: ${NOTICE_NOT_ADDED.replace(".", "\\.")}`));
  assert.match(pub, /Our basis is usually our contract with you/);
  assert.match(ed, /\[To complete: Anyone else you share attendee details with/);
});

test("marketing is the unticked checkout opt-in unless the organiser says they use the soft opt-in", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  assert.match(text, /if you tick the box at checkout/);
  assert.match(text, /never ticked for you/);
  assert.match(text, /one-click unsubscribe/);
  assert.doesNotMatch(text, /soft opt-in/);
  const soft = noticePlainText(buildOrganiserNotice({ notice: notice({ marketingSoftOptIn: true }), wocoPolicyUrl: POLICY }));
  assert.match(soft, /soft opt-in/);
  assert.equal(validateOrganiserNotice({ ...notice(), marketingSoftOptIn: "yes" }, ADDR), null);
});

test("the cancellation message is WoCo's own, not presented as the organiser's purpose", () => {
  const text = noticePlainText(buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY }));
  assert.match(text, /WoCo also uses some details in its own right[^\n]*refund is on its way/);
});

test("automated decisions are the organiser's to state - never asserted for them", () => {
  const doc = buildOrganiserNotice({ notice: null, wocoPolicyUrl: POLICY });
  assert.ok(noticeTodos(doc).some((t) => t.field === "automatedDecisions"));
  const filled = buildOrganiserNotice({ notice: notice({ automatedDecisions: "We do not." }), wocoPolicyUrl: POLICY });
  assert.ok(!noticeTodos(filled).some((t) => t.field === "automatedDecisions"));
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
    buildOrganiserNotice({ notice: notice({ sharing: "x", retention: "y", orderFormPurpose: "z" }), event: { title: "Gig", orderFields: fields }, contactForm: true, wocoPolicyUrl: POLICY }),
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
