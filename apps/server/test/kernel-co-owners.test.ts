/**
 * Every passkey a co-owner (#746, Fable consult 9): who may sign for an account
 * whose Kernel root is the weighted validator.
 *
 * What these pin:
 *  - a one-passkey account is decided exactly as before: the owner path, no
 *    membership read;
 *  - on a co-owned account any listed key signs, an unlisted one does not, and the
 *    FIRST passkey's counterfactual match - true forever - is never evidence: not
 *    when it is off the list, not when the chain is unreadable;
 *  - the switch is seen even from a cache filled before it, and a replica from
 *    before it is discarded;
 *  - a removal: off the list = refused once the minute-long confirmation lapses;
 *    a removed device record = refused at once (DEVICE_REMOVED); an older read
 *    showing the key still listed is discarded, never cached.
 *
 * Both chain reads are mocked at their seams, so the decision code is the real one.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Wallet, type TypedDataField } from "ethers";
import {
  DEVICE_GRANT_DOMAIN,
  DEVICE_GRANT_REVOKE_TYPES,
  DEVICE_GRANT_TYPES,
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  AuthErrorCode,
  credentialTagOf,
  type DeviceGrantMessage,
} from "@woco/shared";

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-co-owners-"));
process.chdir(dir);
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});
const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;

const owner = await import("../src/lib/auth/kernel-owner.js");
const deployed = await import("../src/lib/auth/kernel-deployed.js");
const grants = await import("../src/lib/auth/device-grants.js");
const { verifyDelegation } = await import("../src/lib/auth/verify-delegation.js");

const types = (t: object) => t as unknown as Record<string, TypedDataField[]>;
const newNonce = () => `0x${randomBytes(32).toString("hex")}`;

let A: Wallet; // the passkey the account was made with
let B: Wallet; // a passkey added later
let C: Wallet; // a key that is not on the account
let PARENT: string; // A's counterfactual Kernel, so the counterfactual is a real match for A
type Read = { owner: string | null; block: number; root?: owner.RootKind } | "error";
let ownerRead: () => Read;
let weights: Map<string, number>;
let memberRead: (eoa: string) => owner.SignerRead | "error";
let ownerReads: number;
let memberReads: number;
let realNow: () => number;

beforeEach(async () => {
  A = Wallet.createRandom();
  B = Wallet.createRandom();
  C = Wallet.createRandom();
  PARENT = (await owner.kernelAddressOfOwner(A.address))!;
  owner._resetOwnerCacheForTests();
  deployed._resetKernelDeployedForTests();
  rmSync(join(dir, ".data"), { recursive: true, force: true });
  grants.__resetDeviceGrantsForTest();
  ownerReads = 0;
  memberReads = 0;
  weights = new Map();
  ownerRead = () => ({ owner: null, root: "weighted", block: 50 });
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 50 });
  owner._setOwnerFetchForTests(async () => {
    ownerReads++;
    return ownerRead();
  });
  owner._setMemberFetchForTests(async (_k, eoa) => {
    memberReads++;
    return memberRead(eoa);
  });
  realNow = Date.now;
});

const list = (...ws: Wallet[]) => {
  weights = new Map(ws.map((w) => [w.address.toLowerCase(), 1]));
};
const kind = (w: Wallet) => owner.accountSignerKind(w.address, PARENT);
function later(ms: number) {
  const base = realNow();
  Date.now = () => base + ms;
}
function restoreClock() {
  Date.now = realNow;
}

// ── One passkey: nothing changes ────────────────────────────────────────────

test("a one-passkey account is the owner path exactly: no membership read", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner");
  assert.equal(await kind(C), null);
  assert.equal(memberReads, 0, "a single-owner account never reads the weighted list");
});

test("an undeployed account keeps the counterfactual fallback, as before", async () => {
  ownerRead = () => ({ owner: null, root: "none", block: 10 });
  assert.equal(await kind(A), "owner");
  assert.equal(await kind(C), null);
});

// ── Co-owned ────────────────────────────────────────────────────────────────

test("on a co-owned account any listed key signs and an unlisted one does not", async () => {
  list(A, B);
  assert.equal(await kind(A), "co-owner");
  assert.equal(await kind(B), "co-owner");
  assert.equal(await kind(C), null);
  assert.deepEqual(deployed.getKernelWeightedRecord(PARENT), { block: 50 }, "a confirmed key records the account");
  assert.equal(deployed.isKernelKnownDeployed(PARENT), true);
});

test("the first passkey OFF the list is refused, though its counterfactual still matches", async () => {
  list(B);
  assert.equal(await owner.kernelAddressOfOwner(A.address), PARENT);
  assert.equal(await kind(A), null);
  assert.equal(await kind(B), "co-owner");
});

test("an unreadable chain refuses every key of a known co-owned account, counterfactual or not", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner"); // records the account
  owner._resetOwnerCacheForTests();
  ownerRead = () => "error";
  memberRead = () => "error";
  assert.equal(await kind(A), null, "the counterfactual must not stand in for the list");
  assert.equal(await kind(B), null);
});

test("an exhausted read budget refuses rather than guessing", async () => {
  list(A, B);
  assert.equal(await owner.isAccountSigner(B.address, PARENT, { chainReadAllowed: () => false }), false);
});

// ── The switch ──────────────────────────────────────────────────────────────

test("a cache filled before the switch still finds the added passkey", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner"); // warms the owner cache with the ECDSA root
  list(A, B);
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  assert.equal(await kind(B), "co-owner", "the cached denial is re-read and the new root decides");
});

test("a replica from before the switch is discarded once the switch is known", async () => {
  list(A, B);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 60 });
  assert.equal(await kind(B), "co-owner"); // weighted known at block 60
  owner._resetOwnerCacheForTests();
  list(B); // A removed
  memberRead = () => ({ root: "ecdsa", weight: 0, block: 55 }); // a lagging replica: ECDSA root, owner A
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 55 });
  assert.equal(await kind(A), null, "the pre-switch owner must not come back");
});

// ── Removal ─────────────────────────────────────────────────────────────────

test("off the list: refused once the one-minute confirmation lapses", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner");
  list(A);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 70 });
  try {
    later(30_000);
    assert.equal(await kind(B), "co-owner", "a positive answer confirms for a minute");
    later(61_000);
    assert.equal(await kind(B), null);
  } finally {
    restoreClock();
  }
});

test("a read older than the removal, showing the key still listed, is discarded and never cached", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner");
  list(A);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 80 });
  try {
    later(61_000);
    assert.equal(await kind(B), null); // removal seen at block 80
    memberRead = () => ({ root: "weighted", weight: 1, block: 75 }); // lagging replica
    assert.equal(await kind(B), null, "stale membership must not readmit the key");
    memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 81 });
    assert.equal(await kind(B), null);
  } finally {
    restoreClock();
  }
});

// ── The session path ────────────────────────────────────────────────────────

async function delegation(signer: Wallet, issuedAt = new Date()) {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: PARENT,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await signer.signTypedData(SESSION_DOMAIN, types(SESSION_TYPES), message);
  return { session, delegation: { message, parentSig } };
}
const verify = async (w: Wallet) => {
  const d = await delegation(w);
  return verifyDelegation(d.delegation, d.session.address, [HOST], { lookupDeviceGrant: grants.lookupDeviceGrant });
};
const signerCheck: import("../src/lib/auth/device-grants.js").OwnerCheck = (s, p) => owner.isAccountSigner(s, p);
function grantFor(grantee: string): DeviceGrantMessage {
  return {
    parent: PARENT,
    grantee: grantee.toLowerCase(),
    credentialTag: credentialTagOf(new TextEncoder().encode(grantee)),
    issuedAt: Math.floor(Date.now() / 1000),
    nonce: newNonce(),
  };
}

test("a co-owner signs in; a key off the list does not", async () => {
  list(A, B);
  const b = await verify(B);
  assert.equal(b.valid, true, b.error);
  assert.equal(b.parentKind, "kernel");
  assert.equal(b.rank, "owner");
  assert.equal((await verify(C)).valid, false);
});

test("any co-owner signs a device record, and removing it refuses that device AT ONCE", async () => {
  list(A, B);
  const g = grantFor(B.address);
  const added = await grants.submitDeviceGrant(
    PARENT,
    { grant: g, grantSig: await A.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), g) },
    signerCheck,
  );
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal((await verify(B)).valid, true);
  // B is taken off the list onchain, but the minute-long confirmation still says listed:
  // the removed record is what refuses it now.
  list(A);
  const revoke = { parent: PARENT, grantee: B.address.toLowerCase(), nonce: newNonce() };
  const removed = await grants.submitDeviceGrantRevoke(
    PARENT,
    { revoke, revokeSig: await A.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_REVOKE_TYPES), revoke) },
    signerCheck,
  );
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const r = await verify(B);
  assert.equal(r.valid, false);
  assert.equal(r.code, AuthErrorCode.DEVICE_REMOVED);
});

test("a removed record refuses a key the chain still lists (a member re-listed without a new record)", async () => {
  list(A, B);
  const g = grantFor(B.address);
  await grants.submitDeviceGrant(PARENT, { grant: g, grantSig: await A.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), g) }, signerCheck);
  const revoke = { parent: PARENT, grantee: B.address.toLowerCase(), nonce: newNonce() };
  await grants.submitDeviceGrantRevoke(PARENT, { revoke, revokeSig: await B.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_REVOKE_TYPES), revoke) }, signerCheck);
  const r = await verify(B);
  assert.equal(r.code, AuthErrorCode.DEVICE_REMOVED);
});

test("rootValidator() answers map to a kind; only the two WoCo roots are recognised", async () => {
  const { ECDSA_ROOT_ID, WEIGHTED_ROOT_ID } = await import("@woco/shared/kernel/co-owners");
  assert.equal(owner.rootKindOf({ status: "success", result: WEIGHTED_ROOT_ID.toUpperCase().replace("0X", "0x") }), "weighted");
  assert.equal(owner.rootKindOf({ status: "success", result: ECDSA_ROOT_ID }), "ecdsa");
  assert.equal(owner.rootKindOf({ status: "failure" }), "none", "no code at the address: undeployed");
  assert.equal(owner.rootKindOf({ status: "success", result: `0x${"00".repeat(21)}` }), "none");
  assert.equal(owner.rootKindOf({ status: "success", result: `0x01${"ab".repeat(20)}` }), "other");
});

test("an account seen co-owned never falls back to the counterfactual, whatever the root read says", async () => {
  // Known co-owned from the cache only (no confirmed key yet, so no durable record).
  ownerRead = () => ({ owner: null, root: "weighted", block: 50 });
  assert.equal(await kind(C), null); // warms the cache: root weighted
  assert.equal(deployed.getKernelWeightedRecord(PARENT), undefined);
  // The member read cannot read the root; the owner read then finds no code and no owner.
  memberRead = () => ({ root: "none", weight: 0, block: 60 });
  ownerRead = () => ({ owner: null, root: "none", block: 60 });
  assert.equal(await owner.kernelAddressOfOwner(A.address), PARENT);
  assert.equal(await kind(A), null, "a removed first passkey must not come back through its counterfactual");
});

test("a root changed back to ECDSA at a later block: only the owner it names signs", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner"); // known co-owned at block 50
  owner._resetOwnerCacheForTests();
  memberRead = () => ({ root: "ecdsa", weight: 0, block: 90 });
  ownerRead = () => ({ owner: B.address.toLowerCase(), root: "ecdsa", block: 90 });
  // A first: B's confirmation below rightly rewrites the record to the ECDSA owner.
  assert.equal(await kind(A), null, "not the named owner - and never its counterfactual");
  assert.equal(await kind(B), "co-owner");
});

test("isKernelOwner on a known co-owned account discards a replica from before the switch", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner"); // weighted recorded at block 50
  owner._resetOwnerCacheForTests();
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 40 });
  assert.equal(await owner.isKernelOwner(A.address, PARENT), false);
});

test("a key written into the dropped ECDSA storage is not a signer when the root does not read", async () => {
  // After the switch an old recovery route can still rewrite ECDSA storage; onchain that opens
  // nothing (WoCo-Contracts WeightedRootKernel.t.sol F7). The server must agree.
  list(A, B);
  assert.equal(await kind(B), "co-owner");
  owner._resetOwnerCacheForTests();
  memberRead = () => ({ root: "none", weight: 0, block: 95 });
  ownerRead = () => ({ owner: C.address.toLowerCase(), root: "none", block: 95 });
  assert.equal(await kind(C), null);
});

// ── Fable sign-off fixes ────────────────────────────────────────────────────

test("MUST-1: a co-owner holding an active device record signs in as owner, cold cache or warm", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner"); // the account is now recorded co-owned
  const g = grantFor(B.address);
  await grants.submitDeviceGrant(PARENT, { grant: g, grantSig: await A.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), g) }, signerCheck);
  owner._resetOwnerCacheForTests();
  const cold = await verify(B);
  assert.equal(cold.valid, true, cold.error);
  assert.equal(cold.rank, "owner", "cold");
  const warm = await verify(B);
  assert.equal(warm.rank, "owner", "warm - the same answer whichever cache is warm");
});

test("SHOULD-2: once a co-owner's read shows the weighted root, a cached pre-switch owner stops confirming", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner"); // a cache entry from before the switch
  assert.equal(owner.cachedOwnerIs(PARENT, A.address), true);
  list(B);
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 60 });
  deployed.recordKernelWeighted(PARENT, 55); // known co-owned: B goes straight to the list
  assert.equal(await kind(B), "co-owner");
  assert.equal(owner.cachedOwnerIs(PARENT, A.address), false, "ended by B's first contact");
});

test("SHOULD-3: an account on record becomes durably co-owned from any read of the weighted root", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner"); // records the owner A
  owner._resetOwnerCacheForTests();
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  assert.equal(await kind(C), null); // an unconfirmed read - but of an account already on record
  assert.deepEqual(deployed.getKernelWeightedRecord(PARENT), { block: 60 });
  // Restart, then two lagging replicas from before the switch: A must not be the owner again.
  owner._resetOwnerCacheForTests();
  memberRead = () => ({ root: "ecdsa", weight: 0, block: 55 });
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 55 });
  assert.equal(await kind(A), null);
});

test("SHOULD-4: the first passkey's removal is a durable floor - a restart and an older read do not bring it back", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner"); // owner A on record
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  list(A, B);
  owner._resetOwnerCacheForTests();
  assert.equal(await kind(B), "co-owner");
  list(B);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 70 });
  assert.equal(await kind(A), null); // seen off the list at 70: floored (the recorded owner)
  assert.equal(deployed.coOwnerRemovedBlock(PARENT, A.address), 70);
  owner._resetOwnerCacheForTests(); // restart: the in-memory change-point is gone
  memberRead = () => ({ root: "weighted", weight: 1, block: 65 }); // a lagging replica: still listed
  assert.equal(await kind(A), null, "an older read must not readmit the removed key");
  memberRead = () => ({ root: "weighted", weight: 1, block: 75 }); // genuinely re-added later
  assert.equal(await kind(A), "co-owner");
});

test("SHOULD-4: noteCoOwnerRemoved floors only a key known to have been on the list", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner");
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  list(A, B);
  owner._resetOwnerCacheForTests();
  assert.equal(await kind(B), "co-owner");
  list(B);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 80 });
  assert.equal(await owner.noteCoOwnerRemoved(B.address, PARENT), false, "still listed");
  assert.equal(await owner.noteCoOwnerRemoved(C.address, PARENT), false, "never known: no entry");
  assert.equal(deployed.coOwnerRemovedBlock(PARENT, C.address), undefined);
  assert.equal(await owner.noteCoOwnerRemoved(A.address, PARENT), true, "the first passkey, off the list");
  assert.equal(deployed.coOwnerRemovedBlock(PARENT, A.address), 80);
});

test("NIT-8: the list's threshold is read - one key under a higher threshold is not a signer", async () => {
  memberRead = () => ({ root: "weighted", weight: 1, threshold: 2, block: 50 });
  assert.equal(await kind(B), null);
});

test("route: removing the first passkey (no device record) on a co-owned account is accepted and floored", async () => {
  const { Hono } = await import("hono");
  const { requireAuth } = await import("../src/middleware/auth.js");
  const { deviceGrants } = await import("../src/routes/device-grants.js");
  const { createHash } = await import("node:crypto");
  const app = new Hono();
  app.route("/api/auth/device-grants", deviceGrants);
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner");
  ownerRead = () => ({ owner: null, root: "weighted", block: 60 });
  list(A, B);
  owner._resetOwnerCacheForTests();
  assert.equal(await kind(B), "co-owner");
  list(B); // A taken off the list onchain
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 90 });
  const revoke = { parent: PARENT, grantee: A.address.toLowerCase(), nonce: newNonce() };
  const body = JSON.stringify({ revoke, revokeSig: await B.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_REVOKE_TYPES), revoke) });
  const d = await delegation(B);
  const path = "/api/auth/device-grants/revoke";
  const ts = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, ts, nonce, createHash("sha256").update(body, "utf-8").digest("hex")].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": d.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation)).toString("base64"),
      "X-Session-Sig": await d.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": ts,
    },
    body,
  });
  const json = (await resp.json()) as Record<string, unknown>;
  assert.equal(resp.status, 200, JSON.stringify(json));
  assert.equal(json.ok, true);
  assert.equal(deployed.coOwnerRemovedBlock(PARENT, A.address), 90);
});

test("a lagging read that shows a listed key OFF the list writes no removal floor", async () => {
  list(A, B);
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 60 });
  assert.equal(await kind(B), "co-owner"); // B seen on the list at 60
  try {
    later(61_000);
    memberRead = () => ({ root: "weighted", weight: 0, block: 55 }); // older than what we know
    assert.equal(await kind(B), null);
    assert.equal(deployed.coOwnerRemovedBlock(PARENT, B.address), undefined, "no false removal on record");
  } finally {
    restoreClock();
  }
});

test("SHOULD-5: the first passkey removing itself right after the switch is floored with no co-owner seen yet", async () => {
  ownerRead = () => ({ owner: A.address.toLowerCase(), root: "ecdsa", block: 10 });
  assert.equal(await kind(A), "owner"); // owner A on record; no weighted record yet
  assert.equal(deployed.getKernelWeightedRecord(PARENT), undefined);
  list(B); // switched and A already taken off, all before any co-owner session
  memberRead = (eoa) => ({ root: "weighted", weight: weights.get(eoa) ?? 0, block: 70 });
  assert.equal(await owner.noteCoOwnerRemoved(A.address, PARENT), true);
  assert.deepEqual(deployed.getKernelWeightedRecord(PARENT), { block: 70 });
  assert.equal(deployed.coOwnerRemovedBlock(PARENT, A.address), 70);
});

test("on a co-owned account only the list admits; 'removed' only on evidence, never on a read it could not make", async () => {
  list(A, B);
  assert.equal(await kind(B), "co-owner"); // recorded co-owned
  const g = grantFor(C.address);
  await grants.submitDeviceGrant(PARENT, { grant: g, grantSig: await A.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), g) }, signerCheck);
  // C has a live record signed by a listed key, but C is not on the list: refused - without the
  // code that makes a device forget itself, since nothing says it was REMOVED.
  const plain = await verify(C);
  assert.equal(plain.valid, false, "the record's signer being listed admits nothing");
  assert.notEqual(plain.code, AuthErrorCode.DEVICE_REMOVED);
  // The list cannot be read (outage, spent budget): still refused, still no "removed".
  memberRead = () => "error";
  owner._resetOwnerCacheForTests();
  const outage = await verify(C);
  assert.equal(outage.valid, false);
  assert.notEqual(outage.code, AuthErrorCode.DEVICE_REMOVED, "an unreadable list is not evidence of removal");
  // A removal on record IS evidence.
  deployed.recordCoOwnerRemoved(PARENT, C.address, 90);
  const floored = await verify(C);
  assert.equal(floored.code, AuthErrorCode.DEVICE_REMOVED);
});
