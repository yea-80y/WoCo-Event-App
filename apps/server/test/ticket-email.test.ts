/**
 * The ticket email (routes/tickets.ts): what a buyer reads, and the attachments
 * that carry their tickets. Every decoration is optional; the tickets are not.
 *
 * MUTATION: let a photo or render failure throw out of buildTicketAttachments,
 * drop the budget re-render, show the hero without a photo, number a single
 * ticket, or show the friends tip on one ticket, and a case goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EMAIL_HASH_SECRET ??= "test-secret-for-ticket-email";
process.env.GATE_TOKEN_SECRET ??= "test-gate-secret-for-ticket-email-0123456789";

const { buildTicketHtml, buildTicketText, buildTicketAttachments, HERO_CID, CARD_BUDGET_BYTES } = await import(
  "../src/routes/tickets.ts"
);

const SIG = "0x" + "ab".repeat(65);
const qr = (n: number) => `woco://t/ev123/ga/${n}/${SIG}`;
const base = {
  to: "buyer@example.com",
  eventId: "ev123",
  eventTitle: "Night Market Live",
  eventDate: "2026-11-14T22:00:00.000Z",
  eventEndDate: "2026-11-15T04:00:00.000Z",
  eventLocation: "The Old Depot, 12 Example Street, Manchester",
  seriesName: "General admission",
  tickets: [{ edition: 37, qrContent: qr(37) }],
};
const group = { ...base, tickets: [37, 38, 39].map((e) => ({ edition: e, qrContent: qr(e) })) };
const PHOTO = { bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: "image/jpeg" as const };

test("one ticket: 'Your ticket', no friends tip, no edition anywhere", () => {
  const html = buildTicketHtml(base);
  assert.match(html, /Your ticket/);
  assert.doesNotMatch(html, /Ticket 1 of/);
  assert.doesNotMatch(html, /Going with friends/);
  assert.doesNotMatch(html, /#0*37\b|\b037\b/);
});

test("a group: each ticket numbered in the order, with its own Open button and the friends tip", () => {
  const html = buildTicketHtml(group);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`Ticket ${n} of 3`));
  assert.equal(html.split('class="btn">Open ticket</a>').length - 1, 3);
  assert.match(html, /Going with friends\?/);
  assert.doesNotMatch(html, /#0*3[789]\b/);
});

test("when, where, calendar and directions come from the event; times are UK time", () => {
  const html = buildTicketHtml(base);
  assert.match(html, /Saturday 14 November 2026/);
  assert.match(html, /22:00 - 04:00/);
  assert.match(html, /The Old Depot/);
  assert.match(html, /https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(html, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=/);
  const bare = buildTicketHtml({ ...base, eventDate: undefined, eventEndDate: undefined, eventLocation: undefined });
  assert.doesNotMatch(bare, /Add to calendar|Get directions/);
});

test("the hero photo appears only when one is attached", () => {
  assert.match(buildTicketHtml(base, { hero: true }), new RegExp(`src="cid:${HERO_CID}"`));
  assert.doesNotMatch(buildTicketHtml(base), /cid:/);
});

test("organiser text is escaped; the reply line appears only with an organiser address", () => {
  const html = buildTicketHtml({ ...base, eventTitle: `<img src=x onerror=alert(1)>`, seriesName: `"VIP" <b>` });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /Reply to this email/);
  assert.match(buildTicketHtml({ ...base, replyTo: "org@example.com" }), /Reply to this email to reach the organiser/);
  assert.match(html, /support@woco-net\.com/);
});

test("the plain-text part carries the facts and a link per ticket", () => {
  const text = buildTicketText(group);
  assert.match(text, /You're going: Night Market Live/);
  assert.match(text, /When: Saturday 14 November 2026, 22:00 - 04:00/);
  assert.equal((text.match(/Ticket \d of 3 \(General admission\): https?:\/\//g) ?? []).length, 3);
  assert.match(text, /WoCo Network Ltd/);
});

test("attachments: photo inline once, one image per ticket, a calendar file", async () => {
  const seen: Array<{ position: unknown; photo: unknown }> = [];
  const { attachments, hero } = await buildTicketAttachments(group, {
    fetchPhoto: async () => PHOTO,
    renderCard: async (d) => {
      seen.push({ position: d.position, photo: d.photo });
      return Buffer.from("png");
    },
  });
  assert.equal(hero, true);
  assert.deepEqual(attachments.map((a) => a.filename), ["event.jpg", "ticket-1-of-3.png", "ticket-2-of-3.png", "ticket-3-of-3.png", "event.ics"]);
  assert.equal(attachments[0].contentId, HERO_CID);
  assert.ok(attachments.slice(1).every((a) => a.contentId === undefined), "tickets are ordinary attachments");
  assert.deepEqual(seen.map((s) => s.position), [{ n: 1, of: 3 }, { n: 2, of: 3 }, { n: 3, of: 3 }]);
  assert.ok(seen.every((s) => s.photo === PHOTO));
  assert.equal(attachments[4].contentType, "text/calendar; charset=utf-8; method=PUBLISH");
});

test("a single ticket is ticket.png with no position", async () => {
  let position: unknown = "unset";
  const { attachments } = await buildTicketAttachments(base, {
    fetchPhoto: async () => null,
    renderCard: async (d) => {
      position = d.position;
      return Buffer.from("png");
    },
  });
  assert.equal(position, null);
  assert.deepEqual(attachments.map((a) => a.filename), ["ticket.png", "event.ics"]);
});

test("images over the budget are re-drawn without the photo", async () => {
  const calls: unknown[] = [];
  const { attachments } = await buildTicketAttachments(group, {
    fetchPhoto: async () => PHOTO,
    renderCard: async (d) => {
      calls.push(d.photo);
      return Buffer.alloc(d.photo ? Math.ceil(CARD_BUDGET_BYTES / 2) : 10);
    },
  });
  assert.equal(calls.length, 6, "three with the photo, then three without");
  assert.ok(calls.slice(3).every((p) => p === null));
  assert.ok(attachments.filter((a) => a.filename.startsWith("ticket-")).every((a) => a.content.length === 10));
});

test("a photo or image failure never stops the email", async () => {
  const noPhoto = await buildTicketAttachments(group, {
    fetchPhoto: async () => {
      throw new Error("gateway down");
    },
    renderCard: async () => Buffer.from("png"),
  });
  assert.equal(noPhoto.hero, false);
  assert.equal(noPhoto.attachments.filter((a) => a.filename.startsWith("ticket-")).length, 3);

  const err = console.error;
  console.error = () => {};
  try {
    const noImages = await buildTicketAttachments(group, {
      fetchPhoto: async () => null,
      renderCard: async () => {
        throw new Error("resvg");
      },
    });
    assert.deepEqual(noImages.attachments.map((a) => a.filename), ["event.ics"]);
  } finally {
    console.error = err;
  }
});
