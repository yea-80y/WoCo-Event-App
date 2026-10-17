/**
 * Asking for no erasure coding must reach bee as a header (#186). bee-js drops a falsy
 * level, and bee 2.8 erasure-codes a multi-chunk /bytes upload that names none - its
 * reference then differs from the plain tree the key ring is checked against, and every
 * ring store fails. Real bee-js against a local server, so the assertion is on the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Bee, RedundancyLevel } from "@ethersphere/bee-js";

process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
delete process.env.ETHERNA_API_KEY;

const { __setBeeForTests } = await import("../src/config/swarm.js");
const { uploadToBytes } = await import("../src/lib/swarm/bytes.js");

async function headersOf(options?: { redundancyLevel?: RedundancyLevel }): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders | null = null;
  const server = createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ reference: "cd".repeat(32) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    __setBeeForTests(new Bee(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    await uploadToBytes(new Uint8Array(5000).fill(1), undefined, options);
  } finally {
    __setBeeForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.ok(seen, "bee was not called");
  return seen;
}

test("redundancy OFF is sent as an explicit level 0", async () => {
  assert.equal((await headersOf({ redundancyLevel: RedundancyLevel.OFF }))["swarm-redundancy-level"], "0");
});

test("other levels still go through bee-js unchanged", async () => {
  assert.equal((await headersOf({ redundancyLevel: RedundancyLevel.STRONG }))["swarm-redundancy-level"], "2");
  assert.equal((await headersOf())["swarm-redundancy-level"], undefined);
});
