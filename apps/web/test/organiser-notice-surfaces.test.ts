/**
 * The organiser's privacy notice reaches every page that collects attendee data,
 * and a page never shows a notice the server did not vouch for.
 *
 * Pure helpers are tested directly; the surfaces by SOURCE SCAN (the router and
 * the components declare `$state`, which Node cannot load).
 *
 * MUTATION: let `acceptNoticeData` keep a notice when `trusted` is false and
 * "only a server-vouched notice is shown" goes red; drop CheckoutNoticeLinks from
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
  publicNoticeDoc,
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

test("never blank: no data at all still renders the pre-filled notice under the page's name", () => {
  const doc = publicNoticeDoc(null, { name: "Punk Pub" });
  assert.equal(doc.confirmed, false);
  assert.match(noticePlainText(doc), /This notice is from Punk Pub/);
  const confirmed = publicNoticeDoc(acceptNoticeData(data()), { name: "Somebody Else" });
  assert.equal(confirmed.confirmed, true);
  assert.match(noticePlainText(confirmed), /This notice is from Punk Pub Ltd/, "the organiser's confirmed name wins");
});

test("a site's contact details pre-fill an unconfirmed site notice", () => {
  const doc = publicNoticeDoc(
    acceptNoticeData(data({ notice: null, site: { brandName: "Punk Pub", contactEmail: "hi@punkpub.example", postalAddress: null, contactForm: true } })),
  );
  const text = noticePlainText(doc);
  assert.match(text, /Privacy contact: hi@punkpub\.example/);
  assert.match(text, /contact form on this site/);
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
