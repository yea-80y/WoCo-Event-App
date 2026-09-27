/**
 * The guardian's account index on Etherna's batch (#689, family 4) - the REAL
 * upsert, read and auto-find on the fake Swarm net (fake-swarm-net.ts).
 *
 * This is the one recovery feed with SEVERAL writers: every account a backup
 * protects adds itself to that backup's index, from its own device. So the case
 * that matters is the second account protecting while the first one's version is
 * still on Etherna's node only - its rewrite must see that version, or the first
 * account falls out of the index for good. And the portal reads it on a device
 * that has never seen it, for a user who is locked out.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GUARDIAN_ACCOUNT_INDEX_TOPIC,
  calculateSocAddress,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
} from "@woco/shared";
import { guardianKeysFromMaster, type GuardianKeys } from "../src/lib/auth/recovery-escrow.js";
import { autoFindAccount } from "../src/lib/auth/recovery-autofind.js";
import { readGuardianAccountIndex, upsertGuardianAccountIndex } from "../src/lib/swarm/guardian-index-feed.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import { hex, install, propagate, resetNet, restoreNet, transport, unhex, type Net, type Sent } from "./fake-swarm-net.js";

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const D = "0x" + "d4".repeat(20);

let gk: GuardianKeys;

beforeEach(async () => {
  resetNet();
  gk ??= await guardianKeysFromMaster(new Uint8Array(32).fill(5));
});
afterEach(restoreNet);

/** Another device: the same backup, none of this device's local state. */
function newDevice(net: Net): void {
  resetNet();
  install(net);
}

async function protect(net: Net, kernelAddress: string, log: Sent[] = []) {
  return upsertGuardianAccountIndex({
    socSignerPrivKey: gk.socSigner.privKey,
    socOwnerAddress: gk.socSigner.address,
    entry: { kernelAddress, addedAt: Date.now() },
    transport: transport(net, log).transport,
  });
}

async function listed(): Promise<string[]> {
  const res = await readGuardianAccountIndex(gk.socSigner.address);
  assert.equal(res.status, "found", JSON.stringify(res));
  return res.status === "found" ? res.value.accounts.map((a) => a.kernelAddress).sort() : [];
}

const versionAddress = (v: number) =>
  hex(calculateSocAddress(
    versionedSocIdentifier(contentFeedSocIdentifier(GUARDIAN_ACCOUNT_INDEX_TOPIC), v),
    unhex(gk.socSigner.address.replace(/^0x/, "")),
  ));

test("a second account protecting from another device keeps the first, whose version is on Etherna only", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const log: Sent[] = [];
  assert.deepEqual(await protect(net, A, log), { status: "written", version: 0 });
  assert.equal(net.ourBee.size, 0);

  newDevice(net);
  assert.deepEqual(await protect(net, B, log), { status: "written", version: 1 });
  assert.deepEqual(log.map((s) => [s.gatewayUrl, s.family]), [
    [ETHERNA_GATEWAY_URL, "guardianIndex"],
    [ETHERNA_GATEWAY_URL, "guardianIndex"],
  ]);

  newDevice(net);
  assert.deepEqual(await listed(), [A, B]);
});

test("the portal finds a locked-out user's account in an index that has not reached our bee", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await protect(net, A);

  newDevice(net);
  const out = await autoFindAccount({
    index: await readGuardianAccountIndex(gk.socSigner.address),
    isRegistered: async (k) => k === A,
  });
  assert.deepEqual(out, { status: "found", kernelAddress: A });
});

test("Etherna unreachable: the upsert writes nothing and the portal says it could not look", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await protect(net, A);
  net.ethernaDown = true;

  newDevice(net);
  const log: Sent[] = [];
  const out = await protect(net, B, log);
  assert.equal(out.status, "skipped", JSON.stringify(out));
  assert.deepEqual(log, []);

  newDevice(net);
  const found = await autoFindAccount({
    index: await readGuardianAccountIndex(gk.socSigner.address),
    isRegistered: async () => true,
  });
  assert.equal(found.status, "unavailable", JSON.stringify(found));
});

/**
 * WHY THE ROW IS `stamp: "platform"`. Each version is paid for by whichever
 * account wrote it. On accounts' own batches, one lapse removes a middle version,
 * and a scan ends at the first missing version: the index reads as the version
 * before the gap, CLEAN, so the next protect rewrites from it, lands in the gap,
 * and a reader then walks past the gap to the older versions above it. Pinned so
 * the premise behind the policy is executed, not asserted.
 */
test("a lapsed middle version truncates the index and the next protect is lost - the reason recovery is platform-stamped", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await protect(net, A);
  await protect(net, B);
  await protect(net, C);
  propagate(net);
  for (const store of [net.ourBee, net.etherna]) store.delete(versionAddress(1));

  newDevice(net);
  const read = await readGuardianAccountIndex(gk.socSigner.address);
  assert.equal(read.status === "found" && read.version, 0);
  assert.equal(read.status === "found" && read.scanClean, true, "the gap reads as the end, cleanly");

  newDevice(net);
  assert.deepEqual(await protect(net, D), { status: "written", version: 1 });
  newDevice(net);
  assert.deepEqual(await listed(), [A, B, C], "D was written into the gap and is read past");
});
