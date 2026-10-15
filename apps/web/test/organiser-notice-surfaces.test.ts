/**
 * The organiser's privacy notice reaches every page that collects attendee data,
 * and a page never shows a notice the server did not vouch for.
 *
 * Pure helpers are tested directly; the surfaces by SOURCE SCAN (the router and
 * the components declare `$state`, which Node cannot load).
 *
 * MUTATION: let `acceptNoticeData` keep a notice when `trusted` is false and
 * "only a server-vouched notice is shown" goes red; let `publicNoticeView` build
 * a document with no confirmed notice and "only a CONFIRMED notice is shown"
 * goes red; drop the publish check from PublishButton or the site builder and
 * "a paid event publish and a site deploy ask" goes red; drop CheckoutNoticeLinks from
 * StripePayPanel and "both checkout panels link the organiser's notice" goes red;
 * point the embed back at WoCo's policy alone and "the embed links the organiser's
 * notice first" goes red; remove the router's /privacy-notice match and "every
 * shell routes the notice" goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ORGANISER_NOTICE_FORMAT, noticePlainText } from "@woco/shared";
import {
  acceptNoticeData,
  organiserNoticeUrl,
  publicNoticeView,
  stripEmpty,
  WOCO_POLICY_URL,
  type PublicNoticeData,
} from "../src/lib/legal/organiser-notice.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CREATOR = "0x" + "ab".repeat(20);
const notice = {
  format: ORGANISER_NOTICE_FORMAT,
  address: CREATOR,
  organiserName: "Punk Pub Ltd",
  sharing: ["venue"],
  orderRetentionMonths: 6,
  contactEmail: "privacy@punkpub.example",
  confirmedAt: "2026-10-11T09:00:00.000Z",
} as const;
const data = (over: Partial<PublicNoticeData> = {}): PublicNoticeData => ({
  creator: CREATOR,
  feedSigner: "0x" + "cd".repeat(20),
  trusted: true,
  notice: { ...notice },
  noticeStatus: "found",
  ...over,
});

// ── Pure rules ──────────────────────────────────────────────────────────────

test("only a server-vouched notice is shown", () => {
  assert.ok(acceptNoticeData(data())?.notice);
  assert.equal(acceptNoticeData(data({ trusted: false }))?.notice, null, "a legacy event's own creator never selects a notice");
  assert.equal(acceptNoticeData(data({ creator: "0x" + "ef".repeat(20) }))?.notice, null, "a notice for another account");
  assert.equal(acceptNoticeData(data({ notice: { ...notice, organiserName: "" } as never }))?.notice, null);
  assert.equal(acceptNoticeData(null), null);
});

test("only a CONFIRMED notice is shown to the public - never WoCo's pre-filled draft", () => {
  const confirmed = publicNoticeView(acceptNoticeData(data()), { name: "Somebody Else" });
  assert.equal(confirmed.kind, "notice");
  if (confirmed.kind === "notice") {
    assert.equal(confirmed.doc.confirmed, true);
    assert.match(noticePlainText(confirmed.doc), /This notice is from Punk Pub Ltd/, "the organiser's confirmed name wins");
  }
  const none = publicNoticeView(acceptNoticeData(data({ notice: null, noticeStatus: "absent" })), { name: "Punk Pub" });
  assert.deepEqual(none, { kind: "not-confirmed", name: "Punk Pub", legacy: false, site: false });
  const site = publicNoticeView(
    acceptNoticeData(data({ notice: null, noticeStatus: "absent", site: { brandName: "Punk Pub", contactEmail: "hi@punkpub.example", postalAddress: null, contactForm: true } })),
  );
  assert.equal(site.kind, "not-confirmed");
  assert.equal(site.kind === "not-confirmed" && site.site, true);
});

test("a legacy event says it needs publishing again, never 'on sale once they confirm'", () => {
  const v = publicNoticeView(acceptNoticeData(data({ trusted: false, notice: null, noticeStatus: "absent" })));
  assert.equal(v.kind === "not-confirmed" && v.legacy, true);
  const page = code(read("lib/legal/OrganiserNotice.svelte"));
  assert.match(page, /view\.legacy[\s\S]*publish it again/);
});

test("loading, unreachable and unreadable are their own states, never a notice", () => {
  assert.equal(publicNoticeView(undefined).kind, "loading");
  assert.equal(publicNoticeView(null).kind, "unavailable");
  assert.equal(publicNoticeView(acceptNoticeData(data({ notice: null, noticeStatus: "unavailable" }))).kind, "unavailable");
});

test("the public renderer refuses an unconfirmed document as a backstop", () => {
  const view = code(read("lib/legal/OrganiserNoticeView.svelte"));
  assert.match(view, /\{#if mode === "editor" \|\| doc\.confirmed\}/);
  assert.doesNotMatch(code(read("lib/legal/OrganiserNotice.svelte")), /buildOrganiserNotice|fallback:/);
});

test("a paid event publish and a site deploy ask for the notice first", () => {
  const publish = code(read("lib/creator/events/PublishButton.svelte"));
  assert.match(publish, /if \(!\(await noticeLetsPublish\(\)\)\) return;/);
  assert.ok(publish.indexOf("noticeLetsPublish()") < publish.indexOf("createEventStreaming("), "before anything is written");
  assert.match(publish, /if \(!hasPaidSeries \|\| publishBeforeNotice\) return true;/);
  const site = code(read("lib/creator/builder/MultiSiteBuilder.svelte"));
  assert.match(site, /if \(!\(await noticeLetsPublish\(\)\)\) return;/);
  assert.ok(site.indexOf("await noticeLetsPublish()") < site.indexOf("publishSite("));
  assert.match(site, /siteEvents\.length === 0/);
});

test("links are on the canonical host, and the event id is encoded", () => {
  assert.equal(organiserNoticeUrl("abc-123"), "https://woco.eth.limo/#/privacy-notice/abc-123");
  assert.equal(organiserNoticeUrl("a/b?c"), "https://woco.eth.limo/#/privacy-notice/a%2Fb%3Fc");
  assert.equal(WOCO_POLICY_URL, "https://woco.eth.limo/#/legal/privacy");
});

test("an emptied field is absent, not an empty string", () => {
  assert.deepEqual(stripEmpty({ a: " x ", b: "", c: "  ", d: false, e: true }), { a: "x", e: true });
});

// ── Surfaces ────────────────────────────────────────────────────────────────

test("both checkout panels link the organiser's notice and WoCo's policy", () => {
  const links = code(read("lib/attendee/events/claim/CheckoutNoticeLinks.svelte"));
  assert.match(links, /href=\{organiserNoticeUrl\(eventId\)\}/);
  assert.match(links, /href=\{WOCO_POLICY_URL\}/);
  for (const f of ["lib/attendee/events/claim/OrderForm.svelte", "lib/attendee/events/claim/StripePayPanel.svelte"]) {
    assert.match(code(read(f)), /<CheckoutNoticeLinks \{eventId\} \{organiserName\} \/>/, f);
  }
  assert.match(code(read("lib/attendee/events/claim/OrderForm.svelte")), /CHECKOUT_PRIVACY_SUMMARY/);
  // The pay panel collects only an email, which is NOT client-sealed (DATA_INVENTORY §4):
  // it must never borrow the "encrypted in your browser" line.
  const pay = code(read("lib/attendee/events/claim/StripePayPanel.svelte"));
  assert.match(pay, /PAY_PANEL_PRIVACY_SUMMARY/);
  assert.doesNotMatch(pay, /CHECKOUT_PRIVACY_SUMMARY/);
  const claim = code(read("lib/attendee/events/ClaimButton.svelte"));
  assert.equal((claim.match(/\{eventId\}/g) ?? []).length >= 2, true, "ClaimButton passes the event to both panels");
});

test("event pages carry the notice in their footer", () => {
  assert.match(code(read("lib/attendee/events/EventDetail.svelte")), /<footer class="event-legal">\s*<CheckoutNoticeLinks/);
  const sitePage = code(read("lib/components/site/EventPage.svelte"));
  assert.match(sitePage, /<footer class="event-legal">/);
  assert.match(sitePage, /#\/privacy-notice\/\$\{encodeURIComponent\(eventId\)\}/);
});

test("every shell routes the notice: main app, single-event page and organiser sites", () => {
  const router = read("lib/router/router.svelte.ts");
  assert.match(router, /\\\/privacy-notice\\\//);
  assert.match(router, /route: "privacy-notice"/);
  assert.match(router, /"\/creator\/privacy-notice"/);
  assert.match(code(read("App.svelte")), /OrganiserNoticePage\.svelte/);
  assert.match(code(read("CreatorApp.svelte")), /PrivacyNoticeEditor\.svelte/);
  const siteApp = code(read("SiteApp.svelte"));
  assert.match(siteApp, /\/privacy-notice/);
  assert.match(siteApp, /<OrganiserNotice eventId=\{EVENT_ID\}/);
  const multi = read("MultiSiteApp.svelte");
  assert.match(multi, /h === '\/privacy-notice'/);
  assert.match(multi, /<OrganiserNotice/);
  assert.match(multi, /href="#\/privacy-notice">Privacy notice<\/a>/, "the site footer links the organiser's notice");
  assert.match(multi, /WoCo Privacy Policy/);
});

test("the site contact form links the organiser's notice in a new tab", () => {
  const src = read("lib/components/site/sections/ContactFormSection.svelte");
  assert.match(src, /new URL\('#\/privacy-notice', window\.location\.href\)/);
  assert.match(src, /href=\{noticeHref\} target="_blank"/);
  const at = src.indexOf('<p class="privacy-note">');
  const note = src.slice(at, src.indexOf("</p>", at)).replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(note, /[\u2013\u2014]/, "spaced hyphen, never an em dash, in copy");
});

test("the embed links the organiser's notice first, then WoCo's", () => {
  const src = readFileSync(new URL("../../../packages/embed/src/components/woco-tickets.ts", import.meta.url), "utf-8");
  const consent = src.slice(src.indexOf("private renderConsent"), src.indexOf("private get hasOrderForm"));
  const notice = consent.indexOf("this.organiserNoticeUrl");
  const policy = consent.indexOf("/#/legal/privacy");
  assert.ok(notice > 0 && policy > notice, "organiser notice before WoCo policy");
  assert.match(src, /#\/privacy-notice\/\$\{encodeURIComponent\(this\.eventId\)\}/);
});

test("only the notice rail touches the notice's feed route", () => {
  const lib = code(read("lib/legal/organiser-notice.ts"));
  assert.match(lib, /FEED_ROUTES\.privacyNotice/);
  assert.doesNotMatch(lib, /FEED_ROUTES\.profile/);
  // Public reads go through the server, which resolves the trusted signer.
  assert.doesNotMatch(lib, /creatorFeedSigner/);
});

test("a key-ring rotation moves the notice, and stops rather than dropping it on a failed read", () => {
  const src = code(read("lib/keyring/rotate-live.ts"));
  const copy = src.slice(src.indexOf("organiserNoticeContentTopic(parent)"));
  assert.match(copy, /readContentFeedResult<unknown>\(h\.oldSigner\.address, noticeTopic, \{[^}]*thorough: true/);
  assert.match(copy, /notice\.status === "unavailable"\) throw/);
  assert.match(copy, /route: noticeRoute/);
});

test("the notice is written in the shared format - never a hard-coded version string", () => {
  // A literal here outlived the v2 bump once and would have failed every publish.
  for (const f of ["lib/legal/organiser-notice.ts", "lib/creator/privacy/PrivacyNoticeEditor.svelte"]) {
    const src = code(read(f));
    assert.doesNotMatch(src, /woco\.privacy-notice\.v\d/, f);
    assert.match(src, /format: ORGANISER_NOTICE_FORMAT/, f);
  }
});

test("the editor offers choices and reassures: no disclaimer, no network warning, one plain marketing question", () => {
  const ed = code(read("lib/creator/privacy/PrivacyNoticeEditor.svelte"));
  // Owner 2026-10-13: the "not legal advice" line lives in Organiser Terms §4, and
  // the retrievable-versions disclosure there too - never as a scare on this screen.
  assert.doesNotMatch(ed, /legal advice|starting point|someone qualified/i);
  assert.doesNotMatch(ed, /retrievable|the network/i);
  // The checkout now supports the soft opt-in (2026-10-14), but the organiser is
  // asked a plain question about what they email, never for legal vocabulary.
  assert.doesNotMatch(ed, /soft opt-in|without a tick|PECR/i);
  assert.match(ed, /Do you only email people about your own events\?/);
  assert.match(ed, /value="own-events" bind:group=\{draft\.marketingBasis\}/);
  assert.match(ed, /value="consent" bind:group=\{draft\.marketingBasis\}/);
  assert.match(ed, /bind:group=\{draft\.sharing\}/);
  assert.match(ed, /bind:group=\{draft\.orderRetentionMonths\}/);
  assert.match(ed, /bind:checked=\{draft\.tailoredMarketing\}/);
});

test("own-events is a new draft's answer only; a published notice keeps its own, and consent is stored as absent", () => {
  const ed = code(read("lib/creator/privacy/PrivacyNoticeEditor.svelte"));
  const fresh = ed.slice(ed.indexOf("function freshDraft"), ed.indexOf("let draft ="));
  assert.match(fresh, /marketingBasis: NOTICE_DEFAULTS\.marketing/);
  // Loading a published notice reads its basis (absent = consent), never the default.
  const found = ed.slice(ed.indexOf('own.status === "found"'), ed.indexOf("getStripeAccountStatus().catch"));
  assert.match(found, /draft\.marketingBasis = noticeMarketingMode\(n\)/);
  assert.doesNotMatch(found, /NOTICE_DEFAULTS/);
  const pay = ed.slice(ed.indexOf("function payload"), ed.indexOf("const previewDoc"));
  assert.match(pay, /draft\.marketingBasis === "own-events" \? \{ marketingBasis: "own-events" as const \} : \{\}/);
});

test("the question builder pre-sets the sensitive flag, and a sensitive question cannot be required", () => {
  const ed = code(read("lib/creator/events/OrderFieldsEditor.svelte"));
  assert.match(ed, /oninput=\{\(\) => guessFlags\(i\)\}/);
  assert.match(ed, /orderFieldKind\(f\.label\)/);
  // A manual choice sticks while the organiser keeps typing.
  assert.match(ed, /if \(!f \|\| manual\[f\.id\]\) return;/);
  assert.match(ed, /kind\.health \? \{ required: false \}/);
  // The Required tick only exists outside the sensitive branch.
  const branch = ed.slice(ed.indexOf("{#if field.health}"), ed.indexOf("{:else}", ed.indexOf("{#if field.health}")));
  assert.match(branch, /Sensitive question - kept optional and never added to your mailing list\./);
  assert.match(branch, />Not sensitive\?<\/button>/);
  assert.match(branch, /setFlags\(i, \{ health: false \}\)/);
  assert.doesNotMatch(branch, /field\.required/);
});

test("the question builder has no keep-on-mailing-list tick box: every non-sensitive answer is kept (2026-10-15)", () => {
  const ed = code(read("lib/creator/events/OrderFieldsEditor.svelte"));
  assert.doesNotMatch(ed, /keepOnList|keepByDefault/);
  assert.doesNotMatch(ed, /Keep on mailing list/i);
  // One tick box per question, Required, plus the editor's own "collect" toggle.
  const card = ed.slice(ed.indexOf("{#each orderFields"), ed.lastIndexOf("{/each}"));
  assert.equal(card.match(/type="checkbox"/g)?.length, 1);
  assert.match(card, /bind:checked=\{field\.required\}/);
});

test("both checkouts show the health note under a health question", () => {
  const form = code(read("lib/attendee/events/claim/OrderForm.svelte"));
  assert.match(form, /\{#if isHealthField\(field\)\}<span class="field-note">\{HEALTH_FIELD_NOTE\}<\/span>\{\/if\}/);
  const embed = readFileSync(new URL("../../../packages/embed/src/components/woco-tickets.ts", import.meta.url), "utf-8");
  assert.match(embed, /isHealthField\(f\) \? `<span class="field-note">\$\{this\.esc\(HEALTH_FIELD_NOTE\)\}<\/span>`/);
});

test("the new notice-gate copy keeps the register: spaced hyphen, never an em or en dash", () => {
  for (const f of [
    "lib/legal/OrganiserNotice.svelte",
    "lib/creator/privacy/NoticeConfirmPrompt.svelte",
    "lib/creator/home/NextStepCard.svelte",
    "lib/creator/privacy/PrivacyNoticeEditor.svelte",
  ]) {
    assert.doesNotMatch(code(read(f)), /[–—]/, f);
  }
});

test("a refusal that means 'not on sale at all' closes the main app's form", async () => {
  const { isSaleClosedCode } = await import("@woco/shared");
  assert.ok(isSaleClosedCode("PRIVACY_NOTICE_REQUIRED") && isSaleClosedCode("EVENT_NEEDS_REPUBLISH"));
  assert.ok(!isSaleClosedCode("PRIVACY_NOTICE_UNAVAILABLE"), "a fault is not a closure");
  const hook = code(read("lib/attendee/events/claim/useReservation.svelte.ts"));
  assert.match(hook, /if \(isSaleClosedCode\(res\.code\)\) closed = res\.error;/);
  const claim = code(read("lib/attendee/events/ClaimButton.svelte"));
  assert.match(claim, /if \(reservationHook\.closed\) \{\s*showOrderForm = false;\s*intentToCheckout = false;/);
  assert.ok(claim.indexOf("{:else if reservationHook.closed}") < claim.indexOf("{:else if showOrderForm}"));
});

test("a site page never claims what is on sale - its events sell under their own organisers' keys", () => {
  const v = publicNoticeView(acceptNoticeData(data({ trusted: false, notice: null, noticeStatus: "absent", site: { brandName: "Pub", contactEmail: null, postalAddress: null, contactForm: false } })));
  assert.equal(v.kind === "not-confirmed" && !v.legacy && v.site, true);
  assert.match(code(read("lib/legal/OrganiserNotice.svelte")), /view\.site \? "" : ", so tickets for this event aren't on sale"/);
});
