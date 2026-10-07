/**
 * The ticket image's server half: the event photo it embeds and the SVG it
 * renders. The photo decorates a ticket someone paid for, so every way it can
 * fail must end in "no photo", never in a thrown error or a long wait.
 *
 * MUTATION: let fetchEventPhoto throw on a network error, skip the size cap,
 * accept an unrecognised format, or stop falling back to the second gateway,
 * and a case goes red; let a title reach the SVG unescaped and the escaping
 * case goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TICKET_IMAGE_GATEWAYS } from "@woco/shared";
import { ticketCardOps, WOCO_TICKET_COLOURS, TICKET_CARD_WIDTH, TICKET_CARD_HEIGHT } from "@woco/shared/ticket/card";

const { fetchEventPhoto, sniffPhoto, PHOTO_MAX_BYTES } = await import("../src/lib/ticket/event-photo.ts");
const { ticketCardSvg } = await import("../src/lib/ticket/card-svg.ts");

const HASH = "ab".repeat(32);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

const ok = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers });

test("only JPEG, PNG and GIF are recognised", () => {
  assert.equal(sniffPhoto(JPEG), "image/jpeg");
  assert.equal(sniffPhoto(PNG), "image/png");
  assert.equal(sniffPhoto(Uint8Array.from([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(sniffPhoto(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), null, "WebP");
  assert.equal(sniffPhoto(new TextEncoder().encode("<svg")), null);
});

test("the preferred gateway first, the other one when it fails", async () => {
  const asked: string[] = [];
  const photo = await fetchEventPhoto(HASH, 1, {
    fetch: (async (url: string) => {
      asked.push(url);
      return url.startsWith(TICKET_IMAGE_GATEWAYS[1]) ? new Response("gone", { status: 404 }) : ok(JPEG);
    }) as typeof fetch,
  });
  assert.deepEqual(asked, [`${TICKET_IMAGE_GATEWAYS[1]}/bytes/${HASH}`, `${TICKET_IMAGE_GATEWAYS[0]}/bytes/${HASH}`]);
  assert.equal(photo?.mime, "image/jpeg");
});

test("a network error is no photo, never a throw", async () => {
  const photo = await fetchEventPhoto(HASH, 0, {
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(photo, null);
});

test("too large, unrecognised, empty or no image at all: no photo", async () => {
  const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
  big.set(JPEG);
  const one = (r: () => Response) => fetchEventPhoto(HASH, 0, { fetch: (async () => r()) as typeof fetch });
  assert.equal(await one(() => ok(big)), null);
  assert.equal(await one(() => ok(JPEG, { "content-length": String(PHOTO_MAX_BYTES + 1) })), null);
  assert.equal(await one(() => ok(new TextEncoder().encode("<html>"))), null);
  assert.equal(await one(() => ok(new Uint8Array(0))), null);
  let called = false;
  const none = await fetchEventPhoto("0".repeat(64), 0, {
    fetch: (async () => {
      called = true;
      return ok(JPEG);
    }) as typeof fetch,
  });
  assert.equal(none, null);
  assert.equal(called, false, "an all-zero reference is no image - nothing is fetched");
  assert.equal(await fetchEventPhoto(undefined, 0), null);
  assert.equal(await fetchEventPhoto("not-a-hash", 0), null);
});

test("the SVG escapes every text it draws and embeds the photo only when there is one", () => {
  const input = {
    title: `<script>alert("x")</script> & Friends`,
    series: "VIP",
    position: { n: 1, of: 2 },
    colours: WOCO_TICKET_COLOURS,
  };
  const size = { width: TICKET_CARD_WIDTH, height: TICKET_CARD_HEIGHT, qrContent: "woco://t/e/s/1/0x" + "ab".repeat(65) };
  const withPhoto = ticketCardSvg(ticketCardOps({ ...input, hasPhoto: true }), {
    ...size,
    photo: { bytes: Buffer.from(JPEG), mime: "image/jpeg" },
  });
  assert.doesNotMatch(withPhoto, /<script>/);
  assert.match(withPhoto, /&lt;script&gt;/);
  assert.match(withPhoto, /href="data:image\/jpeg;base64,/);
  assert.match(withPhoto, /Ticket 1 of 2/);
  const noPhoto = ticketCardSvg(ticketCardOps({ ...input, hasPhoto: false }), { ...size, photo: null });
  assert.doesNotMatch(noPhoto, /<image/);
});
