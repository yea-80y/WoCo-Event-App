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

test("a read below a generation seen pauses the account - never an older generation, no ring, or the ring remembered", async () => {
  const g0 = await ringFor(ACCOUNT, 0);
  const g1 = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${g1.ref}`);
  await currentRing(ACCOUNT);
  anchor.set(ACCOUNT, `0x${g0.ref}`);
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "unavailable");
  anchor.delete(ACCOUNT);
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "unavailable");
  // Caught up again: the chain's answer is taken.
  anchor.set(ACCOUNT, `0x${g1.ref}`);
  const caught = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(caught.status === "ring" && caught.ref, g1.ref);
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

test("a ring cached for one account is never another account's, whatever its anchor names", async () => {
  const a = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${a.ref}`);
  assert.equal((await currentRing(ACCOUNT)).status, "ring");
  const B = "0x" + "cd".repeat(20);
  anchor.set(B, `0x${a.ref}`); // B points its own entry at A's ring
  const r = await currentRing(B);
  assert.equal(r.status, "unavailable");
});

test("an unreadable chain is reported without the RPC's URL", async () => {
  _setCurrentRingDepsForTests({
    readAnchor: async () => {
      const e = new Error("HTTP request failed.\n\nURL: https://arb-mainnet.example/v2/SECRETKEY\nRequest body: {}");
      (e as Error & { shortMessage: string }).shortMessage = "HTTP request failed.";
      throw e;
    },
    now: () => clock,
  });
  const r = await currentRing(ACCOUNT);
  assert.equal(r.status, "unavailable");
  assert.doesNotMatch(r.status === "unavailable" ? r.reason : "", /SECRETKEY|https?:/);
  _setCurrentRingDepsForTests({ readAnchor: async () => { throw new Error("URL: https://x/SECRETKEY"); }, now: () => clock });
  const r2 = await currentRing(ACCOUNT);
  assert.doesNotMatch(r2.status === "unavailable" ? r2.reason : "", /SECRETKEY/);
});


test("health: red when no contract answers at the anchor; a failed read keeps the last verdict", async () => {
  const { refreshKeyRingAnchor, keyRingHealth } = await import("../src/lib/keyring/current-ring.js");
  let code: string | Error = "0x";
  _setCurrentRingDepsForTests({
    readAnchorCode: async () => {
      if (code instanceof Error) throw code;
      return code;
    },
    now: () => clock,
  });
  await refreshKeyRingAnchor();
  assert.equal(keyRingHealth().ok, false, "no code: alarm");
  code = "0x6080604052";
  await refreshKeyRingAnchor();
  assert.equal(keyRingHealth().ok, true);
  code = Object.assign(new Error("URL: https://x/SECRETKEY"), { shortMessage: "HTTP request failed." });
  await refreshKeyRingAnchor();
  const h = keyRingHealth();
  assert.equal(h.ok, true, "an RPC blip says nothing about the contract");
  assert.doesNotMatch(h.reason ?? "", /SECRETKEY/);
});

test("bytes that verify but are no ring are not fetched again; a ring not found waits a minute", async () => {
  const { ref } = await ringFor(ACCOUNT, 1);
  const notARing = new TextEncoder().encode(JSON.stringify({ v: 1, hello: "world" }));
  for (const c of bytesTreeChunks(notARing)) chunks.set(c.address, c.chunk);
  const junk = bytesTreeRoot(notARing);
  let fetches = 0;
  let missing = true;
  let named = junk;
  const setDeps = (serve: (a: string) => Uint8Array | undefined) =>
    _setCurrentRingDepsForTests({
      readAnchor: async () => `0x${named}`,
      fetchChunk: async (a) => {
        fetches++;
        const c = serve(a);
        if (!c) throw new Error("absent");
        return c;
      },
      now: () => clock,
    });
  setDeps((a) => chunks.get(a));
  for (let i = 0; i < 5; i++) assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "unavailable");
  clock += 24 * 60 * 60_000;
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "unavailable");
  assert.equal(fetches, 1, "a ref that is no ring costs one fetch, ever");

  fetches = 0;
  named = ref;
  setDeps((a) => (missing ? undefined : chunks.get(a)));
  for (let i = 0; i < 5; i++) assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "unavailable");
  assert.equal(fetches, 1, "a missing ring is not refetched on every read");
  missing = false;
  clock += 60_000;
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "ring", "and is tried again after a minute");
});

test("the highest generation seen survives a restart: a lagging read after it is not taken", async () => {
  const g1 = await ringFor(ACCOUNT, 1);
  const g2 = await ringFor(ACCOUNT, 2);
  let disk: Record<string, { gen: number; ref: string }> = {};
  const boot = (anchorRef: string) =>
    _setCurrentRingDepsForTests({
      readAnchor: async () => `0x${anchorRef}`,
      fetchChunk: async (a) => chunks.get(a) ?? Promise.reject(new Error("absent")),
      now: () => clock,
      loadHighWater: () => ({ ...disk }),
      saveHighWater: (v) => ((disk = { ...v }), true),
    });
  boot(g2.ref);
  assert.equal((await currentRing(ACCOUNT)).status, "ring");
  assert.deepEqual(disk[ACCOUNT], { gen: 2, ref: g2.ref });
  boot(g1.ref); // a restart, and a replica one generation behind
  assert.equal((await currentRing(ACCOUNT)).status, "unavailable");
});

test("one wrong chain answer is never served for good: a below-mark read pauses, and a lasting one alarms", async () => {
  const { keyRingHealth } = await import("../src/lib/keyring/current-ring.js");
  const real = await ringFor(ACCOUNT, 1);
  const bogus = await ringFor(ACCOUNT, 9); // anyone can build a ring naming any account
  anchor.set(ACCOUNT, `0x${bogus.ref}`); // one bad answer
  await currentRing(ACCOUNT);
  anchor.set(ACCOUNT, `0x${real.ref}`);
  const r = await currentRing(ACCOUNT, { fresh: true });
  assert.equal(r.status, "unavailable", "never the remembered ring");
  assert.notEqual(keyRingHealth().ok, false, "a short lag is no alarm");
  clock += 11 * 60_000;
  await currentRing(ACCOUNT, { fresh: true });
  assert.equal(keyRingHealth().ok, false);
  assert.equal(keyRingHealth().behindAccounts, 1);
});

test("a chunk a source served wrong is tried again later, not held against the ring", async () => {
  const { ref } = await ringFor(ACCOUNT, 1);
  let wrong = true;
  _setCurrentRingDepsForTests({
    readAnchor: async () => `0x${ref}`,
    fetchChunk: async (a) => {
      const c = chunks.get(a)!;
      if (!wrong || a !== ref) return c;
      const bad = c.slice();
      bad[bad.length - 1] ^= 1;
      return bad;
    },
    now: () => clock,
  });
  assert.equal((await currentRing(ACCOUNT)).status, "unavailable");
  wrong = false;
  clock += 60_000;
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "ring");
});

test("a high-water file that cannot be read is never written, and health says so", async () => {
  const { keyRingHealth } = await import("../src/lib/keyring/current-ring.js");
  const g1 = await ringFor(ACCOUNT, 1);
  let writes = 0;
  _setCurrentRingDepsForTests({
    readAnchor: async () => `0x${g1.ref}`,
    fetchChunk: async (a) => chunks.get(a) ?? Promise.reject(new Error("absent")),
    now: () => clock,
    loadHighWater: () => "unreadable",
    saveHighWater: () => (writes++, true),
  });
  assert.equal((await currentRing(ACCOUNT)).status, "ring");
  assert.equal(writes, 0);
  assert.equal(keyRingHealth().ok, false);
});

test("strict: a chain that cannot answer is unavailable, even with a ring seen before", async () => {
  const { ref } = await ringFor(ACCOUNT, 1);
  anchor.set(ACCOUNT, `0x${ref}`);
  await currentRing(ACCOUNT);
  anchorDown = true;
  assert.equal((await currentRing(ACCOUNT, { fresh: true })).status, "ring", "an event read keeps the ring seen");
  assert.equal((await currentRing(ACCOUNT, { fresh: true, strict: true })).status, "unavailable", "refresh says what the chain says NOW");
});
