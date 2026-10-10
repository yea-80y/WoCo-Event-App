/**
 * The published order key (#642): a reader takes nothing but the exact key the
 * event's `encryptionKeyRef` names.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_KEY_BYTES,
  orderKeyRef,
  isOrderKeyRef,
  verifyOrderKeyChunk,
  fetchOrderKey,
  OrderKeyMismatchError,
} from "../../src/event/order-key.js";
import { encodeSpan } from "../../src/swarm/soc.js";
import { XWING_PUBLIC_KEY_BYTES, deriveXWingKeypairFromSeed } from "../../src/crypto/xwing.js";

const KEY = deriveXWingKeypairFromSeed("0x" + "42".repeat(32)).publicKey;
const REF = orderKeyRef(KEY);
const chunkOf = (payload: Uint8Array, spanLen = payload.length) => {
  const c = new Uint8Array(8 + payload.length);
  c.set(encodeSpan(spanLen), 0);
  c.set(payload, 8);
  return c;
};

test("the order key is exactly an X-Wing public key, and its ref is a 64-hex content address", () => {
  assert.equal(ORDER_KEY_BYTES, XWING_PUBLIC_KEY_BYTES);
  assert.ok(isOrderKeyRef(REF));
  assert.throws(() => orderKeyRef(new Uint8Array(32)), /1216 bytes/);
});

test("a genuine chunk yields exactly the key", () => {
  assert.deepEqual(verifyOrderKeyChunk(REF, chunkOf(KEY)), KEY);
  assert.deepEqual(verifyOrderKeyChunk(REF.toUpperCase(), chunkOf(KEY)), KEY);
});

test("anything else is refused: another key, a tampered byte, a lying span, a wrong length", () => {
  const other = deriveXWingKeypairFromSeed("0x" + "43".repeat(32)).publicKey;
  const tampered = KEY.slice();
  tampered[600] ^= 1;
  for (const chunk of [chunkOf(other), chunkOf(tampered), chunkOf(KEY, 1215), chunkOf(KEY.slice(0, 1215))]) {
    assert.throws(() => verifyOrderKeyChunk(REF, chunk), OrderKeyMismatchError);
  }
  assert.throws(() => verifyOrderKeyChunk("not-a-ref", chunkOf(KEY)), OrderKeyMismatchError);
});

test("fetchOrderKey reads /chunks/{ref} and verifies; a failed or wrong answer throws", async () => {
  const seen: string[] = [];
  const fake = (body: Uint8Array | null, status = 200) =>
    (async (url: string) => {
      seen.push(url);
      return new Response(body ? body.slice().buffer : null, { status });
    }) as unknown as typeof fetch;

  assert.deepEqual(await fetchOrderKey(REF, "https://gw.example/", fake(chunkOf(KEY))), KEY);
  assert.equal(seen[0], `https://gw.example/chunks/${REF}`);
  await assert.rejects(fetchOrderKey(REF, "https://gw.example", fake(null, 404)), /unavailable \(404\)/);
  await assert.rejects(
    fetchOrderKey(REF, "https://gw.example", fake(chunkOf(deriveXWingKeypairFromSeed("0x" + "44".repeat(32)).publicKey))),
    OrderKeyMismatchError,
  );
  await assert.rejects(fetchOrderKey("zz", "https://gw.example", fake(chunkOf(KEY))), OrderKeyMismatchError);
});
