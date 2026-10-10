/**
 * The bee-js response cap (`lib/swarm/bee-read-cap.ts`) against a REAL `Bee`
 * talking to a local server: if a bee-js upgrade stops routing through the axios
 * instance the cap is installed on, or the axios pin drops below the streamed-
 * response fix, these fail here rather than in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bee, Topic } from "@ethersphere/bee-js";

const CAP = 1024;
const REF_SMALL = "aa".repeat(32);
const REF_BIG = "bb".repeat(32);
const hits = new Map<string, number>();

// Swarm-shaped answers: /bytes/{ref} and /feeds/{owner}/{topic}. The big ones
// declare no Content-Length (chunked), so only counting the stream stops them.
const server: Server = createServer((req, res) => {
  const url = req.url ?? "";
  hits.set(url, (hits.get(url) ?? 0) + 1);
  if (url.startsWith("/chunks/")) {
    // A proxy-style 404 page, larger than any chunk.
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<html>" + "x".repeat(16 * 1024) + "</html>");
  }
  const big = url.includes(REF_BIG) || url.startsWith("/feeds/");
  res.writeHead(200, { "content-type": "application/octet-stream", "swarm-feed-index": "0000000000000000" });
  if (!big) return res.end(Buffer.alloc(CAP, 0x7b));
  let sent = 0;
  const pump = () => {
    while (sent < CAP * 64) {
      sent += 256;
      if (!res.write(Buffer.alloc(256, 0x41))) return void res.once("drain", pump);
    }
    res.end();
  };
  pump();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.BEE_URL = base;
delete process.env.ETHERNA_ENABLED;

const { capBeeResponses, isBeeResponseTooLarge } = await import("../src/lib/swarm/bee-read-cap.js");
const { downloadFromBytes } = await import("../src/lib/swarm/bytes.js");
const { ResponseTooLargeError } = await import("../src/lib/http/read-capped.js");
const { wocoBeeSource } = await import("../src/lib/swarm/soc-read.js");
// config/swarm.ts installed the production cap on import; tighten it for the test.
capBeeResponses(CAP);
const bee = new Bee(base);

test.after(() => server.close());

test("a body at the cap is read whole, byte for byte", async () => {
  const data = await bee.downloadData(REF_SMALL);
  assert.deepEqual(data.toUint8Array(), new Uint8Array(CAP).fill(0x7b));
});

test("a buffered body past the cap is refused", async () => {
  await assert.rejects(bee.downloadData(REF_BIG), (e) => isBeeResponseTooLarge(e));
});

test("a streamed body past the cap errors the stream (axios >= 0.31 fix)", async () => {
  const stream = await bee.downloadReadableData(REF_BIG);
  await assert.rejects(
    (async () => {
      for await (const _ of stream as AsyncIterable<unknown>) void _;
    })(),
    (e) => isBeeResponseTooLarge(e),
  );
});

test("a feed read past the cap is refused", async () => {
  const reader = bee.makeFeedReader(Topic.fromString("woco/test"), "cc".repeat(20));
  await assert.rejects(reader.downloadPayload(), (e) => isBeeResponseTooLarge(e));
});

test("downloadFromBytes: oversized is a 413, never retried, and remembered", async () => {
  const path = `/bytes/${REF_BIG}`;
  hits.delete(path);
  await assert.rejects(downloadFromBytes(REF_BIG), (e) => e instanceof ResponseTooLargeError && e.status === 413);
  assert.equal(hits.get(path), 1, "one read, no retry");
  await assert.rejects(downloadFromBytes(REF_BIG), ResponseTooLargeError);
  assert.equal(hits.get(path), 1, "the ref is content-addressed: never fetched again");
});

test("downloadFromBytes still returns a body under the cap unchanged", async () => {
  assert.equal(await downloadFromBytes(REF_SMALL), "{".repeat(CAP));
});

test("a 404 with a body larger than a chunk is still `absent`, not a read failure", async () => {
  assert.deepEqual(await wocoBeeSource.read("dd".repeat(32)), { status: "absent" });
});
