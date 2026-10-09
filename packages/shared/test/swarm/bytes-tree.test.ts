/**
 * `/bytes` trees (#186): the locally computed reference must be bee's, and a read
 * must refuse any chunk that does not hash to the address its parent names.
 * Cross-checked against bee-js's own splitter, a separate code path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MerkleTree } from "@ethersphere/bee-js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BytesTreeMismatchError, bytesTreeChunks, bytesTreeRoot, readBytesTree } from "../../src/swarm/bytes-tree.js";

function data(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 31 + 7) & 0xff;
  return d;
}

async function beeRoot(d: Uint8Array): Promise<string> {
  const tree = new MerkleTree(async () => {});
  await tree.append(d);
  return bytesToHex((await tree.finalize()).hash());
}

function store(d: Uint8Array): Map<string, Uint8Array> {
  return new Map(bytesTreeChunks(d).map((c) => [c.address, c.chunk]));
}

const fetchFrom = (m: Map<string, Uint8Array>) => async (a: string) => {
  const c = m.get(a);
  if (!c) throw new Error(`missing ${a}`);
  return c;
};

for (const n of [1, 100, 4095, 4096, 4097, 8192, 30_000, 128 * 4096]) {
  test(`root of ${n} bytes is bee's, and the tree reads back exactly`, async () => {
    const d = data(n);
    const root = bytesTreeRoot(d);
    assert.equal(root, await beeRoot(d));
    assert.deepEqual(await readBytesTree(root, fetchFrom(store(d)), n), d);
  });
}

test("more than one level is refused, never guessed", () => {
  assert.throws(() => bytesTreeRoot(data(128 * 4096 + 1)), /more than one level/);
  assert.throws(() => bytesTreeRoot(new Uint8Array(0)), /empty/);
});

test("a substituted leaf is refused", async () => {
  const d = data(10_000);
  const m = store(d);
  const leafAddr = bytesTreeChunks(d)[1]!.address;
  const forged = m.get(leafAddr)!.slice();
  forged[20] ^= 1;
  m.set(leafAddr, forged);
  await assert.rejects(readBytesTree(bytesTreeRoot(d), fetchFrom(m), 10_000), BytesTreeMismatchError);
});

test("a whole different blob served under the reference is refused", async () => {
  const d = data(10_000);
  const other = data(9_000).map((b) => b ^ 0x55);
  const m = store(other);
  const otherRoot = bytesTreeRoot(other);
  // Serve the other blob's root chunk under this reference.
  const lying = async (a: string) => (a === bytesTreeRoot(d) ? m.get(otherRoot)! : fetchFrom(m)(a));
  await assert.rejects(readBytesTree(bytesTreeRoot(d), lying, 10_000), BytesTreeMismatchError);
});

test("the size bound is checked at the root, before any child is fetched", async () => {
  const d = data(10_000);
  const m = store(d);
  let fetched = 0;
  const counting = async (a: string) => {
    fetched++;
    return fetchFrom(m)(a);
  };
  await assert.rejects(readBytesTree(bytesTreeRoot(d), counting, 9_999), /larger than/);
  assert.equal(fetched, 1);
});

test("a malformed reference is refused", async () => {
  await assert.rejects(readBytesTree("AB".repeat(32), async () => new Uint8Array(), 10), /64 lowercase hex/);
});

test("a tree that is not the shape bee makes for its size is refused at the root: no deep single-child chains", async () => {
  const { calculateCacAddress, encodeSpan } = await import("../../src/swarm/soc.js");
  const store = new Map<string, Uint8Array>();
  const put = (span: number, payload: Uint8Array): string => {
    const s = encodeSpan(span);
    const addr = bytesToHex(calculateCacAddress(s, payload));
    const chunk = new Uint8Array(s.length + payload.length);
    chunk.set(s);
    chunk.set(payload, s.length);
    store.set(addr, chunk);
    return addr;
  };
  // A chain of intermediates, each with ONE child and the same 5000-byte span.
  let ref = put(5000, new Uint8Array(32).fill(1));
  for (let i = 0; i < 50; i++) {
    const p = new Uint8Array(32);
    p.set(Buffer.from(ref, "hex"));
    ref = put(5000, p);
  }
  let fetched = 0;
  const fetch = async (a: string) => {
    fetched++;
    return fetchFrom(store)(a);
  };
  await assert.rejects(readBytesTree(ref, fetch, 10_000), /children its span needs/);
  assert.equal(fetched, 1, "refused before any child is fetched");
});
