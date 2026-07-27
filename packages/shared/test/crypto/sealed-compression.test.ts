/**
 * Sealed-blob compression.
 *
 * Why this is load-bearing: a 20k-contact marketing list serialises to ~4MB of
 * JSON, which hex-encodes to ~8MB of ciphertext and is REJECTED by the server's
 * sealed-blob cap. Gzipping before the seal is what makes a legitimate full-size
 * list storable at all, so these are correctness tests, not optimisation ones.
 *
 * The guarantees under test:
 *   1. Compressed round-trips are lossless.
 *   2. Blobs sealed BEFORE compression existed still open — organisers already
 *      have stored lists, and a failed read means a lost audience.
 *   3. The saving is real at list scale.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  sealJson,
  openJson,
  sealJsonCompressed,
  openJsonAuto,
  gzip,
  gunzip,
  isGzipped,
} from "../../src/crypto/index.js";
import { x25519 } from "@noble/curves/ed25519.js";

function keypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = new Uint8Array(32).fill(7);
  return { priv, pub: x25519.getPublicKey(priv) };
}

function contacts(n: number): unknown {
  return {
    version: 1,
    contacts: Array.from({ length: n }, (_, i) => ({
      email: `person.number${i}@example-mail-provider.com`,
      firstName: "Firstname",
      lastName: "Lastname",
      address1: `${(i % 200) + 1} Alexandra Road South`,
      address2: "Whalley Range",
      postcode: `M${(i % 40) + 1} 1AA`,
      dob: "01/02/1990",
      source: "csv:skiddle-customer-export-2026-07.csv",
      addedAt: "2026-07-27T14:32:11.482Z",
    })),
  };
}

test("gzip round-trips losslessly", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(contacts(50)));
  const back = await gunzip(await gzip(bytes));
  assert.deepEqual(back, bytes);
});

test("a compressed sealed box round-trips", async () => {
  const { priv, pub } = keypair();
  const payload = contacts(200);
  const box = await sealJsonCompressed(pub, payload);
  assert.deepEqual(await openJsonAuto(priv, box), payload);
});

test("openJsonAuto still opens an UNCOMPRESSED legacy blob", async () => {
  // Organisers have lists sealed before compression existed. If this breaks,
  // their stored audience becomes unreadable.
  const { priv, pub } = keypair();
  const payload = contacts(20);
  const legacy = await sealJson(pub, payload);
  assert.deepEqual(await openJsonAuto(priv, legacy), payload);
});

test("the gzip sniff cannot collide with serialised JSON", async () => {
  // Framing is decided before the payload can be parsed, so the sniff is on the
  // magic number. JSON always starts with `{`, `[` or whitespace.
  for (const value of [{ a: 1 }, [1, 2], "str", 42, null]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    assert.equal(isGzipped(bytes), false, `${JSON.stringify(value)} must not look gzipped`);
  }
  assert.equal(isGzipped(await gzip(new TextEncoder().encode("{}"))), true);
  assert.equal(isGzipped(new Uint8Array([])), false, "an empty payload must not crash the sniff");
});

test("compression brings a full-size list under the server's sealed-blob cap", async () => {
  // Mirrors MAX_SEALED_JSON in apps/server/src/routes/marketing.ts.
  const MAX_SEALED_JSON = 6_000_000;
  const { pub } = keypair();
  const payload = contacts(20_000);

  const raw = JSON.stringify(await sealJson(pub, payload)).length;
  const packed = JSON.stringify(await sealJsonCompressed(pub, payload)).length;

  assert.ok(raw > MAX_SEALED_JSON, `uncompressed should exceed the cap, was ${raw}`);
  assert.ok(packed < MAX_SEALED_JSON, `compressed should fit the cap, was ${packed}`);
});
