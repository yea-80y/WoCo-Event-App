/**
 * Device grants (#746 step 2): a passkey the account's owner added.
 *
 * What these pin:
 *  - the statement bytes (a change silently invalidates every registered grant);
 *  - the registry's rules, which are the ones a contract would apply: owner-signed
 *    grants, owner- or self-signed removals, one-use nonces, the cap;
 *  - the session path: a granted key signs in as "device" only while its grant is
 *    live AND its signer is still the owner; a removal answers DEVICE_REMOVED, an
 *    owner rotation does not;
 *  - the whole loop through the real middleware and routes.
 *
 * The Kernel owner is mocked at the chain read (`_setOwnerFetchForTests`), so the
 * owner check itself is the real `isKernelOwner`.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { Wallet, TypedDataEncoder, type TypedDataField } from "ethers";
import {
  DEVICE_GRANT_DOMAIN,
  DEVICE_GRANT_TYPES,
  DEVICE_GRANT_REVOKE_TYPES,
  MAX_DEVICE_GRANTS,
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  AuthErrorCode,
  credentialTagOf,
  eip712DigestHex,
  parseDeviceGrant,
  type DeviceGrantMessage,
} from "@woco/shared";

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-device-grants-"));
// Stores fix their `.data` path at module load: chdir before the first import.
process.chdir(dir);
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;

const grants = await import("../src/lib/auth/device-grants.js");
const ownerMod = await import("../src/lib/auth/kernel-owner.js");
const deployed = await import("../src/lib/auth/kernel-deployed.js");
const { verifyDelegation } = await import("../src/lib/auth/verify-delegation.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { deviceGrants } = await import("../src/routes/device-grants.js");
const { setStripeAccount } = await import("../src/lib/stripe/accounts.js");

const FILE = join(dir, ".data", "device-grants.json");
const newNonce = () => `0x${randomBytes(32).toString("hex")}`;
const types = (t: object) => t as unknown as Record<string, TypedDataField[]>;

/** The account: a Kernel address with `owner` as its onchain owner. */
let PARENT: string;
let owner: Wallet;
let chainOwner: string;
let ownerReads: number;

beforeEach(() => {
  PARENT = Wallet.createRandom().address.toLowerCase();
  owner = Wallet.createRandom();
  chainOwner = owner.address.toLowerCase();
  ownerReads = 0;
  rmSync(FILE, { force: true });
  grants.__resetDeviceGrantsForTest();
  ownerMod._resetOwnerCacheForTests();
  deployed._resetKernelDeployedForTests();
  ownerMod._setOwnerFetchForTests(async () => {
    ownerReads++;
    return { owner: chainOwner, block: 100 + ownerReads };
  });
});

const isOwner: import("../src/lib/auth/device-grants.js").OwnerCheck = (s, p) => ownerMod.isKernelOwner(s, p);

function grantFor(grantee: string, over: Partial<DeviceGrantMessage> = {}): DeviceGrantMessage {
  return {
    parent: PARENT,
    grantee: grantee.toLowerCase(),
    credentialTag: credentialTagOf(new TextEncoder().encode(grantee)),
    issuedAt: Math.floor(Date.now() / 1000),
    nonce: newNonce(),
    ...over,
  };
}

async function signGrant(signer: Wallet, grant: DeviceGrantMessage) {
  return { grant, grantSig: await signer.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), grant) };
}

async function signRevoke(signer: Wallet, grantee: string, nonce: string = newNonce(), parent = PARENT) {
  const revoke = { parent, grantee: grantee.toLowerCase(), nonce };
  return {
    revoke,
    revokeSig: await signer.signTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_REVOKE_TYPES), revoke),
  };
}

async function addDevice(device: Wallet = Wallet.createRandom()) {
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(device.address)), isOwner);
  assert.equal(r.ok, true, JSON.stringify(r));
  return device;
}

/** A session delegation for PARENT signed by `signer` (owner or device). */
async function delegation(signer: Wallet, issuedAt = new Date(), parent = PARENT) {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent,
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

// ── The statement bytes ─────────────────────────────────────────────────────

test("the grant and removal digests are pinned, and the browser's digest matches ethers'", () => {
  const grant: DeviceGrantMessage = {
    parent: "0x1111111111111111111111111111111111111111",
    grantee: "0x2222222222222222222222222222222222222222",
    credentialTag: credentialTagOf(new Uint8Array([1, 2, 3, 4])),
    issuedAt: 1790812800, // 2026-10-01T00:00:00Z
    nonce: `0x${"01".repeat(32)}`,
  };
  const revoke = { parent: grant.parent, grantee: grant.grantee, nonce: `0x${"02".repeat(32)}` };
  const g = TypedDataEncoder.hash(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), grant);
  const r = TypedDataEncoder.hash(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_REVOKE_TYPES), revoke);
  // A changed constant here invalidates every grant already registered.
  assert.equal(grant.credentialTag, "0xa6885b3731702da62e8e4a8f584ac46a7f6822f4e2ba50fba902f67b1588d23b");
  assert.equal(g, "0x27e7262dbd67650d8965f3c555a6c489f374c83bbcd56d735618bc1a8b3dbfc2");
  assert.equal(r, "0x430bb2b5dbde73846b411d85bcfaa5c4ecb41b35ad6a8ebdbbec3efa53d6680f");
  assert.equal(eip712DigestHex(DEVICE_GRANT_DOMAIN, "DeviceGrant", DEVICE_GRANT_TYPES.DeviceGrant, grant), g);
  assert.equal(
    eip712DigestHex(DEVICE_GRANT_DOMAIN, "RevokeDeviceGrant", DEVICE_GRANT_REVOKE_TYPES.RevokeDeviceGrant, revoke),
    r,
  );
});

test("parse refuses a grant to the account itself, to nobody, or with fields a contract would not store", () => {
  const base = { parent: PARENT, grantee: Wallet.createRandom().address, credentialTag: "0x" + "ab".repeat(32), issuedAt: 1790812800, nonce: "0x" + "cd".repeat(32) };
  assert.ok(parseDeviceGrant(base));
  assert.equal(parseDeviceGrant({ ...base, grantee: PARENT }), null);
  assert.equal(parseDeviceGrant({ ...base, grantee: "0x" + "00".repeat(20) }), null);
  assert.equal(parseDeviceGrant({ ...base, nonce: "0x" + "cd".repeat(31) }), null);
  assert.equal(parseDeviceGrant({ ...base, issuedAt: "2026-10-01T00:00:00Z" }), null);
  assert.equal(parseDeviceGrant({ ...base, issuedAt: 1.5 }), null);
});

// ── The registry ────────────────────────────────────────────────────────────

test("an owner-signed grant registers, lands 0600 and survives a restart", async () => {
  const device = await addDevice();
  assert.equal(statSync(FILE).mode & 0o777, 0o600);
  grants.__resetDeviceGrantsForTest();
  assert.deepEqual(grants.lookupDeviceGrant(PARENT, device.address), { signer: chainOwner, active: true, notBefore: undefined });
});

test("a grant signed by anyone but the current owner is refused", async () => {
  const stranger = Wallet.createRandom();
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(stranger, grantFor(Wallet.createRandom().address)), isOwner);
  assert.deepEqual(r, { ok: false, refusal: "not-owner" });
});

test("a grant for another account is refused", async () => {
  const body = await signGrant(owner, grantFor(Wallet.createRandom().address));
  const r = await grants.submitDeviceGrant(Wallet.createRandom().address, body, isOwner);
  assert.deepEqual(r, { ok: false, refusal: "wrong-account" });
});

test("the owner cannot grant itself", async () => {
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(owner.address)), isOwner);
  assert.deepEqual(r, { ok: false, refusal: "malformed" });
});

test("a removed device cannot be re-added by replaying the grant that added it", async () => {
  const device = Wallet.createRandom();
  const body = await signGrant(owner, grantFor(device.address));
  assert.equal((await grants.submitDeviceGrant(PARENT, body, isOwner)).ok, true);
  assert.equal((await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner)).ok, true);
  assert.deepEqual(await grants.submitDeviceGrant(PARENT, body, isOwner), { ok: false, refusal: "nonce-used" });
  assert.equal(grants.lookupDeviceGrant(PARENT, device.address)?.active, false);
});

test("at most MAX_DEVICE_GRANTS live under the current owner; re-granting one does not count twice", async () => {
  const devices: Wallet[] = [];
  for (let i = 0; i < MAX_DEVICE_GRANTS; i++) devices.push(await addDevice());
  const over = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(Wallet.createRandom().address)), isOwner);
  assert.deepEqual(over, { ok: false, refusal: "cap-reached" });
  const again = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(devices[0]!.address)), isOwner);
  assert.equal(again.ok, true);
});

test("after an owner rotation the old owner's grants hold no slots, and the new owner can re-grant", async () => {
  const devices: Wallet[] = [];
  for (let i = 0; i < MAX_DEVICE_GRANTS; i++) devices.push(await addDevice());
  owner = Wallet.createRandom();
  chainOwner = owner.address.toLowerCase();
  ownerMod._resetOwnerCacheForTests();
  const fresh = Wallet.createRandom();
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(fresh.address)), isOwner);
  assert.equal(r.ok, true, "the previous owner's grants held the new owner's slots");
  assert.equal(grants.lookupDeviceGrant(PARENT, fresh.address)?.signer, chainOwner);
});

test("two concurrent submissions of one grant: exactly one lands", async () => {
  const body = await signGrant(owner, grantFor(Wallet.createRandom().address));
  const results = await Promise.all([1, 2, 3].map(() => grants.submitDeviceGrant(PARENT, body, isOwner)));
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("a device can be removed by the owner or by itself, by nobody else", async () => {
  const a = await addDevice();
  const b = await addDevice();
  const stranger = Wallet.createRandom();
  assert.deepEqual(
    await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(stranger, a.address), isOwner),
    { ok: false, refusal: "not-allowed" },
  );
  // A device cannot remove another device.
  assert.deepEqual(
    await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(b, a.address), isOwner),
    { ok: false, refusal: "not-allowed" },
  );
  assert.equal((await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(a, a.address), isOwner)).ok, true);
  assert.equal((await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, b.address), isOwner)).ok, true);
  assert.equal(grants.lookupDeviceGrant(PARENT, a.address)?.active, false);
  assert.equal(grants.lookupDeviceGrant(PARENT, b.address)?.active, false);
});

test("removing twice is answered, consumes nothing; a removal cannot be replayed", async () => {
  const device = await addDevice();
  const first = await signRevoke(owner, device.address);
  assert.equal((await grants.submitDeviceGrantRevoke(PARENT, first, isOwner)).ok, true);
  const second = await signRevoke(owner, device.address);
  assert.equal((await grants.submitDeviceGrantRevoke(PARENT, second, isOwner)).ok, true);
  // Re-add, then replay the first removal: its nonce is spent.
  await addDevice(device);
  assert.deepEqual(await grants.submitDeviceGrantRevoke(PARENT, first, isOwner), { ok: false, refusal: "nonce-used" });
  assert.equal(grants.lookupDeviceGrant(PARENT, device.address)?.active, true);
});

test("re-adding a removed device carries its removal forward as notBefore", async () => {
  const device = await addDevice();
  await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner, 5_000);
  await addDevice(device);
  assert.equal(grants.lookupDeviceGrant(PARENT, device.address)?.notBefore, 5_000);
});

test("an unreadable file serves nothing, refuses every write, alarms, and is never overwritten", async () => {
  // One good grant beside one bad one: the good one must not be served either.
  const device = await addDevice();
  const onDisk = JSON.parse(readFileSync(FILE, "utf-8"));
  onDisk.accounts[PARENT].grants["0xbad"] = { grant: { parent: "nope" } };
  writeFileSync(FILE, JSON.stringify(onDisk));
  grants.__resetDeviceGrantsForTest();
  assert.equal(grants.lookupDeviceGrant(PARENT, device.address), undefined);
  assert.equal(grants.listDeviceGrants(PARENT), null);
  const before = readFileSync(FILE, "utf-8");
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(Wallet.createRandom().address)), isOwner);
  assert.deepEqual(r, { ok: false, refusal: "store-unavailable" });
  assert.equal(grants.deviceGrantHealth().ok, false);
  assert.equal(readFileSync(FILE, "utf-8"), before);
});

// ── The session path ────────────────────────────────────────────────────────

const lookup = { lookupDeviceGrant: grants.lookupDeviceGrant };

test("a granted device signs in as rank device; the owner as rank owner", async () => {
  const device = await addDevice();
  const d = await delegation(device);
  const asDevice = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(asDevice.valid, true, asDevice.error);
  assert.equal(asDevice.rank, "device");
  assert.equal(asDevice.parentAddress?.toLowerCase(), PARENT);
  const o = await delegation(owner);
  const asOwner = await verifyDelegation(o.delegation, o.session.address, [HOST], lookup);
  assert.equal(asOwner.valid, true, asOwner.error);
  assert.equal(asOwner.rank, "owner");
});

test("a device request costs no chain read once the owner is cached", async () => {
  const device = await addDevice(); // the registration read the owner once
  const before = ownerReads;
  const d = await delegation(device);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, true, r.error);
  assert.equal(ownerReads, before, "device sessions must not re-read the chain on every request");
});

test("a device's first session records the account with the OWNER as presenter (#200/#210)", async () => {
  const device = await addDevice();
  deployed._resetKernelDeployedForTests();
  ownerMod._resetOwnerCacheForTests();
  rmSync(join(dir, ".data", "kernel-deployed.json"), { force: true });
  const d = await delegation(device);
  assert.equal((await verifyDelegation(d.delegation, d.session.address, [HOST], lookup)).valid, true);
  assert.equal(deployed.getKernelOwnerRecord(PARENT)?.owner, chainOwner);
});

test("a removed device is told DEVICE_REMOVED", async () => {
  const device = await addDevice();
  const d = await delegation(device);
  await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, false);
  assert.equal(r.code, AuthErrorCode.DEVICE_REMOVED);
});

test("after an owner rotation the old grants stop working - but are NOT reported as removed", async () => {
  const device = await addDevice();
  chainOwner = Wallet.createRandom().address.toLowerCase();
  ownerMod._resetOwnerCacheForTests();
  const d = await delegation(device);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, false);
  assert.notEqual(r.code, AuthErrorCode.DEVICE_REMOVED, "an unreadable or rotated owner must not read as a removal");
});

test("a device made the main one signs in as owner despite its old grant", async () => {
  const device = await addDevice();
  chainOwner = device.address.toLowerCase();
  ownerMod._resetOwnerCacheForTests();
  const d = await delegation(device);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, true, r.error);
  assert.equal(r.rank, "owner");
});

test("a re-added device's sessions from before its removal stay dead; new ones work", async () => {
  const device = await addDevice();
  const old = await delegation(device, new Date(Date.now() - 60_000));
  await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner, Date.now() - 30_000);
  await addDevice(device);
  const stale = await verifyDelegation(old.delegation, old.session.address, [HOST], lookup);
  assert.equal(stale.valid, false);
  const fresh = await delegation(device);
  assert.equal((await verifyDelegation(fresh.delegation, fresh.session.address, [HOST], lookup)).valid, true);
});

test("a key with no grant is still refused", async () => {
  const d = await delegation(Wallet.createRandom());
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, false);
  assert.notEqual(r.code, AuthErrorCode.DEVICE_REMOVED);
});

test("a device made the main one, after it was removed, signs in as owner - not DEVICE_REMOVED", async () => {
  const device = await addDevice();
  await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner);
  chainOwner = device.address.toLowerCase();
  ownerMod._resetOwnerCacheForTests();
  const d = await delegation(device);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, true, r.error);
  assert.equal(r.rank, "owner");
});

test("a device made the main one with its old grant still live costs no chain read once cached", async () => {
  const device = await addDevice();
  chainOwner = device.address.toLowerCase();
  ownerMod._resetOwnerCacheForTests();
  const first = await delegation(device);
  assert.equal((await verifyDelegation(first.delegation, first.session.address, [HOST], lookup)).rank, "owner");
  const reads = ownerReads;
  const again = await delegation(device);
  assert.equal((await verifyDelegation(again.delegation, again.session.address, [HOST], lookup)).rank, "owner");
  assert.equal(ownerReads, reads, "a stale grant must not cost a re-read on every request");
});

test("an unreadable chain after the cache expires refuses a device on a known-deployed account", async () => {
  const device = await addDevice(); // the owner read recorded the account as deployed
  assert.ok(deployed.getKernelOwnerRecord(PARENT), "precondition: account recorded");
  ownerMod._resetOwnerCacheForTests();
  ownerMod._setOwnerFetchForTests(async () => "error");
  const d = await delegation(device);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, false);
  assert.notEqual(r.code, AuthErrorCode.DEVICE_REMOVED);
});

test("an async grant source (an onchain registry) is awaited on every branch", async () => {
  const asyncLookup = {
    lookupDeviceGrant: async (p: string, g: string) => grants.lookupDeviceGrant(p, g),
  };
  const device = await addDevice();
  const d = await delegation(device);
  assert.equal((await verifyDelegation(d.delegation, d.session.address, [HOST], asyncLookup)).rank, "device");
  const stranger = await delegation(Wallet.createRandom());
  const s = await verifyDelegation(stranger.delegation, stranger.session.address, [HOST], asyncLookup);
  assert.equal(s.valid, false);
  assert.notEqual(s.code, AuthErrorCode.DEVICE_REMOVED);
  await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, device.address), isOwner);
  const removed = await verifyDelegation(d.delegation, d.session.address, [HOST], asyncLookup);
  assert.equal(removed.code, AuthErrorCode.DEVICE_REMOVED);
});

test("a grant on one account does not let the same key act for another", async () => {
  const device = await addDevice();
  const other = Wallet.createRandom().address.toLowerCase();
  const d = await delegation(device, new Date(), other);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST], lookup);
  assert.equal(r.valid, false);
});

test("nonces are per account: the same nonce lands on two accounts", async () => {
  const nonce = newNonce();
  const first = PARENT;
  const a = await signGrant(owner, grantFor(Wallet.createRandom().address, { nonce }));
  assert.equal((await grants.submitDeviceGrant(first, a, isOwner)).ok, true);
  PARENT = Wallet.createRandom().address.toLowerCase();
  const b = await signGrant(owner, grantFor(Wallet.createRandom().address, { nonce }));
  assert.equal((await grants.submitDeviceGrant(PARENT, b, isOwner)).ok, true);
});

test("removing a key that was never granted consumes no nonce", async () => {
  const nonce = newNonce();
  const ghost = Wallet.createRandom();
  assert.deepEqual(
    await grants.submitDeviceGrantRevoke(PARENT, await signRevoke(owner, ghost.address, nonce), isOwner),
    { ok: false, refusal: "not-found" },
  );
  const r = await grants.submitDeviceGrant(PARENT, await signGrant(owner, grantFor(ghost.address, { nonce })), isOwner);
  assert.equal(r.ok, true);
});

// ── Through the middleware and routes ───────────────────────────────────────

const app = new Hono();
app.route("/api/auth/device-grants", deviceGrants);
app.post("/api/test", requireAuth, (c) => c.json({ ok: true, data: { rank: c.get("sessionRank") } }));

const sha256Hex = (t: string) => createHash("sha256").update(t, "utf-8").digest("hex");

/** PARENT as a Stripe-verified organiser. No Stripe key in tests, so the live check
 *  falls back to this record, as it does in a Stripe outage. */
function organiser(verified = true): void {
  setStripeAccount(PARENT, `acct_${PARENT.slice(2, 10)}`, verified);
}

async function call(
  d: Awaited<ReturnType<typeof delegation>>,
  method: "GET" | "POST",
  path: string,
  bodyObj?: unknown,
  ip?: string,
) {
  const body = method === "POST" ? JSON.stringify(bodyObj ?? {}) : "";
  const ts = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", method, path, ts, nonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": d.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation)).toString("base64"),
      "X-Session-Sig": await d.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": ts,
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
    ...(method === "POST" ? { body } : {}),
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, any> };
}

test("routes: owner adds a device, the device signs in as device, removes itself, and is told so", async () => {
  organiser();
  const ownerSession = await delegation(owner);
  const device = Wallet.createRandom();

  const added = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(device.address)));
  assert.equal(added.status, 200, JSON.stringify(added.json));

  const deviceSession = await delegation(device);
  const who = await call(deviceSession, "POST", "/api/test", {});
  assert.equal(who.status, 200, JSON.stringify(who.json));
  assert.equal(who.json.data.rank, "device");

  const listed = await call(deviceSession, "GET", "/api/auth/device-grants");
  assert.equal(listed.json.data.grants.length, 1);
  assert.equal(listed.json.data.sessionRank, "device");

  const removed = await call(deviceSession, "POST", "/api/auth/device-grants/revoke", await signRevoke(device, device.address));
  assert.equal(removed.status, 200, JSON.stringify(removed.json));

  const after = await call(deviceSession, "POST", "/api/test", {});
  assert.equal(after.status, 403);
  assert.equal(after.json.code, AuthErrorCode.DEVICE_REMOVED);
});

test("routes: the signature is the authority - an owner session cannot register a device-signed grant", async () => {
  organiser();
  const ownerSession = await delegation(owner);
  const device = Wallet.createRandom();
  const r = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(device, grantFor(Wallet.createRandom().address)));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "not-owner");
  assert.equal(existsSync(FILE), false);
});

test("routes: a device cannot spend its account's budget and block its own removal", async () => {
  organiser();
  const ownerSession = await delegation(owner);
  const device = Wallet.createRandom();
  const other = Wallet.createRandom();
  await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(device.address)), "198.51.100.1");
  await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(other.address)), "198.51.100.1");
  const otherRemoval = await signRevoke(owner, other.address);
  await call(ownerSession, "POST", "/api/auth/device-grants/revoke", otherRemoval, "198.51.100.1");

  // From many addresses: refused statements, and a removal that is already in place.
  const deviceSession = await delegation(device);
  for (let i = 0; i < 4; i++) {
    const junk = await call(deviceSession, "POST", "/api/auth/device-grants/revoke", { revoke: { nope: i } }, `203.0.113.${i}`);
    assert.equal(junk.status, 400);
    const noop = await call(deviceSession, "POST", "/api/auth/device-grants/revoke", otherRemoval, `203.0.113.${50 + i}`);
    assert.equal(noop.status, 200);
  }

  const removal = await call(ownerSession, "POST", "/api/auth/device-grants/revoke", await signRevoke(owner, device.address), "198.51.100.1");
  assert.equal(removal.status, 200, JSON.stringify(removal.json));
  assert.equal(grants.lookupDeviceGrant(PARENT, device.address)?.active, false);
});

test("routes: the first device needs a verified organiser; removal and later devices never do", async () => {
  const ownerSession = await delegation(owner);
  const device = Wallet.createRandom();

  const listed = await call(ownerSession, "GET", "/api/auth/device-grants");
  assert.equal(listed.json.data.canAddDevices, false);
  const refused = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(device.address)));
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "STRIPE_VERIFICATION_REQUIRED");
  assert.equal(existsSync(FILE), false, "nothing stored");

  organiser(false);
  const stillRefused = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(device.address)));
  assert.equal(stillRefused.status, 403, "a Stripe account that is not verified yet is not enough");

  organiser();
  assert.equal((await call(ownerSession, "GET", "/api/auth/device-grants")).json.data.canAddDevices, true);
  const added = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(device.address)));
  assert.equal(added.status, 200, JSON.stringify(added.json));

  // Stripe asks for more details later: the account keeps managing its devices.
  organiser(false);
  assert.equal((await call(ownerSession, "GET", "/api/auth/device-grants")).json.data.canAddDevices, true);
  const second = await call(ownerSession, "POST", "/api/auth/device-grants", await signGrant(owner, grantFor(Wallet.createRandom().address)));
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const removed = await call(ownerSession, "POST", "/api/auth/device-grants/revoke", await signRevoke(owner, device.address));
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
});
