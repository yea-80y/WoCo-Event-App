/**
 * A device taking its account's current key ring (#186): never steps back, never adopts
 * another lineage, says when it was left out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildKeyRing, boxKeyRefOf, NO_RING, type KeyRing } from "@woco/shared/keyring/ring";
import { newAccountSecret, passkeyBoxKeypair } from "@woco/shared/keyring/account-secret";
import { signBoxKeyStatement } from "@woco/shared/keyring/box-key";
import { adoptKeyRing } from "../src/lib/keyring/adopt.ts";

const PARENT = "0x" + "ab".repeat(20);
function passkey(n: number) {
  const priv = new Uint8Array(32).fill(n);
  const address = new Wallet(`0x${bytesToHex(priv)}`).address.toLowerCase();
  const box = passkeyBoxKeypair(new Uint8Array(32).fill(100 + n));
  const statement = signBoxKeyStatement({ parent: PARENT, coOwner: address, boxKeyRef: boxKeyRefOf(box.publicKey), issuedAt: 1 }, priv);
  return { address, box, member: { statement, boxPublicKey: box.publicKey } };
}
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const A = passkey(1);
const B = passkey(2);
const S0 = newAccountSecret();
const S1 = newAccountSecret();

async function ring(gen: number, secret: Uint8Array, prior: (Uint8Array | null)[], members = [A.member, B.member]): Promise<KeyRing> {
  return buildKeyRing({ parent: PARENT, gen, prev: NO_RING, secret, prior, members });
}

function input(rings: Record<string, KeyRing>, anchor: string | null | "error", over: Partial<Parameters<typeof adoptKeyRing>[0]> = {}) {
  return {
    parent: PARENT,
    coOwner: A.address,
    boxSecretKey: A.box.secretKey,
    seed: hex(S0),
    held: null,
    readAnchor: async () => anchor,
    fetchRing: async (ref: string) => {
      const r = rings[ref];
      if (!r) throw new Error("absent");
      return r;
    },
    ...over,
  };
}

test("no ring: generation 0; an unreadable chain is never taken for none", async () => {
  assert.deepEqual(await adoptKeyRing(input({}, null)), { status: "none" });
  assert.equal((await adoptKeyRing(input({}, "error"))).status, "unreadable");
});

test("a ring at generation 0 is remembered with no secrets; generation 1 gives S_1", async () => {
  const r0 = await ring(0, S0, []);
  const a0 = await adoptKeyRing(input({ ["aa".repeat(32)]: r0 }, "aa".repeat(32)));
  assert.equal(a0.status, "adopted");
  assert.deepEqual(a0.status === "adopted" && a0.chain, { ringRef: "aa".repeat(32), gen: 0, secrets: [] });

  const r1 = await ring(1, S1, [S0]);
  const a1 = await adoptKeyRing(input({ ["bb".repeat(32)]: r1 }, "bb".repeat(32), { held: { ringRef: "aa".repeat(32), gen: 0, secrets: [] } }));
  assert.deepEqual(a1.status === "adopted" && a1.chain, { ringRef: "bb".repeat(32), gen: 1, secrets: [hex(S1)] });
});

test("the ring already held: nothing to do; a lower generation (lagging read): keep what is held", async () => {
  const held = { ringRef: "bb".repeat(32), gen: 2, secrets: [hex(S1), hex(newAccountSecret())] };
  assert.deepEqual(await adoptKeyRing(input({}, "bb".repeat(32), { held })), { status: "current" });
  const r1 = await ring(1, S1, [S0]);
  assert.deepEqual(await adoptKeyRing(input({ ["cc".repeat(32)]: r1 }, "cc".repeat(32), { held })), { status: "older", ringGen: 1 });
  assert.equal((await adoptKeyRing(input({}, null, { held }))).status, "older", "the anchor never goes back to none");
});

test("left out of the ring: keyless, not an error", async () => {
  const r1 = await ring(1, S1, [S0], [B.member]);
  const res = await adoptKeyRing(input({ ["dd".repeat(32)]: r1 }, "dd".repeat(32)));
  assert.equal(res.status, "keyless");
});

test("a ring whose generation 0 is not this device's seed is refused", async () => {
  const r1 = await ring(1, S1, [newAccountSecret()]);
  assert.deepEqual(await adoptKeyRing(input({ ["ee".repeat(32)]: r1 }, "ee".repeat(32))), { status: "foreign" });
  const r0 = await ring(0, newAccountSecret(), []);
  assert.deepEqual(await adoptKeyRing(input({ ["ef".repeat(32)]: r0 }, "ef".repeat(32))), { status: "foreign" });
});

test("a hole in the ring that this device already had stays filled", async () => {
  const S2 = newAccountSecret();
  const r2 = await ring(2, S2, [S0, null]);
  const held = { ringRef: "aa".repeat(32), gen: 1, secrets: [hex(S1)] };
  const res = await adoptKeyRing(input({ ["ff".repeat(32)]: r2 }, "ff".repeat(32), { held }));
  assert.deepEqual(res.status === "adopted" && res.chain.secrets, [hex(S1), hex(S2)]);
});

test("a ring naming another account, or one that cannot be fetched, is unreadable", async () => {
  const OTHER = "0x" + "cd".repeat(20);
  const priv = new Uint8Array(32).fill(1);
  const statement = signBoxKeyStatement({ parent: OTHER, coOwner: A.address, boxKeyRef: boxKeyRefOf(A.box.publicKey), issuedAt: 1 }, priv);
  const foreignRing = await buildKeyRing({ parent: OTHER, gen: 0, prev: NO_RING, secret: S0, prior: [], members: [{ statement, boxPublicKey: A.box.publicKey }] });
  const res = await adoptKeyRing(input({ ["9a".repeat(32)]: foreignRing }, "9a".repeat(32)));
  assert.equal(res.status, "unreadable");
  assert.match(res.status === "unreadable" ? res.reason : "", /another account/);
  assert.equal((await adoptKeyRing(input({}, "12".repeat(32)))).status, "unreadable");
});
