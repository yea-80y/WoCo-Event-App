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

// ── Allocated seating (S5) ──────────────────────────────────────────────────

test("a seat round-trips as parts: rows, a table, wheelchair and companion flags", () => {
  for (const seat of [
    { area: "Rear stalls", row: "D", seat: 7 },
    { area: "Table 3", seat: 5, table: true as const },
    { area: "Stalls", row: "AA", seat: 112, wheelchair: true as const },
    { area: "Circle", row: "B", seat: 2, companion: true as const },
    { area: "Café & Bar", row: "Ä", seat: 999_999 },
  ]) {
    const link = buildTicketLink("https://woco.eth.limo", TICKET, { title: "Night", seat });
    assert.deepEqual(parseTicketFragment(new URL(link).hash)!.display.seat, seat);
  }
});

test("an edited seat that does not make a valid one shows no seat, and never costs the ticket", () => {
  const head = `https://woco.eth.limo/ticket.html#${TICKET.eventId}/s/7/${TICKET.sig}?t=Night`;
  for (const q of [
    "&sa=Stalls",                        // no number
    "&sa=Stalls&sn=0",                    // not a seat number
    "&sa=Stalls&sn=07",                   // not as printed
    "&sa=Stalls&sn=1234567",              // too long
    "&sa=%20Stalls&sn=7",                 // outer space
    "&sa=Sta%E2%80%8Blls&sn=7",           // an invisible character
    `&sa=${"a".repeat(81)}&sn=7`,         // past the layout's cap
    "&sa=Stalls&sr=ROWLABELTOOLONG&sn=7", // row past its cap
    "&sa=&sn=7",                          // empty
  ]) {
    const parsed = parseTicketFragment(new URL(head + q).hash)!;
    assert.equal(parsed.display.seat, undefined, q);
    assert.equal(parsed.display.title, "Night");
    assert.deepEqual(parsed.ticket.edition, 7);
  }
  // A flag only as "1": anything else is no flag.
  const odd = parseTicketFragment(new URL(`${head}&sa=Stalls&sn=7&sw=yes`).hash)!;
  assert.deepEqual(odd.display.seat, { area: "Stalls", seat: 7 });
});

test("a long link gives up series, location, date and image before the seat, and the seat before the title", () => {
  const seat = { area: "Rear stalls", row: "D", seat: 7 };
  const full = { title: "Rooftop Sessions", location: "l".repeat(400), series: "s".repeat(400), image: IMAGE, date: "2026-10-12T21:00:00Z", seat };
  // A ticket part long enough that the display text must give way.
  const long = { ...TICKET, seriesId: "x".repeat(560) };
  const link = buildTicketLink("https://woco.eth.limo", long, full);
  assert.ok(link.length <= TICKET_LINK_MAX_CHARS);
  const parsed = parseTicketFragment(new URL(link).hash)!;
  assert.equal(parsed.display.series, undefined, "series went first");
  assert.deepEqual(parsed.display.seat, seat);
  assert.equal(parsed.display.title, "Rooftop Sessions");
  const tight = parseTicketFragment(new URL(buildTicketLink("https://woco.eth.limo", { ...TICKET, seriesId: "x".repeat(700) }, { title: "t".repeat(80), seat })).hash)!;
  assert.equal(tight.display.seat, undefined, "the seat goes before the title");
  assert.ok(tight.display.title);
});
