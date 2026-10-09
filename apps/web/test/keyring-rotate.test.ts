/**
 * Removing a passkey moves the account to new keys (#186): the orchestrator's order,
 * its refusals (account unchanged), and its resume.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256 } from "ethers";
import { bytesToHex } from "@noble/hashes/utils.js";
import { newAccountSecret } from "@woco/shared/keyring/account-secret";
import { buildKeyRing, NO_RING, type KeyRing } from "@woco/shared/keyring/ring";
import { memberOf } from "../src/lib/keyring/members.ts";
import { rotateOnRemoval, AFTER_STEPS, RotationRefusedError, type PendingRotation, type RotationSteps } from "../src/lib/keyring/rotate.ts";

const PARENT = "0x" + "ab".repeat(20);
function passkey(n: number) {
  const prfSecret = "0x" + n.toString(16).padStart(2, "0").repeat(32);
  const privateKey = keccak256(prfSecret);
  return { prfSecret, privateKey, address: new Wallet(privateKey).address.toLowerCase() };
}
const A = passkey(1); // this device
const B = passkey(2); // stays
const R = passkey(3); // removed
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const SEED = hex(newAccountSecret());
const RING0 = "a0".repeat(32);

async function ring0(): Promise<KeyRing> {
  return buildKeyRing({
    parent: PARENT,
    gen: 0,
    prev: NO_RING,
    secret: Uint8Array.from(Buffer.from(SEED.slice(2), "hex")),
    prior: [],
    members: [await memberOf(PARENT, A), await memberOf(PARENT, B), await memberOf(PARENT, R)],
  });
}

function harness(over: Partial<RotationSteps> = {}) {
  const calls: string[] = [];
  let pending: PendingRotation | null = null;
  let anchor: string | null = RING0;
  const steps: RotationSteps = {
    parent: PARENT,
    self: A.address,
    seed: SEED,
    chain: { ringRef: RING0, gen: 0, secrets: [] },
    readAnchor: async () => anchor,
    readCoOwners: async () => [A.address, B.address, R.address],
    fetchRing: async () => ring0(),
    selfMember: () => memberOf(PARENT, A),
    newSecret: () => "0x" + "5e".repeat(32),
    keysOf: async (secret) => ({ secret, feedSigner: { privKey: "0x01", address: "0x" + "f1".repeat(20) }, orderKeyRef: "0b".repeat(32), orderPublicKey: new Uint8Array() }),
    loadPending: async () => pending,
    savePending: async (p) => {
      pending = p;
      calls.push(`save:${p.phase}${p.nextRing ? "+ring" : ""}`);
    },
    clearPending: async () => {
      pending = null;
      calls.push("clear");
    },
    copyEvents: async (_k, progress) => {
      progress(1, 1);
      calls.push("events");
    },
    copySiteConfigs: async () => void calls.push("sites"),
    copyProfile: async () => void calls.push("profile"),
    storeRing: async (args) => {
      calls.push(`store:gen${args.gen}:${args.members.map((m) => m.statement.coOwner).sort().join(",")}`);
      return "b1".repeat(32);
    },
    flip: async (going, ring) => {
      calls.push(`flip:${going.join(",")}:${ring.prev}->${ring.next}`);
      anchor = ring.next;
      return { confirmed: true };
    },
    adopt: async (chain) => void calls.push(`adopt:gen${chain.gen}:${chain.secrets.at(-1)}`),
    after: Object.fromEntries(AFTER_STEPS.map((st) => [st, async (_k: unknown, ctx: { going: string[] }) => void calls.push(st === "records" ? `after:records:${ctx.going.join(",")}` : `after:${st}`)])) as RotationSteps["after"],
    progress: () => {},
    ...over,
  };
  return { steps, calls, get pending() { return pending; }, setAnchor: (a: string | null) => { anchor = a; }, setPending: (p: PendingRotation | null) => { pending = p; } };
}

test("removal: copy under the new signer, store the ring for the rest, ONE flip, adopt, then the after steps", async () => {
  const h = harness();
  const res = await rotateOnRemoval(h.steps, [R.address]);
  const sorted = [A.address, B.address].sort().join(",");
  assert.deepEqual(h.calls, [
    "save:copying",
    "events",
    "sites",
    "profile",
    `store:gen1:${sorted}`,
    "save:copying+ring",
    `flip:${R.address}:${RING0}->${"b1".repeat(32)}`,
    "save:flipped+ring",
    `adopt:gen1:0x${"5e".repeat(32)}`,
    ...AFTER_STEPS.map((st) => (st === "records" ? `after:records:${R.address}` : `after:${st}`)),
    "clear",
  ]);
  assert.deepEqual(res, { unfinished: [], keyless: [] });
});

test("refusals leave the account unchanged: nothing copied, stored or flipped", async () => {
  const cases: [Partial<RotationSteps>, string[], RegExp][] = [
    [{}, [A.address], /another of your passkeys/],
    [{ readCoOwners: async () => "error" }, [R.address], /Couldn't read your passkeys/],
    [{ readCoOwners: async () => [A.address, R.address].slice(0, 1) }, [A.address], /another of your passkeys/],
    [{ chain: { ringRef: "cc".repeat(32), gen: 0, secrets: [] } }, [R.address], /changed on another device/],
    [{ readAnchor: async () => "error" }, [R.address], /Couldn't read your account's keys/],
  ];
  for (const [over, going, msg] of cases) {
    const h = harness(over);
    await assert.rejects(rotateOnRemoval(h.steps, going), (e: unknown) => e instanceof RotationRefusedError && msg.test(e.message));
    assert.ok(!h.calls.some((c) => c.startsWith("flip") || c.startsWith("store") || c === "events"), JSON.stringify(h.calls));
  }
  const only = harness({ readCoOwners: async () => [A.address, R.address] });
  await rotateOnRemoval(only.steps, [R.address]); // fine: A remains
  const lone = harness({ readCoOwners: async () => [R.address, A.address].filter((a) => a === R.address) });
  await assert.rejects(rotateOnRemoval(lone.steps, [R.address]), /only passkey/);
});

test("a removal interrupted after the flip resumes with only what comes after - same secret, no new copies", async () => {
  const h = harness();
  h.setPending({ v: 1, parent: PARENT, going: [R.address], gen: 1, secret: "0x" + "77".repeat(32), prevRing: RING0, nextRing: "b2".repeat(32), phase: "copying" });
  h.setAnchor("b2".repeat(32));
  await rotateOnRemoval(h.steps, [], { resume: true });
  assert.ok(!h.calls.includes("events") && !h.calls.some((c) => c.startsWith("flip")));
  assert.ok(h.calls.includes(`adopt:gen1:0x${"77".repeat(32)}`));
});

test("a removal interrupted before the flip reuses its secret", async () => {
  const h = harness({ newSecret: () => { throw new Error("must reuse the pending secret"); } });
  h.setPending({ v: 1, parent: PARENT, going: [R.address], gen: 1, secret: "0x" + "88".repeat(32), prevRing: RING0, phase: "copying" });
  await rotateOnRemoval(h.steps, [R.address]);
  assert.ok(h.calls.includes(`adopt:gen1:0x${"88".repeat(32)}`));
});

test("an after step that fails is kept for the next open; the removal itself is done", async () => {
  const h = harness({
    after: Object.fromEntries(AFTER_STEPS.map((st) => [st, async () => { if (st === "pages") throw new Error("down"); }])) as RotationSteps["after"],
  });
  const res = await rotateOnRemoval(h.steps, [R.address]);
  assert.deepEqual(res.unfinished, ["pages"]);
  assert.deepEqual(h.pending?.after, ["pages"]);
  assert.equal(h.pending?.phase, "flipped");
});

test("a remaining passkey with no ring entry is reported keyless, never sealed to blindly", async () => {
  const C = passkey(4);
  const h = harness({ readCoOwners: async () => [A.address, B.address, R.address, C.address] });
  const res = await rotateOnRemoval(h.steps, [R.address]);
  assert.deepEqual(res.keyless, [C.address]);
});

test("a request to remove someone else never inherits an old pending list", async () => {
  const h = harness();
  // An earlier attempt to remove B stopped before its flip.
  h.setPending({ v: 1, parent: PARENT, going: [B.address], gen: 1, secret: "0x" + "99".repeat(32), prevRing: RING0, phase: "copying" });
  await rotateOnRemoval(h.steps, [R.address]);
  const flip = h.calls.find((c) => c.startsWith("flip:"))!;
  assert.match(flip, new RegExp(`^flip:${R.address}:`), "the passkey asked about goes, not the pending one");
  assert.ok(!h.calls.includes(`adopt:gen1:0x${"99".repeat(32)}`), "and with a fresh secret");
});

test("a flipped removal the account has moved past is dropped, never adopted - no rollback", async () => {
  const h = harness();
  h.setPending({ v: 1, parent: PARENT, going: [R.address], gen: 1, secret: "0x" + "66".repeat(32), prevRing: RING0, nextRing: "b3".repeat(32), phase: "flipped", after: ["sites"] });
  // Another device rotated again: the anchor names a generation-2 ring.
  const g2 = { ...(await ring0()), gen: 2 } as KeyRing;
  const h2 = harness({ fetchRing: async () => g2, chain: { ringRef: "c2".repeat(32), gen: 2, secrets: ["0x" + "01".repeat(32), "0x" + "02".repeat(32)] } });
  h2.setPending(h.pending);
  h2.setAnchor("c2".repeat(32));
  const res = await rotateOnRemoval(h2.steps, [], { resume: true });
  assert.deepEqual(res, { unfinished: [], keyless: [] });
  assert.ok(!h2.calls.some((c) => c.startsWith("adopt") || c.startsWith("after")), JSON.stringify(h2.calls));
  assert.equal(h2.pending, null);
});

test("while a flipped removal is finishing, a different removal waits", async () => {
  const h = harness({ chain: { ringRef: "b4".repeat(32), gen: 1, secrets: ["0x" + "44".repeat(32)] } });
  h.setPending({ v: 1, parent: PARENT, going: [R.address], gen: 1, secret: "0x" + "44".repeat(32), prevRing: RING0, nextRing: "b4".repeat(32), phase: "flipped", after: ["pages"] });
  h.setAnchor("b4".repeat(32));
  await assert.rejects(rotateOnRemoval(h.steps, [B.address]), /still finishing/);
  const res = await rotateOnRemoval(h.steps, [], { resume: true });
  assert.deepEqual(res.unfinished, []);
  assert.ok(!h.calls.some((c) => c.startsWith("adopt")), "already held: not adopted again");
  assert.ok(h.calls.includes("after:pages"));
});
