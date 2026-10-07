/**
 * The ticket image's layout (src/ticket/card.ts), shared by the server's PNG and
 * the browser's download. What it must never show is the global ticket number;
 * what it must always show is the position in this order and the QR, inside the
 * card, clear of everything else.
 *
 * MUTATION: make ticketPositionLabel number a single ticket, drop the time zone
 * from ticketWhen, let a long title run to three lines, or move the QR over the
 * captions, and a case goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TIME_ZONE,
  TICKET_CARD_HEIGHT,
  TICKET_CARD_WIDTH,
  WOCO_TICKET_COLOURS,
  estimateTextWidth,
  splitLocation,
  ticketCardColours,
  ticketCardOps,
  ticketPositionLabel,
  ticketWhen,
  type TicketCardInput,
  type TicketCardOp,
} from "../src/ticket/card.js";

const base: TicketCardInput = {
  title: "Night Market Live",
  startIso: "2026-11-14T22:00:00Z",
  endIso: "2026-11-15T04:00:00Z",
  location: "The Old Depot, 12 Example Street, Manchester M4 6BF",
  series: "General admission",
  position: { n: 2, of: 4 },
  hasPhoto: true,
  colours: WOCO_TICKET_COLOURS,
};

const texts = (ops: TicketCardOp[]) => ops.flatMap((o) => (o.kind === "text" ? [o] : []));

test("position: a group order says which ticket, a single ticket says only 'Your ticket'", () => {
  assert.equal(ticketPositionLabel({ n: 2, of: 4 }), "Ticket 2 of 4");
  assert.equal(ticketPositionLabel({ n: 1, of: 1 }), "Your ticket");
  assert.equal(ticketPositionLabel(undefined), "Your ticket");
});

test("times are in the event's zone (UK), across the clock change", () => {
  assert.equal(EVENT_TIME_ZONE, "Europe/London");
  assert.deepEqual(ticketWhen("2026-11-14T22:00:00Z", "2026-11-15T04:00:00Z"), { day: "Sat 14 Nov 2026", time: "22:00 - 04:00" });
  // British Summer Time: 21:00Z is 22:00 in London.
  assert.deepEqual(ticketWhen("2026-07-04T21:00:00Z"), { day: "Sat 4 Jul 2026", time: "22:00" });
  // A late start crosses midnight UTC but not in London.
  assert.equal(ticketWhen("2026-07-04T23:30:00Z").day, "Sun 5 Jul 2026");
  assert.equal(ticketWhen("2026-11-14T22:00:00Z", "2026-11-14T20:00:00Z").time, "22:00", "an end before the start is ignored");
  assert.equal(ticketWhen("2026-11-14T22:00:00Z", undefined, "long").day, "Saturday 14 November 2026");
  assert.deepEqual(ticketWhen("not a date"), {});
  assert.deepEqual(ticketWhen(undefined), {});
});

test("location splits into the venue and the rest at the first comma", () => {
  assert.deepEqual(splitLocation("The Old Depot, 12 Example Street, Manchester"), {
    venue: "The Old Depot",
    rest: "12 Example Street, Manchester",
  });
  assert.deepEqual(splitLocation("Somewhere"), { venue: "Somewhere" });
  assert.deepEqual(splitLocation("  "), {});
});

test("the card shows the order position and never a global ticket number", () => {
  const ops = ticketCardOps(base);
  const all = texts(ops).map((t) => t.text);
  assert.ok(all.includes("Ticket 2 of 4"));
  assert.ok(all.includes("Night Market Live"));
  assert.ok(all.includes("Sat 14 Nov 2026") && all.includes("22:00 - 04:00"));
  assert.ok(all.includes("The Old Depot"));
  assert.ok(all.includes("General admission"));
  for (const t of all) assert.doesNotMatch(t, /#\s?\d|of \d{3,}|edition/i, t);
  assert.equal(ops.filter((o) => o.kind === "qr").length, 1);
});

test("no photo, no photo step; a single ticket says 'Your ticket'", () => {
  const ops = ticketCardOps({ ...base, hasPhoto: false, position: undefined });
  assert.equal(ops.some((o) => o.kind === "photo" || o.kind === "fade"), false);
  assert.ok(texts(ops).some((t) => t.text === "Your ticket"));
});

test("a long title wraps to at most two lines, each inside the card", () => {
  const title = "An Extraordinarily Long Festival Name That Keeps Going Well Past Any Sensible Length";
  const lines = texts(ticketCardOps({ ...base, title })).filter((t) => t.size === 64);
  assert.ok(lines.length <= 2 && lines.length >= 1);
  assert.ok(lines[lines.length - 1].text.endsWith("…"));
  for (const l of lines) assert.ok(estimateTextWidth(l.text, 64, "sans", 700) <= TICKET_CARD_WIDTH - 112);
});

test("everything sits inside the card, and the QR clears the dash and the captions", () => {
  for (const title of ["X", base.title, "Two Words Two Words Two Words Two Words Two Words"]) {
    for (const hasPhoto of [true, false]) {
      const ops = ticketCardOps({ ...base, title, hasPhoto });
      for (const t of texts(ops)) {
        assert.ok(t.y > 0 && t.y < TICKET_CARD_HEIGHT, `${t.text} y=${t.y}`);
        const w = estimateTextWidth(t.text, t.size, t.font, t.weight, t.letterSpacing ?? 0);
        const left = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w : t.x - w / 2;
        assert.ok(left >= 0 && left + w <= TICKET_CARD_WIDTH, `${t.text} overruns`);
      }
      const qr = ops.find((o) => o.kind === "qr")!;
      const dash = ops.find((o) => o.kind === "dash")!;
      const firstCaption = texts(ops).find((t) => t.text.startsWith("One entry"))!;
      assert.ok(qr.kind === "qr" && dash.kind === "dash");
      assert.ok(qr.y > dash.y, "QR below the tear line");
      assert.ok(qr.y + qr.size < firstCaption.y - firstCaption.size, "QR above the captions");
      assert.ok(qr.x >= 0 && qr.x + qr.size <= TICKET_CARD_WIDTH);
    }
  }
});

test("an organiser palette recolours the card; none keeps WoCo's look", () => {
  assert.deepEqual(ticketCardColours(undefined), WOCO_TICKET_COLOURS);
  const c = ticketCardColours({ bg: "#ffffff", text: "#111111", accent: "#ff0055", muted: "#666666" });
  assert.equal(c.bg, "#ffffff");
  assert.equal(c.accent, "#ff0055");
  assert.equal(c.dim, "#666666");
});
