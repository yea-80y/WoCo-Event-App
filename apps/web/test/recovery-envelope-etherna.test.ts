/**
 * The recovery escrow on Etherna's batch (#689, family 4) - the REAL upload and
 * read on the fake Swarm net (fake-swarm-net.ts), a real X-Wing envelope, and the
 * ceremony's decision (`openEscrow`) with the same `open` the ceremony hands it.
 *
 * Why the read is thorough now. Its `absent` becomes "No backup found - recovery
 * isn't possible", said to someone who is locked out. After the move an escrow
 * sits on Etherna's node before it has spread through Swarm to our bee, and a
 * read that trusts our gateway's 404 in that window would say exactly that about
 * an account that is perfectly recoverable. Every read here is from a NEW device,
 * which is who runs a recovery.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentFeedSocIdentifier, recoveryContentTopic, versionedSocIdentifier, type RecoveryEnvelope } from "@woco/shared";
import {
  guardianKeysFromMaster,
  openRecoveryBundle,
  sealRecoveryBundle,
  type GuardianKeys,
} from "../src/lib/auth/recovery-escrow.js";
import {
  RetiredRecoveryEnvelopeVersionError,
  UnknownRecoveryEnvelopeVersionError,
} from "../src/lib/auth/recovery-aad.js";
import { ESCROW_NONE, ESCROW_UNREACHABLE, ESCROW_WRONG_WALLET, openEscrow } from "../src/lib/auth/escrow-read.js";
import { readRecoveryEnvelopeSocResult, uploadRecoveryEnvelopeSoc } from "../src/lib/swarm/recovery-feed.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import {
  gatewayParam,
  hex,
  install,
  propagate,
  requests,
  resetNet,
  restoreNet,
  serverRequests,
  transport,
  type Net,
} from "./fake-swarm-net.js";

const KERNEL = "0x" + "ab".repeat(20);
const SEED = "0x" + "cd".repeat(32);
const BASE = contentFeedSocIdentifier(recoveryContentTopic(KERNEL));

let gk: GuardianKeys;
let otherGk: GuardianKeys;

beforeEach(async () => {
  resetNet();
  gk ??= await guardianKeysFromMaster(new Uint8Array(32).fill(3));
  otherGk ??= await guardianKeysFromMaster(new Uint8Array(32).fill(4));
});
afterEach(restoreNet);

function newDevice(net: Net): void {
  resetNet();
  install(net);
}

async function envelope(): Promise<RecoveryEnvelope> {
  return sealRecoveryBundle({
    bundle: { version: 1, secrets: { identitySeed: SEED } },
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [gk.encryption.publicKeyHex],
  });
}

async function upload(net: Net, env: RecoveryEnvelope) {
  const sent = transport(net);
  await uploadRecoveryEnvelopeSoc({ socSignerPrivKey: gk.socSigner.privKey, kernelAddress: KERNEL, envelope: env, transport: sent.transport });
  return sent.log;
}

/** The ceremony's `open`, as auth-store hands it to `openEscrow`. */
const openWith = (keys: GuardianKeys) => async (env: RecoveryEnvelope) => {
  const bundle = await openRecoveryBundle({ envelope: env, kernelAddress: KERNEL, role: "guardian", guardianKeypair: keys.encryption });
  if (!bundle.secrets.identitySeed) throw new Error("missing identitySeed");
  return bundle.secrets.identitySeed;
};

const recover = async (keys = gk) => openEscrow(await readRecoveryEnvelopeSocResult(keys.socSigner.address, KERNEL), openWith(keys));

const askedId = (u: string) => u.split("?")[0]!.split("/").pop()!;

test("an escrow uploaded through Etherna's batch opens on a new device before our bee has it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const log = await upload(net, await envelope());
  assert.equal(net.ourBee.size, 0);
  assert.deepEqual(log.map((s) => [s.gatewayUrl, s.family]), [[ETHERNA_GATEWAY_URL, "recoveryEnvelope"]]);

  newDevice(net);
  assert.equal(await recover(), SEED);
  for (const u of serverRequests()) assert.equal(gatewayParam(u), ETHERNA_GATEWAY_URL, u);
});

test("Etherna unreachable before the escrow spread: 'try again', never 'No backup found'", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await upload(net, await envelope());
  net.ethernaDown = true;
  newDevice(net);
  await assert.rejects(recover(), { message: ESCROW_UNREACHABLE });
});

test("no escrow anywhere: 'No backup found', after one round and no other lookup", async () => {
  newDevice({ ourBee: new Map(), etherna: new Map() });
  await assert.rejects(recover(), { message: ESCROW_NONE });
  const asked = serverRequests().map(askedId).sort();
  assert.deepEqual(asked, [hex(versionedSocIdentifier(BASE, 0)), hex(versionedSocIdentifier(BASE, 1))].sort());
  assert.ok(!asked.includes(hex(BASE)), "the pre-versioning identifier was asked");
  // Nothing but our gateway and the SOC read - in particular not the retired
  // platform-feed fallback (`/api/recovery/escrow/`).
  assert.deepEqual(requests.filter((u) => !u.startsWith("https://gateway.woco-net.com/chunks/") && !u.startsWith("/api/swarm/soc/")), []);
});

test("a RETIRED envelope a newer one may sit above, unseen: 'try again', not 'set recovery up again'", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await upload(net, { ...(await envelope()), v: 2 }); // a pre-#642 envelope at version 0
  propagate(net);
  await upload(net, await envelope()); // re-protected with the current format, version 1, Etherna only
  net.ethernaDown = true;
  newDevice(net);
  await assert.rejects(recover(), { message: ESCROW_UNREACHABLE });

  net.ethernaDown = false;
  newDevice(net);
  assert.equal(await recover(), SEED, "with Etherna back, the current envelope opens");
});

test("a RETIRED envelope that IS the newest: the typed error, which tells the user what to do", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await upload(net, { ...(await envelope()), v: 2 });
  newDevice(net);
  await assert.rejects(recover(), (e: unknown) => e instanceof RetiredRecoveryEnvelopeVersionError);
});

test("an envelope from a NEWER app is always the typed error - clean scan or not", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await upload(net, { ...(await envelope()), v: 99 });
  propagate(net);
  await upload(net, { ...(await envelope()), v: 99 });
  net.ethernaDown = true; // version 1 unseen: a dirty scan
  newDevice(net);
  await assert.rejects(recover(), (e: unknown) => e instanceof UnknownRecoveryEnvelopeVersionError);
});

test("the wrong backup wallet: the one message that does not say which it was", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  await upload(net, await envelope());
  newDevice(net);
  const read = await readRecoveryEnvelopeSocResult(gk.socSigner.address, KERNEL);
  await assert.rejects(openEscrow(read, openWith(otherGk)), { message: ESCROW_WRONG_WALLET });
});

test("the ceremony decides through openEscrow and has no fallback read", () => {
  const src = readFileSync(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url), "utf8");
  assert.match(src, /readRecoveryEnvelopeSocResult\(guardianKeys\.socSigner\.address, target\)/);
  assert.match(src, /await openEscrow\(socRead, /);
  assert.doesNotMatch(src, /fetchRecoveryEnvelope/);
  assert.doesNotMatch(src, /No backup found for that account/, "the copy lives in escrow-read.ts only");
});
