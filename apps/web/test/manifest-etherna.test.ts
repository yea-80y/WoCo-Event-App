/**
 * The manifest on Etherna (#689), run for real.
 *
 * The REAL mutators, the REAL writer (its thorough, routed version probe and its
 * dirty-scan refusal) and the REAL readers run against a faked network
 * (fake-swarm-net.ts); only the transport is swapped, for one that verifies the
 * signed chunk and stamps it where the server would. An Etherna-stamped version
 * reaches our bee only when a test says so - in production that took minutes.
 *
 * Every mutator rewrites the WHOLE manifest, so each test here is one way a
 * rewrite could be built on a copy older than the newest, and would then erase
 * the newer one while reporting success (#651's shape).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  USER_MANIFEST_TOPIC,
  USER_MANIFEST_VERSION,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
  type BackupInventoryEntry,
  type ManifestFeedEntry,
  type UserManifest,
} from "@woco/shared";
import {
  diagnoseManifest,
  readUserManifestResult,
  rebuildManifest,
  retireBackupInventory,
  retireOneBackup,
  upsertBackupEntry,
  upsertFeedEntry,
  withManifestLock,
  type ManifestLocks,
} from "../src/lib/manifest/inventory.js";
import { readBackupHistoryResult } from "../src/lib/manifest/backup-inventory.js";
import { openFromSelf, sealToSelf } from "../src/lib/manifest/self-seal.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import {
  OWNER,
  OWNER_PRIV,
  install,
  propagate,
  resetNet,
  restoreNet,
  soc,
  transport,
  type Net,
  type StoredSoc,
} from "./fake-swarm-net.js";

beforeEach(resetNet);
afterEach(restoreNet);

const signer = { privKey: OWNER_PRIV, address: `0x${OWNER}` };
const parentAddress = `0x${"aa".repeat(20)}`;
const G1 = `0x${"b1".repeat(20)}`;
const G2 = `0x${"b2".repeat(20)}`;
const G3 = `0x${"b3".repeat(20)}`;

const backup = (guardianAddress: string): BackupInventoryEntry => ({ method: "wallet", guardianAddress, addedAt: 1 });
const feed = (topic: string): ManifestFeedEntry => ({ kind: "event", topic, updatedAt: 1 });
const manifestOf = (backups: BackupInventoryEntry[], feeds: ManifestFeedEntry[] = []): UserManifest =>
  ({ v: USER_MANIFEST_VERSION, updatedAt: 1, backups, feeds });

const at = (v: number) => versionedSocIdentifier(contentFeedSocIdentifier(USER_MANIFEST_TOPIC), v);
const sealed = (v: number, m: UserManifest): StoredSoc =>
  soc(at(v), sealToSelf({ feedSignerPrivKey: signer.privKey, parentAddress, data: m }));
const put = (store: Map<string, StoredSoc>, chunk: StoredSoc) => void store.set(chunk.address, chunk);

/** The newest version across BOTH stores, opened directly - the truth, not what
 *  any reader under test concluded. */
function newest(net: Net): { version: number; manifest: UserManifest } {
  let v = 0;
  let last: StoredSoc | undefined;
  for (;; v++) {
    const address = sealed(v, manifestOf([])).address;
    const chunk = net.ourBee.get(address) ?? net.etherna.get(address);
    if (!chunk) break;
    last = chunk;
  }
  assert.ok(last, "no manifest was written");
  const envelope = JSON.parse(new TextDecoder().decode(last.payload));
  return { version: v - 1, manifest: openFromSelf<UserManifest>({ feedSignerPrivKey: signer.privKey, parentAddress, envelope }) };
}
const guardians = (m: UserManifest) => m.backups.map((b) => `${b.guardianAddress}${b.revoked ? ":retired" : ""}`).sort();
const topics = (m: UserManifest) => (m.feeds ?? []).map((f) => f.topic).sort();

/** A manifest written before the move: versions 0..n-1 on our bee (WoCo). */
function wocoEra(...versions: UserManifest[]): Net {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  versions.forEach((m, v) => put(net.ourBee, sealed(v, m)));
  return net;
}

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

test("manifest writes are stamped on Etherna, and the next edit on this device builds on them before our bee has them", async () => {
  const net = wocoEra(manifestOf([backup(G1)]), manifestOf([backup(G1)], [feed("woco/event/a")]));
  install(net);
  const { transport: send, log } = transport(net);

  await upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/b"), transport: send });
  await upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/c"), transport: send });

  assert.equal(log.length, 2);
  for (const u of log) assert.equal(u.gatewayUrl, ETHERNA_GATEWAY_URL, "stamped on Etherna");
  assert.equal(net.ourBee.size, 2, "nothing new stamped on WoCo");
  const { version, manifest } = newest(net);
  assert.equal(version, 3, "the WoCo-era versions were seen, so the sequence continued past them");
  assert.deepEqual(topics(manifest), ["woco/event/a", "woco/event/b", "woco/event/c"], "each edit kept the one before it");
  assert.deepEqual(guardians(manifest), [G1]);
});

test("another device's edit, still only on Etherna, survives a retire on this one", async () => {
  const net = wocoEra(manifestOf([backup(G1), backup(G2)]));
  put(net.etherna, sealed(1, manifestOf([backup(G1), backup(G2), backup(G3)])));
  install(net);
  const { transport: send } = transport(net);

  assert.equal(await retireOneBackup({ signer, parentAddress, guardianAddress: G1, transport: send }), "retired");
  assert.deepEqual(guardians(newest(net).manifest), [`${G1}:retired`, G2, G3]);
});

test("the same for retiring every backup, and for adding one", async () => {
  const net = wocoEra(manifestOf([backup(G1)]));
  put(net.etherna, sealed(1, manifestOf([backup(G1)], [feed("woco/event/other-device")])));
  install(net);
  const { transport: send } = transport(net);

  assert.equal(await retireBackupInventory({ signer, parentAddress, transport: send }), "retired");
  await upsertBackupEntry({ signer, parentAddress, entry: backup(G2), transport: send });

  const { manifest } = newest(net);
  assert.deepEqual(guardians(manifest), [`${G1}:retired`, G2]);
  assert.deepEqual(topics(manifest), ["woco/event/other-device"]);
});

// ---------------------------------------------------------------------------
// Guards the move leans on
// ---------------------------------------------------------------------------

test("Etherna unreachable for the base read and back for the write: every mutator refuses", async () => {
  const cases: Array<[string, (send: ReturnType<typeof transport>["transport"]) => Promise<unknown>]> = [
    ["upsertFeedEntry", (send) => upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/x"), transport: send })],
    ["upsertBackupEntry", (send) => upsertBackupEntry({ signer, parentAddress, entry: backup(G3), transport: send })],
    ["retireOneBackup", (send) => retireOneBackup({ signer, parentAddress, guardianAddress: G1, transport: send })],
    ["retireBackupInventory", (send) => retireBackupInventory({ signer, parentAddress, transport: send })],
  ];
  for (const [name, run] of cases) {
    resetNet();
    const net = wocoEra(manifestOf([backup(G1)]));
    put(net.etherna, sealed(1, manifestOf([backup(G1), backup(G2)])));
    // Only the base read's question about version 1 goes unanswered; the
    // writer's own probe, a moment later, gets through and would pass.
    net.ethernaDown = (nth) => nth === 0;
    install(net);
    const { transport: send, log } = transport(net);

    const outcome = await run(send).then((r) => r ?? "wrote", (e: Error) => `threw: ${e.message}`);
    assert.deepEqual(log, [], `${name} wrote (${String(outcome)})`);
    assert.ok(outcome === "unavailable" || String(outcome).startsWith("threw"), `${name}: ${String(outcome)}`);
    assert.deepEqual(guardians(newest(net).manifest), [G1, G2], `${name}: the newer copy is intact`);
  }
});

test("two edits fired at once from one device both land", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);

  // One profile Save with a new avatar logs two feeds back to back, unawaited.
  await Promise.all([
    upsertFeedEntry({ signer, parentAddress, entry: feed("woco/profile/data"), transport: send }),
    upsertFeedEntry({ signer, parentAddress, entry: feed("woco/profile/avatar"), transport: send }),
  ]);
  assert.deepEqual(topics(newest(net).manifest), ["woco/profile/avatar", "woco/profile/data"]);
});

test("a failed edit does not stop the next one", async () => {
  const net = wocoEra(manifestOf([backup(G1)]));
  install(net);
  const { transport: send } = transport(net);
  const failing = async () => { throw new Error("upload refused"); };

  await assert.rejects(upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/a"), transport: failing }));
  await upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/b"), transport: send });
  assert.deepEqual(topics(newest(net).manifest), ["woco/event/b"]);
});

// ---------------------------------------------------------------------------
// The lock itself, on both of its paths
// ---------------------------------------------------------------------------

const LOCK_PATHS: Array<[string, ManifestLocks | null]> = [
  ["Web Locks", (globalThis as { navigator?: { locks?: ManifestLocks } }).navigator?.locks ?? null],
  ["the in-tab chain", null],
];

test("the runtime under test has Web Locks, so both paths below are really exercised", () => {
  assert.ok(LOCK_PATHS[0][1], "navigator.locks is missing - the first path would silently test the chain twice");
});

for (const [path, locks] of LOCK_PATHS) {
  test(`${path}: one owner's edits never overlap, and run in the order asked`, { timeout: 5_000 }, async () => {
    const owner = `0x${"c1".repeat(20)}`;
    let running = 0;
    const order: number[] = [];
    const edit = (n: number) => async () => {
      running++;
      assert.equal(running, 1, "two edits of one manifest ran at once");
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      running--;
    };
    await Promise.all([1, 2, 3].map((n) => withManifestLock(owner, edit(n), { locks })));
    assert.deepEqual(order, [1, 2, 3]);
  });

  test(`${path}: an edit that never finishes is given up on, and the next one runs`, { timeout: 5_000 }, async () => {
    const owner = `0x${"c2".repeat(20)}`;
    const hung = withManifestLock(owner, () => new Promise<never>(() => {}), { locks, timeoutMs: 50 });
    const next = withManifestLock(owner, async () => "ran", { locks, timeoutMs: 50 });
    await assert.rejects(hung, /did not finish/);
    assert.equal(await next, "ran");
  });

  test(`${path}: a stuck edit on one account does not hold up another's`, { timeout: 5_000 }, async () => {
    const stuck = withManifestLock(`0x${"c3".repeat(20)}`, () => new Promise<never>(() => {}), { locks, timeoutMs: 1_000 });
    const t0 = Date.now();
    assert.equal(await withManifestLock(`0x${"c4".repeat(20)}`, async () => "other", { locks, timeoutMs: 1_000 }), "other");
    assert.ok(Date.now() - t0 < 500, "the other account waited for the stuck one");
    await assert.rejects(stuck);
  });
}

test("a repair waits for an edit already running on the same manifest", { timeout: 5_000 }, async () => {
  let release!: () => void;
  const editing = withManifestLock(signer.address, () => new Promise<void>((r) => (release = r)));
  const events: string[] = [];
  const repair = rebuildManifest({
    signer,
    parentAddress,
    seed: null,
    readManifest: async () => (events.push("re-read"), { status: "unavailable", reason: "frozen", unusableAt: 3 }),
    write: async () => (events.push("write"), 4),
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events, [], "the repair read and wrote while another edit held the manifest");
  } finally {
    release(); // a failure here must not leave the lock held for the tests after it
  }
  await editing;
  assert.equal(await repair, 4);
  assert.deepEqual(events, ["re-read", "write"]);
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("the backup list read right after an add shows it - on this device and on another", async () => {
  const net = wocoEra(manifestOf([backup(G1)]));
  install(net);
  const { transport: send } = transport(net);
  await upsertBackupEntry({ signer, parentAddress, entry: backup(G2), transport: send });

  const here = await readBackupHistoryResult({ signer, parentAddress });
  assert.equal(here.status, "known");
  assert.deepEqual((here as { backups: BackupInventoryEntry[] }).backups.map((b) => b.guardianAddress).sort(), [G1, G2]);

  resetNet(); // a second device: no version hint
  install(net);
  const there = await readBackupHistoryResult({ signer, parentAddress });
  assert.deepEqual((there as { backups: BackupInventoryEntry[] }).backups.map((b) => b.guardianAddress).sort(), [G1, G2]);
});

test("a copy that will not open is called frozen only when the scan could confirm it is the newest", async () => {
  // Version 0 is not a manifest; version 1, on Etherna only, is fine.
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.ourBee, soc(at(0), { not: "an envelope" }));
  put(net.etherna, sealed(1, manifestOf([backup(G1)])));

  net.ethernaDown = true;
  install(net);
  const blind = await readUserManifestResult({ signer, parentAddress });
  assert.equal(blind.status, "unavailable");
  assert.equal((blind as { unusableAt?: number }).unusableAt, undefined, "no permanent verdict on a version that may not be the head");
  assert.equal((await diagnoseManifest({ signer, parentAddress })).kind, "transient", "so no repair is offered");

  net.ethernaDown = false;
  const seen = await readUserManifestResult({ signer, parentAddress });
  assert.equal(seen.status, "found");

  // The same unopenable copy IS the head when nothing newer exists anywhere.
  resetNet();
  const alone: Net = { ourBee: new Map(), etherna: new Map() };
  put(alone.ourBee, soc(at(0), { not: "an envelope" }));
  install(alone);
  const frozen = await readUserManifestResult({ signer, parentAddress });
  assert.equal((frozen as { unusableAt?: number }).unusableAt, 0);
});

test("Etherna down after its copy reached our bee: the list still shows, edits wait rather than guess", async () => {
  const net = wocoEra(manifestOf([backup(G1)]));
  install(net);
  const { transport: send, log } = transport(net);
  await upsertBackupEntry({ signer, parentAddress, entry: backup(G2), transport: send });
  propagate(net);
  net.ethernaDown = true;

  const list = await readBackupHistoryResult({ signer, parentAddress });
  assert.deepEqual((list as { backups: BackupInventoryEntry[] }).backups.map((b) => b.guardianAddress).sort(), [G1, G2]);

  // Nobody can say whether a version past the head sits on Etherna, so a
  // rewrite could erase it: refused, not guessed.
  await assert.rejects(upsertFeedEntry({ signer, parentAddress, entry: feed("woco/event/a"), transport: send }));
  assert.equal(log.length, 1);
});
