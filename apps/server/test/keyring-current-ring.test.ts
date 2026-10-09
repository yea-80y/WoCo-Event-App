/**
 * The server's read of an account's current key ring (#186): the anchor names it, the
 * bytes are checked against the reference, and a read never steps back behind a ring
 * already seen.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Wallet } from "ethers";
import { bytesTreeChunks, bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import { buildKeyRing, encodeKeyRing, NO_RING, type KeyRing } from "@woco/shared/keyring/ring";
import { newAccountSecret, passkeyBoxKeypair } from "@woco/shared/keyring/account-secret";
import { signBoxKeyStatement } from "@woco/shared/keyring/box-key";
import { boxKeyRefOf } from "@woco/shared/keyring/ring";
import { ANCHOR_TTL_MS, _setCurrentRingDepsForTests, currentRing } from "../src/lib/keyring/current-ring.js";

const ACCOUNT = "0x" + "ab".repeat(20);
const chunks = new Map<string, Uint8Array>();
let anchor: Map<string, string>;
let anchorReads: number;
let anchorDown: boolean;
let clock: number;

async function ringFor(account: string, gen: number): Promise<{ ring: KeyRing; ref: string }> {
  const priv = new Uint8Array(32).fill(9);
  const coOwner = new Wallet(`0x${bytesToHex(priv)}`).address.toLowerCase();
  const box = passkeyBoxKeypair(new Uint8Array(32).fill(4));
  const statement = signBoxKeyStatement({ parent: account, coOwner, boxKeyRef: boxKeyRefOf(box.publicKey), issuedAt: 1 }, priv);
  const ring = await buildKeyRing({
    parent: account,
    gen,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: Array.from({ length: gen }, () => newAccountSecret()),
    members: [{ statement, boxPublicKey: box.publicKey }],
  });
  const bytes = encodeKeyRing(ring);
  for (const c of bytesTreeChunks(bytes)) chunks.set(c.address, c.chunk);
  return { ring, ref: bytesTreeRoot(bytes) };
}

beforeEach(() => {
  anchor = new Map();
  anchorReads = 0;
  anchorDown = false;
  clock = 1_000_000;
  _setCurrentRingDepsForTests({
    readAnchor: async (a) => {
      anchorReads++;
      if (anchorDown) throw new Error("rpc down");
      return anchor.get(a) ?? NO_RING;
    },
    fetchChunk: async (addr) => {
      const c = chunks.get(addr);
      if (!c) throw new Error("absent");
      return c;
    },
    now: () => clock,
  });
});

test("no anchor entry: no ring (generation 0)", async () => {
  assert.deepEqual(await currentRing(ACCOUNT), { status: "none" });
});

test("the anchor names the ring, read and checked; cached for the TTL, fresh skips it", async () => {
  const { ring, ref } = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${ref}`);
  const r = await currentRing(ACCOUNT);
  assert.equal(r.status, "ring");
  assert.deepEqual(r.status === "ring" && r.ring, ring);
  await currentRing(ACCOUNT);
  assert.equal(anchorReads, 1);
  await currentRing(ACCOUNT, { fresh: true });
  assert.equal(anchorReads, 2);
  clock += ANCHOR_TTL_MS;
  await currentRing(ACCOUNT);
  assert.equal(anchorReads, 3);
});

test("an unreadable chain: unavailable with nothing seen, the last ring once one was", async () => {
  anchorDown = true;
  assert.equal((await currentRing(ACCOUNT)).status, "unavailable");
  anchorDown = false;
  const { ref } = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${ref}`);
  await currentRing(ACCOUNT);
  anchorDown = true;
  const r = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(r.status === "ring" && r.ref, ref);
});

test("a lagging read never steps back to an older generation, or to no ring", async () => {
  const g0 = await ringFor(ACCOUNT, 0);
  const g1 = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${g1.ref}`);
  await currentRing(ACCOUNT);
  anchor.set(ACCOUNT, `0x${g0.ref}`);
  const back = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(back.status === "ring" && back.ref, g1.ref);
  anchor.delete(ACCOUNT);
  const none = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(none.status === "ring" && none.ref, g1.ref);
  // Forward is always taken.
  const g2 = await ringFor(ACCOUNT, 2);
  anchor.set(ACCOUNT, `0x${g2.ref}`);
  const fwd = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(fwd.status === "ring" && fwd.ref, g2.ref);
});

test("bytes that are not the named ring, or a ring of another account, are unavailable", async () => {
  const { ref } = await ringFor(ACCOUNT, 1);
  const forged = new Map(chunks);
  const root = forged.get(ref)!.slice();
  root[root.length - 1] ^= 1;
  _setCurrentRingDepsForTests({
    readAnchor: async () => `0x${ref}`,
    fetchChunk: async (a) => forged.get(a) === undefined ? Promise.reject(new Error("absent")) : (a === ref ? root : forged.get(a)!),
    now: () => clock,
  });
  assert.equal((await currentRing(ACCOUNT)).status, "unavailable");

  const other = await ringFor("0x" + "cd".repeat(20), 1);
  _setCurrentRingDepsForTests({
    readAnchor: async () => `0x${other.ref}`,
    fetchChunk: async (a) => chunks.get(a) ?? Promise.reject(new Error("absent")),
    now: () => clock,
  });
  const r = await currentRing(ACCOUNT);
  assert.equal(r.status, "unavailable");
  assert.match(r.status === "unavailable" ? r.reason : "", /names account/);
});
