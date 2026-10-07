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

const { fetchEventPhoto, sniffPhoto, photoDimensions, PHOTO_MAX_BYTES, PHOTO_TIMEOUT_MS } = await import("../src/lib/ticket/event-photo.ts");
const { renderTicketCardPng, TICKET_FONT_FILES } = await import("../src/lib/ticket/render-card.ts");
const { existsSync } = await import("node:fs");
const { ticketCardSvg } = await import("../src/lib/ticket/card-svg.ts");

const HASH = "ab".repeat(32);
/** A JPEG header: SOI, an APP0 segment, then SOF0 naming the size. */
function jpegOf(w: number, h: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
}
function pngOf(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const JPEG = jpegOf(1600, 900);
const PNG = pngOf(800, 600);

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

test("a body with no Content-Length is cut off at the cap, not buffered whole", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(256 * 1024);
  chunk.set(JPEG);
  const endless = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulled += 1;
      ctrl.enqueue(chunk);
      if (pulled > 1000) ctrl.close();
    },
  });
  const photo = await fetchEventPhoto(HASH, 0, { fetch: (async () => new Response(endless)) as typeof fetch });
  assert.equal(photo, null);
  assert.ok(pulled * chunk.byteLength <= PHOTO_MAX_BYTES + 2 * chunk.byteLength, `read ${pulled} chunks`);
});

test("dimensions come from the header of each format", () => {
  assert.deepEqual(photoDimensions(jpegOf(1600, 900), "image/jpeg"), { width: 1600, height: 900 });
  assert.deepEqual(photoDimensions(pngOf(800, 600), "image/png"), { width: 800, height: 600 });
  assert.deepEqual(photoDimensions(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]), "image/gif"), { width: 320, height: 240 });
  assert.equal(photoDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg"), null, "no frame header");
});

test("a small file claiming a huge image is no photo: decoding it could take the server down", async () => {
  const one = (bytes: Uint8Array) => fetchEventPhoto(HASH, 0, { fetch: (async () => ok(bytes)) as typeof fetch });
  assert.equal(await one(pngOf(20000, 20000)), null);
  assert.equal(await one(jpegOf(6001, 100)), null);
  assert.equal(await one(jpegOf(5000, 5000)), null, "25 MP");
  assert.equal((await one(jpegOf(1600, 900)))?.mime, "image/jpeg");
  assert.equal(await one(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), null, "unreadable size");
});

test("a gateway that never answers is given up on, so fulfilment never hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  let done = false;
  const p = fetchEventPhoto(HASH, 0, { fetch: hanging }).then((r) => {
    done = true;
    return r;
  });
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(PHOTO_TIMEOUT_MS);
  }
  assert.equal(await p, null);
  assert.ok(done);
});

test("the shipped fonts exist and are what draws the text (the server image has none)", async () => {
  for (const f of TICKET_FONT_FILES) assert.ok(existsSync(f), f);
  const card = (eventTitle: string) =>
    renderTicketCardPng({ eventTitle, position: null, qrContent: "woco://t/e/s/1/0x" + "ab".repeat(65) });
  const [a, b] = [await card("Alpha Night"), await card("Omega Night")];
  assert.notDeepEqual(a, b, "with no font, the title draws nothing and both images are identical");
});

test("colours in SVG attributes are escaped too", () => {
  const svg = ticketCardSvg(
    [{ kind: "rect", x: 0, y: 0, w: 1, h: 1, fill: '"/><script>x</script>' }],
    { width: 1, height: 1, qrContent: "x" },
  );
  assert.doesNotMatch(svg, /<script>/);
});
