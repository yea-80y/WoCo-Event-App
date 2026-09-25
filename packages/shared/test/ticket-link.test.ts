/**
 * The emailed ticket link format (src/ticket/link.ts) and the scanner's reader
 * of it (parseTicketQr) - the three users of the format must agree, and the
 * ticket must survive anything that happens to the display text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTicketLink,
  parseTicketFragment,
  TICKET_LINK_MAX_CHARS,
} from "../src/ticket/link.js";
import { parseTicketQr } from "../src/checkin/types.js";

const TICKET = {
  eventId: "449ce21d-8503-4dc1-936b-2268b5a8356f",
  seriesId: "series 1/α",
  edition: 7,
  sig: `0x${"ab".repeat(65)}`,
};
const IMAGE = "5e066dd1db71983f18f47a7fb434abb2dd2fb527fb73680beb2a7f6f90e94d0a";

test("round trip: what the email writes is what the page and scanner read", () => {
  const link = buildTicketLink("https://woco.eth.limo/", TICKET, {
    title: "Rooftop Sessions",
    date: "2026-10-12T21:00:00Z",
    location: "The Loft, Leeds",
    series: "GA",
    image: IMAGE,
    gateway: 1,
  });
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, "https://woco.eth.limo/ticket.html");
  assert.equal(url.search, "");
  const parsed = parseTicketFragment(url.hash)!;
  assert.deepEqual(parsed.ticket, TICKET);
  assert.deepEqual(parsed.display, {
    title: "Rooftop Sessions",
    date: "2026-10-12T21:00:00Z",
    location: "The Loft, Leeds",
    series: "GA",
    image: IMAGE,
    gateway: 1,
  });
  assert.deepEqual(parseTicketQr(link), TICKET);
});

test("the link stays under its ceiling by dropping display text, never ticket parts", () => {
  const link = buildTicketLink("https://woco.eth.limo", TICKET, {
    title: "t".repeat(400),
    location: "l".repeat(400),
    series: "s".repeat(400),
    image: IMAGE,
    date: "2026-10-12T21:00:00Z",
  });
  assert.ok(link.length <= TICKET_LINK_MAX_CHARS);
  assert.deepEqual(parseTicketFragment(new URL(link).hash)!.ticket, TICKET);
});

test("a malformed signature, missing part or bad escape reads as no ticket - never a crash", () => {
  for (const hash of [
    "",
    "#",
    `#${TICKET.eventId}/s/7`,
    `#${TICKET.eventId}/s/7/0x1234`,
    `#${TICKET.eventId}/s/0/${TICKET.sig}`,
    `#${TICKET.eventId}/%E0%A4%A/7/${TICKET.sig}`,
  ]) {
    assert.equal(parseTicketFragment(hash), null, hash);
  }
});

test("display fields cannot inject an image host or an unparseable date", () => {
  const link = `https://woco.eth.limo/ticket.html#${TICKET.eventId}/s/7/${TICKET.sig}?i=https%3A%2F%2Fevil.example%2Fx&g=9&d=not-a-date`;
  const { display } = parseTicketFragment(new URL(link).hash)!;
  assert.equal(display.image, undefined, "only a 64-hex reference is an image");
  assert.equal(display.date, undefined);
});

test("parseTicketQr: the QR payload still parses; the retired /t/ path form does not", () => {
  assert.deepEqual(parseTicketQr(`woco://t/${TICKET.eventId}/s/7/${TICKET.sig}`), {
    eventId: TICKET.eventId,
    seriesId: "s",
    edition: 7,
    sig: TICKET.sig,
  });
  assert.equal(parseTicketQr(`https://events-api.woco-net.com/t/${TICKET.eventId}/s/7/${TICKET.sig}`), null);
  assert.equal(parseTicketQr("https://woco.eth.limo/ticket.html"), null);
  assert.equal(parseTicketQr(`woco://t/${TICKET.eventId}/%E0%A4%A/7/${TICKET.sig}`), null);
});

test("ticket parts are never cut, even when they alone exceed the ceiling", () => {
  const huge = { ...TICKET, seriesId: "s".repeat(2000) };
  const link = buildTicketLink("https://woco.eth.limo", huge, { title: "T" });
  assert.deepEqual(parseTicketFragment(new URL(link).hash)!.ticket, huge, "a long ticket is better than a broken one");
});

test("an all-zero image reference means no image, on both sides", () => {
  const link = buildTicketLink("https://woco.eth.limo", TICKET, { image: "0".repeat(64) });
  assert.doesNotMatch(link, /[?&]i=/);
  const hand = `https://woco.eth.limo/ticket.html#${TICKET.eventId}/s/7/${TICKET.sig}?i=${"0".repeat(64)}`;
  assert.equal(parseTicketFragment(new URL(hand).hash)!.display.image, undefined);
});
