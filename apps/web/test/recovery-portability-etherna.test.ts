/**
 * The portability envelope on Etherna's batch (#689, family 4) - the REAL writer,
 * readers and back-fill, run against the faked network in fake-swarm-net.ts.
 *
 * Why this row is the careful one. The envelope's `absent` is DURABLE: a passkey
 * login on a device with no recovery binding reads it, and "no envelope" is
 * cached as "this passkey was never recovered" for the life of the device (#138).
 * A recovered account read that way is pinned to the wrong Kernel. After the
 * move, an envelope uploaded seconds ago sits on Etherna's node before it has
 * spread through Swarm to our bee - exactly the moment the SAME passkey's next
 * device (the whole point of the envelope) may ask for it.
 *
 * Every read here is from a NEW device (`newDevice`: no hint, no binding), which
 * is who reads this feed in production.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  PORTABILITY_SOC_IDENTIFIER_INPUT,
  calculateSocAddress,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
} from "@woco/shared";
import {
  backfillPortabilityEnvelope,
  decideBackfill,
  derivePortabilityKeys,
  portabilityEnvelopeExists,
  readPortabilityEnvelope,
  writePortabilityEnvelope,
} from "../src/lib/auth/recovery-portability.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import {
  gatewayParam,
  hex,
  install,
  propagate,
  resetNet,
  restoreNet,
  serverRequests,
  transport,
  unhex,
  type Net,
} from "./fake-swarm-net.js";

const PRF = "0x" + "5a".repeat(32);
const KERNEL = "0x" + "ab".repeat(20);
const SEED = "0x" + "cd".repeat(32);
const SECRETS = { prfSecret: PRF, preservedKernelAddress: KERNEL, identitySeed: SEED };

const BASE = contentFeedSocIdentifier(PORTABILITY_SOC_IDENTIFIER_INPUT);

beforeEach(resetNet);
afterEach(restoreNet);

/** The same passkey on another device: none of the writer's local state. */
function newDevice(net: Net): void {
  resetNet();
  install(net);
}

async function owner(): Promise<string> {
  return (await derivePortabilityKeys(PRF)).socOwnerAddress.replace(/^0x/, "").toLowerCase();
}

/** The identifier a server request asked about. */
const askedId = (u: string) => u.split("?")[0]!.split("/").pop()!;

async function writeOnce(net: Net) {
  const sent = transport(net);
  await writePortabilityEnvelope({ ...SECRETS, transport: sent.transport });
  return sent.log;
}

test("written through Etherna's batch, and found by the passkey's next device before our bee has it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const log = await writeOnce(net);
  assert.equal(net.ourBee.size, 0, "stamped on Etherna, not on our bee");
  assert.equal(net.etherna.size, 1);
  assert.deepEqual(log.map((s) => s.gatewayUrl), [ETHERNA_GATEWAY_URL]);

  newDevice(net);
  const read = await readPortabilityEnvelope({ prfSecret: PRF });
  assert.deepEqual(read, { status: "found", value: { preservedKernelAddress: KERNEL, identitySeed: SEED } });
  assert.ok(serverRequests().length > 0);
  for (const u of serverRequests()) assert.equal(gatewayParam(u), ETHERNA_GATEWAY_URL, u);

  newDevice(net);
  assert.deepEqual(await portabilityEnvelopeExists({ prfSecret: PRF }), { status: "present" });
});

test("Etherna unreachable before the chunk spread: `unreadable`, never the cacheable `absent`", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await writeOnce(net);
  net.ethernaDown = true;

  newDevice(net);
  const read = await readPortabilityEnvelope({ prfSecret: PRF });
  assert.equal(read.status, "unreadable", JSON.stringify(read));
  newDevice(net);
  const exists = await portabilityEnvelopeExists({ prfSecret: PRF });
  assert.equal(exists.status, "unreadable", JSON.stringify(exists));
});

test("a never-recovered passkey asks versions 0 and 1 only - never the pre-versioning address", async () => {
  newDevice({ ourBee: new Map(), etherna: new Map() });
  assert.deepEqual(await readPortabilityEnvelope({ prfSecret: PRF }), { status: "absent" });
  const asked = serverRequests().map(askedId).sort();
  assert.deepEqual(asked, [hex(versionedSocIdentifier(BASE, 0)), hex(versionedSocIdentifier(BASE, 1))].sort());
  assert.ok(!asked.includes(hex(BASE)), "the legacy identifier was asked");
  for (const u of serverRequests()) assert.equal(gatewayParam(u), ETHERNA_GATEWAY_URL, u);
});

test("a found from a scan Etherna could not finish is still used - an envelope's content never changes", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await writeOnce(net);
  propagate(net); // version 0 reached our bee
  await writeOnce(net); // version 1, on Etherna only
  net.ethernaDown = true;

  newDevice(net);
  const read = await readPortabilityEnvelope({ prfSecret: PRF });
  assert.deepEqual(read, { status: "found", value: { preservedKernelAddress: KERNEL, identitySeed: SEED } });
  assert.deepEqual(decideBackfill(read, SECRETS), { action: "skipped", reason: "envelope already current" });
});

test("the back-fill writes nothing while it cannot see the envelope, and nothing twice once it can", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await writeOnce(net);

  net.ethernaDown = true;
  newDevice(net);
  const blind = transport(net);
  const deferred = await backfillPortabilityEnvelope({ ...SECRETS, transport: blind.transport });
  assert.equal(deferred.action, "deferred", JSON.stringify(deferred));
  assert.deepEqual(blind.log, []);

  net.ethernaDown = false;
  newDevice(net);
  const seeing = transport(net);
  const skipped = await backfillPortabilityEnvelope({ ...SECRETS, transport: seeing.transport });
  assert.equal(skipped.action, "skipped", JSON.stringify(skipped));
  assert.deepEqual(seeing.log, []);
});

test("a first back-fill is uploaded through Etherna's gateway", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  newDevice(net);
  const sent = transport(net);
  const wrote = await backfillPortabilityEnvelope({ ...SECRETS, transport: sent.transport });
  assert.equal(wrote.action, "wrote", JSON.stringify(wrote));
  assert.deepEqual(sent.log.map((s) => s.gatewayUrl), [ETHERNA_GATEWAY_URL]);
  const v0 = hex(calculateSocAddress(versionedSocIdentifier(BASE, 0), unhex(await owner())));
  assert.ok(net.etherna.has(v0), "version 0 is on Etherna");
});
