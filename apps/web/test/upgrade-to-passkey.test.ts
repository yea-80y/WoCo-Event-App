/**
 * The email -> passkey upgrade (#746), run against fakes that record every call.
 *
 * The four invariants the owner set for it (feedback_attendee_data_pq_day_one) each
 * have their own case, named PQ1-PQ4:
 *   PQ1  the new seed is the passkey's PRF seed only - never derived from, signed by
 *        or passed through the email key;
 *   PQ2  the old seed sealed nothing an organiser holds (an account hosting events or
 *        websites is refused) and leaves the device once the switch lands;
 *   PQ3  the email key comes off the signer list - the switch lists the passkey ALONE -
 *        and every backup is removed BEFORE it;
 *   PQ4  the new seed is sealed to the passkey only (its locked copy and envelope),
 *        never to an escrow or any other key.
 *
 * MUTATION: keep the email key on the list, mint before the reads or derive the seed
 * from anything but the PRF output, send before the retraction, skip the envelope
 * read-back, wipe nothing at finalize, or re-post before the switch, and a case goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveFeedSignerKey, passkeyIdentitySeed, type Hex0x } from "@woco/shared";
import {
  BACKUPS_FAILED_MESSAGE,
  COPY_FAILED_MESSAGE,
  ENVELOPE_FAILED_MESSAGE,
  HOSTS_SOMETHING_MESSAGE,
  LOCKED_DEPLOYED_MESSAGE,
  NO_PASSKEYS_MESSAGE,
  READ_FAILED_MESSAGE,
  RETRACT_FAILED_MESSAGE,
  SWITCH_FAILED_MESSAGE,
  WALLET_ACCOUNT_MESSAGE,
  ALREADY_LANDED_MESSAGE,
  NO_SESSION_MESSAGE,
  cancelUpgrade,
  commitUpgrade,
  finalizeUpgrade,
  runCancel,
  runResume,
  runUpgrade,
  moveSocial,
  planUpgrade,
  prepareUpgrade,
  retractOld,
  sendUpgradeSwitch,
  type FeedKey,
  type MarkerStore,
  type PrepareDeps,
  type SwitchChain,
  type UpgradeMarker,
  type UpgradeStoreHost,
} from "../src/lib/auth/upgrade-to-passkey.js";
import { parseUpgradeMarker, upgradeMarkerKey } from "../src/lib/auth/upgrade-marker.js";

const PARENT = "0x1111111111111111111111111111111111111111";
const EMAIL_KEY = "0x2222222222222222222222222222222222222222";
const PASSKEY = "0x3333333333333333333333333333333333333333";
const OLD_SEED = `0x${"a1".repeat(32)}`;
const PRF = `0x${"b2".repeat(32)}`;
const NEW_SEED = passkeyIdentitySeed(PRF);
const OLD_FEED = deriveFeedSignerKey(OLD_SEED);
const NEW_FEED = deriveFeedSignerKey(NEW_SEED);
const LIKE_A = `0x${"0a".repeat(32)}` as Hex0x;
const LIKE_B = `0x${"0b".repeat(32)}` as Hex0x;
const FOLLOW_C = `0x${"0c".repeat(32)}` as Hex0x;
const REFERRER = `0x${"0d".repeat(20)}` as Hex0x;
const CREDENTIAL = { credentialId: "cred-1", rpId: "woco.test" };

type Call = { name: string; args: unknown[] };

function memoryMarkers(): MarkerStore & { map: Map<string, UpgradeMarker> } {
  const map = new Map<string, UpgradeMarker>();
  return {
    map,
    read: (p) => map.get(p.toLowerCase()) ?? null,
    write: (m) => void map.set(m.parent, structuredClone(m)),
    clear: (p) => void map.delete(p.toLowerCase()),
  };
}

function fakes(over: Partial<PrepareDeps> & { writeOk?: (signer: FeedKey, subject: Hex0x, value: boolean) => boolean } = {}) {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => void calls.push({ name, args });
  const marker = memoryMarkers();
  const writes: Array<{ signer: string; kind: string; subject: Hex0x; value: boolean }> = [];
  // What each feed says now, as the indexer would read it: the old feed starts with the account's likes.
  const said = new Map<string, boolean>();
  const key = (feed: string, kind: string, subject: Hex0x) => `${feed.toLowerCase()}|${kind}|${subject}`;
  for (const [kind, subject] of [["like", LIKE_A], ["like", LIKE_B], ["follow", FOLLOW_C]] as const) said.set(key(OLD_FEED.address, kind, subject), true);
  const deps: PrepareDeps = {
    parent: PARENT,
    emailKey: EMAIL_KEY,
    marker,
    social: {
      readLive: async (feed, kind) => {
        rec("readLive")(feed, kind);
        return kind === "like" ? [LIKE_A, LIKE_B] : [FOLLOW_C];
      },
      write: async (signer, kind, subject, value) => {
        rec("socialWrite")(signer.address, kind, subject, value);
        writes.push({ signer: signer.address, kind, subject, value });
        const ok = over.writeOk ? over.writeOk(signer, subject, value) : true;
        if (ok) said.set(key(signer.address, kind, subject), value);
        return ok;
      },
      readStatement: async (feed, kind, subject) => said.get(key(feed, kind, subject)) ?? null,
    },
    hostsSomething: async () => (rec("hostsSomething")(), false),
    backupsRemovable: async () => (rec("backupsRemovable")(), true),
    oldSeed: async () => (rec("oldSeed")(), OLD_SEED),
    readReferrer: async (feed) => (rec("readReferrer")(feed), REFERRER),
    readProfile: async (feed) => (rec("readProfile")(feed), { data: { v: 1, displayName: "A" }, avatar: { v: 1, avatarRef: "ab" } }),
    mintPasskey: async () => (rec("mintPasskey")(), { address: PASSKEY, privateKey: `0x${"c3".repeat(32)}`, prfSecret: PRF, credential: CREDENTIAL }),
    removeBackups: async () => rec("removeBackups")(),
    putBinding: async (...a) => rec("putBinding")(...a),
    storeLockedSeed: async (...a) => rec("storeLockedSeed")(...a),
    clearPasskeyState: async (...a) => rec("clearPasskeyState")(...a),
    writeEnvelope: async (...a) => rec("writeEnvelope")(...a),
    readEnvelope: async (prf) => (rec("readEnvelope")(prf), { parent: PARENT, seed: NEW_SEED }),
    writeProfile: async (signer, copy) => rec("writeProfile")(signer.address, copy),
    writeReferral: async (signer, referrer) => rec("writeReferral")(signer.address, referrer),
    ...over,
  };
  /** True when some subject reads `true` under BOTH feed signers - the account counted twice. */
  const countedTwice = () =>
    [...said.entries()].some(
      ([k, v]) => v && k.startsWith(OLD_FEED.address.toLowerCase()) && said.get(k.replace(OLD_FEED.address.toLowerCase(), NEW_FEED.address.toLowerCase())) === true,
    );
  /** The old feed as a recorded retraction leaves it: every moved subject reads false there. */
  const oldRetracted = () => {
    for (const [kind, subject] of [["like", LIKE_A], ["like", LIKE_B], ["follow", FOLLOW_C]] as const) said.set(key(OLD_FEED.address, kind, subject), false);
  };
  return { deps, calls, marker, writes, said, key, countedTwice, oldRetracted, names: () => calls.map((c) => c.name) };
}

/** Every argument any dep was ever handed, flattened to strings. */
function everyArg(calls: Call[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  calls.forEach((c) => c.args.forEach(walk));
  return out;
}

const prepared = (over: Partial<UpgradeMarker> = {}): UpgradeMarker => ({
  v: 1,
  parent: PARENT,
  emailKey: EMAIL_KEY,
  oldFeedSigner: OLD_FEED.address.toLowerCase(),
  passkey: PASSKEY,
  credential: CREDENTIAL,
  stage: "prepared",
  likes: [LIKE_A, LIKE_B],
  follows: [FOLLOW_C],
  retracted: true,
  ...over,
});

// ── Who is offered what ──────────────────────────────────────────────────────

test("plan: an email account with nothing hosted is offered the upgrade", () => {
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: false, backupsRemovable: true, passkeySupported: true }), { kind: "upgrade" });
});

test("plan: a wallet account, or one that hosts events or websites, gets the separate account only (PQ2)", () => {
  assert.deepEqual(planUpgrade({ authKind: "web3", hostsSomething: false, backupsRemovable: true, passkeySupported: true }), {
    kind: "separate-only",
    reason: WALLET_ACCOUNT_MESSAGE,
  });
  assert.deepEqual(planUpgrade({ authKind: "coinbase", hostsSomething: false, backupsRemovable: true, passkeySupported: true }).kind, "separate-only");
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: true, backupsRemovable: true, passkeySupported: true }), {
    kind: "separate-only",
    reason: HOSTS_SOMETHING_MESSAGE,
  });
});

test("plan: a locked account that is already deployed is turned away before any passkey is made (Fable S1)", () => {
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: false, backupsRemovable: false, passkeySupported: true }), {
    kind: "separate-only",
    reason: LOCKED_DEPLOYED_MESSAGE,
  });
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: false, backupsRemovable: "unknown", passkeySupported: true }), {
    kind: "unavailable",
    reason: READ_FAILED_MESSAGE,
  });
});

test("plan: no passkeys in this browser, or an unanswered check, decides nothing", () => {
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: false, backupsRemovable: true, passkeySupported: false }), {
    kind: "unavailable",
    reason: NO_PASSKEYS_MESSAGE,
  });
  assert.deepEqual(planUpgrade({ authKind: "web3auth", hostsSomething: "unknown", backupsRemovable: true, passkeySupported: true }), {
    kind: "unavailable",
    reason: READ_FAILED_MESSAGE,
  });
});

// ── The marker ───────────────────────────────────────────────────────────────

test("marker: round-trips, and anything malformed reads as none", () => {
  const m = prepared();
  assert.deepEqual(parseUpgradeMarker(JSON.stringify(m)), m);
  assert.equal(upgradeMarkerKey("0xABCDEF0000000000000000000000000000000000"), "woco:passkey-upgrade:0xabcdef0000000000000000000000000000000000");
  for (const bad of [
    "not json",
    JSON.stringify({ ...m, v: 2 }),
    JSON.stringify({ ...m, stage: "done" }),
    JSON.stringify({ ...m, passkey: "0x123" }),
    JSON.stringify({ ...m, credential: { rpId: "x" } }),
    JSON.stringify({ ...m, likes: ["nope"] }),
    JSON.stringify({ ...m, retracted: "yes" }),
  ]) {
    assert.equal(parseUpgradeMarker(bad), null, bad.slice(0, 40));
  }
  assert.equal(parseUpgradeMarker(null), null);
});

test("marker: it holds no secret - no seed, no PRF output, no private key", () => {
  const m = prepared();
  const text = JSON.stringify(m).toLowerCase();
  for (const secret of [OLD_SEED, NEW_SEED, PRF, OLD_FEED.privKey, NEW_FEED.privKey]) {
    assert.ok(!text.includes(secret.slice(2).toLowerCase()), "a secret in the marker");
  }
});

// ── Prepare ──────────────────────────────────────────────────────────────────

test("prepare: reads first, then the passkey, backups off, its hold, the copies, the marker - in that order", async () => {
  const f = fakes();
  const { marker, live } = await prepareUpgrade(f.deps);
  const order = f.names().filter((n) => n !== "readLive" && n !== "readReferrer" && n !== "readProfile");
  assert.deepEqual(order, [
    "hostsSomething",
    "backupsRemovable",
    "oldSeed",
    "mintPasskey",
    "removeBackups",
    "putBinding",
    "storeLockedSeed",
    "writeEnvelope",
    "readEnvelope",
    "writeProfile",
    "writeReferral",
  ]);
  const mint = f.names().indexOf("mintPasskey");
  for (const read of ["readLive", "readReferrer", "readProfile"]) {
    assert.ok(f.names().lastIndexOf(read) < mint, `${read} before the passkey is made`);
  }
  assert.deepEqual(f.marker.map.get(PARENT), marker);
  assert.deepEqual(marker, prepared({ retracted: false }));
  assert.equal(live.passkey, PASSKEY);
  assert.equal(live.seed, NEW_SEED);
  assert.equal(f.writes.length, 0, "nothing retracted by prepare itself");
});

test("PQ1: the new seed is passkeyIdentitySeed(PRF) - and the email side never sees it", async () => {
  const f = fakes();
  await prepareUpgrade(f.deps);
  const stored = f.calls.find((c) => c.name === "storeLockedSeed")!.args;
  assert.deepEqual(stored, [PASSKEY, PARENT, NEW_SEED, PRF]);
  assert.deepEqual(f.calls.find((c) => c.name === "writeEnvelope")!.args, [{ prfSecret: PRF, parent: PARENT, seed: NEW_SEED }]);
  assert.notEqual(NEW_SEED, OLD_SEED);
  // The email key's own steps - the backup removal it signs, the reads of its feed -
  // were handed nothing derived from the passkey.
  for (const c of f.calls.filter((c) => ["removeBackups", "hostsSomething", "backupsRemovable", "oldSeed", "readLive", "readReferrer", "readProfile"].includes(c.name))) {
    const args = everyArg([c]);
    assert.ok(!args.includes(NEW_SEED) && !args.includes(PRF), `${c.name} saw the passkey's secret`);
  }
});

test("PQ4: the new seed reaches only its PRF-locked copy and the PRF-sealed envelope", async () => {
  const f = fakes();
  await prepareUpgrade(f.deps);
  const seen = f.calls.filter((c) => everyArg([c]).includes(NEW_SEED.toLowerCase())).map((c) => c.name);
  assert.deepEqual(seen.sort(), ["storeLockedSeed", "writeEnvelope"]);
  // Each of those carries the passkey's PRF output - the key it is sealed under.
  for (const name of seen) assert.ok(everyArg(f.calls.filter((c) => c.name === name)).includes(PRF.toLowerCase()), name);
  // The copies are SIGNED by the new feed key (a KDF child of the seed), never handed the seed.
  assert.deepEqual(f.calls.find((c) => c.name === "writeProfile")!.args[0], NEW_FEED.address);
  assert.deepEqual(f.calls.find((c) => c.name === "writeReferral")!.args, [NEW_FEED.address, REFERRER]);
});

test("PQ2: an account hosting events or websites is refused before any passkey is made", async () => {
  for (const hosts of [true, "unknown"] as const) {
    const f = fakes({ hostsSomething: async () => hosts });
    await assert.rejects(prepareUpgrade(f.deps), { message: hosts === true ? HOSTS_SOMETHING_MESSAGE : READ_FAILED_MESSAGE });
    assert.ok(!f.names().includes("mintPasskey"));
    assert.equal(f.marker.map.size, 0);
  }
});

test("prepare: backups that only a paid op could remove stop it before the ceremony (Fable S1)", async () => {
  for (const [removable, message] of [[false, LOCKED_DEPLOYED_MESSAGE], ["unknown", READ_FAILED_MESSAGE]] as const) {
    const f = fakes({ backupsRemovable: async () => removable });
    await assert.rejects(prepareUpgrade(f.deps), { message });
    assert.ok(!f.names().includes("mintPasskey") && !f.names().includes("removeBackups"));
  }
});

test("prepare: a read that cannot answer stops before any passkey is made", async () => {
  const cases: Array<Partial<PrepareDeps>> = [
    { oldSeed: async () => null },
    { readReferrer: async () => "unavailable" },
    { readProfile: async () => "unavailable" },
  ];
  for (const over of cases) {
    const f = fakes(over);
    await assert.rejects(prepareUpgrade(f.deps), { message: READ_FAILED_MESSAGE });
    assert.ok(!f.names().includes("mintPasskey"));
  }
  const f = fakes();
  f.deps.social.readLive = async (_feed, kind) => (kind === "follow" ? "unavailable" : []);
  await assert.rejects(prepareUpgrade(f.deps), { message: READ_FAILED_MESSAGE });
  assert.ok(!f.names().includes("mintPasskey"));
});

test("PQ3: backups that would not come off stop everything after them", async () => {
  const f = fakes({ removeBackups: async () => { throw new Error("pm_sponsorUserOperation: refused"); } });
  await assert.rejects(prepareUpgrade(f.deps), { message: BACKUPS_FAILED_MESSAGE });
  for (const later of ["putBinding", "storeLockedSeed", "writeEnvelope", "writeProfile"]) assert.ok(!f.names().includes(later), later);
  assert.equal(f.marker.map.size, 0);
});

test("prepare: an envelope that does not read back as written undoes the passkey's hold, no marker", async () => {
  for (const back of [null, { parent: PARENT, seed: OLD_SEED }, { parent: EMAIL_KEY, seed: NEW_SEED }]) {
    const f = fakes({ readEnvelope: async () => back });
    await assert.rejects(prepareUpgrade(f.deps), { message: ENVELOPE_FAILED_MESSAGE });
    assert.deepEqual(f.calls.find((c) => c.name === "clearPasskeyState")?.args, [PASSKEY]);
    assert.ok(!f.names().includes("writeProfile"), "nothing copied off an unproven envelope");
    assert.equal(f.marker.map.size, 0);
  }
});

test("prepare: a profile or referral copy that fails undoes the passkey's hold, no marker", async () => {
  for (const over of [
    { writeProfile: async () => { throw new Error("relay 502"); } },
    { writeReferral: async () => { throw new Error("superseded"); } },
  ] as Array<Partial<PrepareDeps>>) {
    const f = fakes(over);
    await assert.rejects(prepareUpgrade(f.deps), { message: COPY_FAILED_MESSAGE });
    assert.ok(f.names().includes("clearPasskeyState"));
    assert.equal(f.marker.map.size, 0);
  }
});

test("prepare: nothing to move means nothing to retract", async () => {
  const f = fakes({ readReferrer: async () => null, readProfile: async () => null });
  f.deps.social.readLive = async () => [];
  const { marker } = await prepareUpgrade(f.deps);
  assert.equal(marker.retracted, true);
  assert.ok(!f.names().includes("writeProfile") && !f.names().includes("writeReferral"));
});

// ── Retract ──────────────────────────────────────────────────────────────────

test("retract: every like and follow reads false under the OLD feed, then the marker says so", async () => {
  const f = fakes();
  const m = prepared({ retracted: false });
  f.marker.write(m);
  const next = await retractOld(f.deps, m);
  assert.deepEqual(f.writes, [
    { signer: OLD_FEED.address, kind: "like", subject: LIKE_A, value: false },
    { signer: OLD_FEED.address, kind: "like", subject: LIKE_B, value: false },
    { signer: OLD_FEED.address, kind: "follow", subject: FOLLOW_C, value: false },
  ]);
  assert.equal(next.retracted, true);
  assert.equal(f.marker.map.get(PARENT)?.retracted, true);
});

test("retract: one write short throws and leaves the marker unretracted; the retry rewrites", async () => {
  const f = fakes({ writeOk: (_s, subject) => subject !== LIKE_B });
  const m = prepared({ retracted: false });
  f.marker.write(m);
  await assert.rejects(retractOld(f.deps, m), { message: RETRACT_FAILED_MESSAGE });
  assert.equal(f.marker.map.get(PARENT)?.retracted, false);
});

test("retract: a seed that does not derive the marker's old feed retracts nothing", async () => {
  const f = fakes({ oldSeed: async () => NEW_SEED });
  await assert.rejects(retractOld(f.deps, prepared({ retracted: false })), { message: RETRACT_FAILED_MESSAGE });
  assert.equal(f.writes.length, 0);
});

// ── Switch ───────────────────────────────────────────────────────────────────

function chain(over: Partial<SwitchChain> & { landed?: boolean } = {}) {
  const sent: Array<{ root: string; signers: readonly string[] }> = [];
  const c: SwitchChain = {
    readKernelRoot: async () => "none",
    readKernelSignerFor: async (_k, eoa) => (over.landed && eoa === PASSKEY ? PASSKEY : EMAIL_KEY),
    setCoOwners: async (root, signers) => (sent.push({ root, signers }), { confirmed: true }),
    ...over,
  };
  return { c, sent };
}

test("PQ3: the switch lists the passkey ALONE - the email key is not kept as a co-owner", async () => {
  for (const root of ["none", "ecdsa"] as const) {
    const { c, sent } = chain({ readKernelRoot: async () => root });
    assert.deepEqual(await sendUpgradeSwitch(c, prepared()), { confirmed: true });
    assert.deepEqual(sent, [{ root, signers: [PASSKEY] }]);
  }
});

test("switch: never sent before the old feed is retracted (the account would count twice)", async () => {
  const { c, sent } = chain();
  await assert.rejects(sendUpgradeSwitch(c, prepared({ retracted: false })), { message: SWITCH_FAILED_MESSAGE });
  await assert.rejects(sendUpgradeSwitch(c, prepared({ stage: "committed" })), { message: SWITCH_FAILED_MESSAGE });
  assert.equal(sent.length, 0);
});

test("switch: a throw is judged by the chain - landed is landed, otherwise nothing changed", async () => {
  const boom = async () => { throw new Error("receipt timeout"); };
  assert.deepEqual(await sendUpgradeSwitch(chain({ setCoOwners: boom, landed: true }).c, prepared()), { confirmed: true });
  await assert.rejects(sendUpgradeSwitch(chain({ setCoOwners: boom }).c, prepared()), { message: SWITCH_FAILED_MESSAGE });
});

test("switch: an account already co-owned with the passkey on it is done; an unreadable root sends nothing", async () => {
  const done = chain({ readKernelRoot: async () => "weighted", landed: true });
  assert.deepEqual(await sendUpgradeSwitch(done.c, prepared()), { confirmed: true });
  assert.equal(done.sent.length, 0);
  const other = chain({ readKernelRoot: async () => "weighted" });
  await assert.rejects(sendUpgradeSwitch(other.c, prepared()), { message: SWITCH_FAILED_MESSAGE });
  const dark = chain({ readKernelRoot: async () => "error" });
  await assert.rejects(sendUpgradeSwitch(dark.c, prepared()), { message: SWITCH_FAILED_MESSAGE });
  assert.equal(other.sent.length + dark.sent.length, 0);
});

test("switch: a landed op whose read-back failed is still landed", async () => {
  const { c } = chain({ setCoOwners: async () => ({ confirmed: false }) });
  assert.deepEqual(await sendUpgradeSwitch(c, prepared()), { confirmed: false });
});

// ── Finalize, move, cancel ───────────────────────────────────────────────────

function finalizeFakes() {
  const calls: Call[] = [];
  const marker = memoryMarkers();
  return {
    calls,
    marker,
    deps: {
      marker,
      tombstoneEmailKey: (...a: unknown[]) => void calls.push({ name: "tombstone", args: a }),
      wipeOldSeed: async (...a: unknown[]) => void calls.push({ name: "wipeOldSeed", args: a }),
      forgetEmailLogin: async (...a: unknown[]) => void calls.push({ name: "forgetEmailLogin", args: a }),
      queuePasskeyRecord: (...a: unknown[]) => void calls.push({ name: "queuePasskeyRecord", args: a }),
    },
  };
}

test("PQ2: finalize wipes the old seed off the device and refuses the email key here from now on", async () => {
  const f = finalizeFakes();
  const next = await finalizeUpgrade(f.deps, prepared());
  assert.deepEqual(f.calls.find((c) => c.name === "wipeOldSeed")?.args, [EMAIL_KEY]);
  assert.deepEqual(f.calls.find((c) => c.name === "tombstone")?.args, [EMAIL_KEY, PARENT, PASSKEY]);
  assert.deepEqual(f.calls.find((c) => c.name === "forgetEmailLogin")?.args, [EMAIL_KEY]);
  assert.deepEqual(f.calls.find((c) => c.name === "queuePasskeyRecord")?.args, [CREDENTIAL.credentialId, PARENT]);
  assert.equal(next.stage, "committed");
  assert.equal(f.marker.map.get(PARENT)?.stage, "committed");
  // Idempotent: a resume runs it again.
  await finalizeUpgrade(f.deps, next);
  assert.equal(f.calls.filter((c) => c.name === "wipeOldSeed").length, 2);
});

test("move: likes and follows re-posted under the NEW feed, only after the switch, then the marker goes", async () => {
  const f = fakes();
  f.oldRetracted();
  assert.equal(await moveSocial({ marker: f.marker, social: f.deps.social }, prepared(), NEW_FEED), false, "not before the switch");
  assert.equal(f.writes.length, 0);
  const committed = prepared({ stage: "committed" });
  f.marker.write(committed);
  assert.equal(await moveSocial({ marker: f.marker, social: f.deps.social }, committed, NEW_FEED), true);
  assert.deepEqual(f.writes.map((w) => [w.signer, w.subject, w.value]), [
    [NEW_FEED.address, LIKE_A, true],
    [NEW_FEED.address, LIKE_B, true],
    [NEW_FEED.address, FOLLOW_C, true],
  ]);
  assert.equal(f.marker.map.size, 0);
});

test("move: a write still refused (a locked account) stays in the marker for the next session", async () => {
  const f = fakes({ writeOk: (_s, subject) => subject !== FOLLOW_C });
  f.oldRetracted();
  const committed = prepared({ stage: "committed" });
  f.marker.write(committed);
  assert.equal(await moveSocial({ marker: f.marker, social: f.deps.social }, committed, NEW_FEED), false);
  const left = f.marker.map.get(PARENT)!;
  assert.deepEqual([left.likes, left.follows], [[], [FOLLOW_C]]);
});

test("cancel: likes and follows back under the OLD feed, the passkey's hold and the marker gone", async () => {
  const f = fakes();
  const m = prepared();
  f.marker.write(m);
  await cancelUpgrade(f.deps, m);
  assert.deepEqual(f.writes.map((w) => [w.signer, w.subject, w.value]), [
    [OLD_FEED.address, LIKE_A, true],
    [OLD_FEED.address, LIKE_B, true],
    [OLD_FEED.address, FOLLOW_C, true],
  ]);
  assert.deepEqual(f.calls.find((c) => c.name === "clearPasskeyState")?.args, [PASSKEY]);
  assert.equal(f.marker.map.size, 0);
  await assert.rejects(cancelUpgrade(f.deps, prepared({ stage: "committed" })));
});

test("cancel: a re-post that does not finish keeps the marker and the passkey's hold", async () => {
  const f = fakes({ writeOk: (_s, subject) => subject !== LIKE_A });
  const m = prepared();
  f.marker.write(m);
  await assert.rejects(cancelUpgrade(f.deps, m));
  assert.ok(!f.calls.some((c) => c.name === "clearPasskeyState"));
  assert.equal(f.marker.map.size, 1);
});

test("M1(a): a like pressed under the OLD feed while the switch was refused is never re-posted", async () => {
  const f = fakes();
  const m = prepared({ retracted: false });
  f.marker.write(m);
  const retracted = await retractOld(f.deps, m);
  // The switch was refused; the person, still an email account, likes B again.
  await f.deps.social.write(OLD_FEED, "like", LIKE_B, true);
  const committed = await finalizeUpgrade({ ...finalizeFakes().deps, marker: f.marker }, retracted);
  assert.equal(await moveSocial({ marker: f.marker, social: f.deps.social }, committed, NEW_FEED), true);
  assert.equal(f.said.get(f.key(NEW_FEED.address, "like", LIKE_B)), undefined, "B counts once, under the old feed");
  assert.equal(f.said.get(f.key(NEW_FEED.address, "like", LIKE_A)), true, "the rest moved");
  assert.equal(f.countedTwice(), false);
});

test("M1(b): an Undo in another tab while this tab's switch lands leaves nothing counted twice", async () => {
  const f = fakes();
  const m = prepared();
  f.oldRetracted();
  f.marker.write(m);
  await cancelUpgrade(f.deps, m); // tab B: everything back under the old feed, marker gone
  const committed = await finalizeUpgrade({ ...finalizeFakes().deps, marker: f.marker }, m); // tab A: its op landed
  await moveSocial({ marker: f.marker, social: f.deps.social }, committed, NEW_FEED);
  assert.equal(f.countedTwice(), false);
  assert.ok(!f.writes.some((w) => w.signer === NEW_FEED.address), "nothing re-posted under the new feed");
});

test("M1: an old statement nobody could read is kept for the next session, never posted blind", async () => {
  const f = fakes();
  f.deps.social.readStatement = async (_feed, _kind, subject) => (subject === FOLLOW_C ? "unavailable" : false);
  const committed = prepared({ stage: "committed" });
  f.marker.write(committed);
  assert.equal(await moveSocial({ marker: f.marker, social: f.deps.social }, committed, NEW_FEED), false);
  assert.ok(!f.writes.some((w) => w.subject === FOLLOW_C), "C not posted");
  assert.deepEqual(f.marker.map.get(PARENT)?.follows, [FOLLOW_C]);
});

// ── The runners, over a fake store ──────────────────────────────────────────

function store(over: { kind?: "web3auth" | "passkey"; session?: boolean; landed?: () => boolean; switchFails?: () => boolean; intent?: () => void } = {}) {
  const log: string[] = [];
  const f = fakes();
  const state = { kind: over.kind ?? "web3auth", session: over.session ?? true, passkey: PASSKEY as string | null };
  let adopted: { live: unknown; confirmed: boolean } | null = null;
  const landed = () => (over.landed ? over.landed() : state.kind === "passkey");
  const host: UpgradeStoreHost = {
    emailAccount: () => (state.kind === "web3auth" ? { parent: PARENT, emailKey: EMAIL_KEY, keyReady: true } : null),
    passkeyAccount: () => (state.kind === "passkey" ? { parent: PARENT, passkey: PASSKEY, hasSession: state.session } : null),
    keyMissing: () => new Error("key missing"),
    ensureSession: async () => (log.push("ensureSession"), state.session),
    oldSeed: f.deps.oldSeed,
    removeBackups: f.deps.removeBackups,
    putBinding: f.deps.putBinding,
    clearBinding: async () => void log.push("clearBinding"),
    readSignerFor: async (_k, eoa) => (eoa === PASSKEY && landed() ? PASSKEY : EMAIL_KEY),
    emailKernel: async () => ({
      readKernelRoot: async () => (landed() ? "weighted" : "none"),
      readKernelSignerFor: async (_k, eoa) => (eoa === PASSKEY && landed() ? PASSKEY : EMAIL_KEY),
      setCoOwners: async (_root, signers) => {
        log.push(`switch:${signers.join(",")}`);
        if (over.switchFails?.()) throw new Error("sponsorship refused");
        state.kind = "passkey";
        return { confirmed: true };
      },
    }),
    adoptPasskey: async (_m, live, confirmed) => {
      log.push("adoptPasskey");
      adopted = { live, confirmed };
      state.kind = "passkey";
    },
    finalizeDeps: () => ({
      tombstoneEmailKey: () => void log.push("tombstone"),
      wipeOldSeed: async () => void log.push("wipeOldSeed"),
      forgetEmailLogin: async () => void log.push("forgetEmailLogin"),
      queuePasskeyRecord: () => void log.push("queuePasskeyRecord"),
    }),
    endEmailSession: async () => void log.push("endEmailSession"),
    feedKeyIfPresent: async () => NEW_FEED,
    resumeLater: () => {
      log.push("resumeLater");
      void runResume(host, io);
    },
  };
  const socialWrite = f.deps.social.write;
  f.deps.social.write = async (signer, kind, subject, value) => {
    log.push(`social:${value}`);
    return socialWrite(signer, kind, subject, value);
  };
  const io = {
    marker: f.marker,
    prepareDeps: async () => f.deps,
    social: async () => f.deps.social,
    requestIntent: async () => {
      log.push("requestIntent");
      over.intent?.();
    },
  };
  return { host, io, log, f, state, adopted: () => adopted };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("run: prepare, retract, the one switch, then adopt -> finalize -> the email session ends LAST", async () => {
  const s = store({ landed: () => false });
  await runUpgrade(s.host, s.io);
  const commit = s.log.slice(s.log.indexOf("adoptPasskey"));
  assert.deepEqual(commit.slice(0, 7), [
    "adoptPasskey", "tombstone", "forgetEmailLogin", "queuePasskeyRecord", "wipeOldSeed", "endEmailSession", "resumeLater",
  ]);
  assert.deepEqual(s.log.filter((x) => x.startsWith("switch:")), [`switch:${PASSKEY}`]);
  assert.ok(s.log.indexOf(`switch:${PASSKEY}`) > s.log.indexOf("ensureSession"), "the session first");
  const { live, confirmed } = s.adopted()!;
  assert.equal((live as { seed: string }).seed, NEW_SEED, "this tab's passkey unlocks the account at once");
  assert.equal(confirmed, true);
  // The old feed was retracted before the switch; the new one is re-posted after it.
  const retracts = s.f.writes.filter((w) => w.signer === OLD_FEED.address);
  assert.ok(retracts.length === 3 && retracts.every((w) => w.value === false));
  await settle();
  await settle();
  const reposts = s.f.writes.filter((w) => w.signer === NEW_FEED.address);
  assert.ok(reposts.length === 3 && reposts.every((w) => w.value === true), "moved once a session exists");
  assert.equal(s.f.marker.map.size, 0, "done: the marker goes");
});

test("run: the intent comes before the retraction and the op, afresh at every attempt that sends", async () => {
  let refuse = true;
  const s = store({ landed: () => false, switchFails: () => refuse });
  await assert.rejects(runUpgrade(s.host, s.io));
  refuse = false;
  await runUpgrade(s.host, s.io);
  const at = (x: string, from = 0) => s.log.indexOf(x, from);
  const first = at("requestIntent");
  const second = at("requestIntent", first + 1);
  assert.ok(first >= 0 && second > first, "a fresh intent per attempt");
  assert.ok(first < at("social:false") && at("social:false") < at(`switch:${PASSKEY}`), "intent, retraction, op - in that order");
  assert.ok(second > at(`switch:${PASSKEY}`) && second < at(`switch:${PASSKEY}`, at(`switch:${PASSKEY}`) + 1), "the retry asks before its own op");
});

test("run: an intent refused (the per-network limit) sends nothing, retracts nothing, and says why", async () => {
  const s = store({ landed: () => false, intent: () => { throw new Error("Too many upgrades from this network today - try again tomorrow."); } });
  await assert.rejects(runUpgrade(s.host, s.io), { message: "Too many upgrades from this network today - try again tomorrow." });
  assert.ok(!s.log.some((x) => x.startsWith("switch:")));
  assert.ok(!s.log.includes("social:false"), "the likes are where they were");
  assert.equal(s.f.countedTwice(), false);
  assert.equal(s.f.marker.map.get(PARENT)?.retracted, false, "kept: a later attempt picks it up");
});

test("run: an attempt whose op already landed asks for no intent and sends nothing", async () => {
  const s = store({ landed: () => true });
  s.f.oldRetracted();
  s.f.marker.write(prepared());
  await runUpgrade(s.host, s.io);
  assert.ok(!s.log.includes("requestIntent") && !s.log.some((x) => x.startsWith("switch:")));
  assert.ok(s.log.includes("adoptPasskey"), "it commits");
});

test("run: no session - nothing is read, made or sent", async () => {
  const s = store({ session: false });
  await assert.rejects(runUpgrade(s.host, s.io), { message: NO_SESSION_MESSAGE });
  assert.ok(!s.f.names().includes("mintPasskey"));
  assert.ok(!s.log.some((x) => x.startsWith("switch:")));
});

test("run: a refused switch keeps the prepared state; the retry reuses the SAME passkey", async () => {
  let refuse = true;
  const s = store({ landed: () => false, switchFails: () => refuse });
  await assert.rejects(runUpgrade(s.host, s.io), { message: SWITCH_FAILED_MESSAGE });
  assert.equal(s.f.marker.map.get(PARENT)?.stage, "prepared");
  assert.ok(!s.log.includes("adoptPasskey") && !s.log.includes("wipeOldSeed"), "nothing committed, the old seed kept");
  refuse = false;
  await runUpgrade(s.host, s.io);
  assert.equal(s.f.names().filter((n) => n === "mintPasskey").length, 1, "one passkey, not two");
  assert.equal((s.adopted()!.live as { passkey: string }).passkey, PASSKEY);
});

test("run: only an email account can upgrade", async () => {
  const s = store({ kind: "passkey" });
  await assert.rejects(runUpgrade(s.host, s.io));
  assert.equal(s.log.length, 0);
});

test("commit: the email session ends after the identity is the passkey's and the old seed is gone", async () => {
  const s = store();
  await commitUpgrade(s.host, s.io, prepared(), null, false);
  assert.deepEqual(s.log, ["adoptPasskey", "tombstone", "forgetEmailLogin", "queuePasskeyRecord", "wipeOldSeed", "endEmailSession"]);
});

test("cancel: refused once the switch has landed; otherwise likes back under the old feed", async () => {
  const landedNow = store({ landed: () => true });
  landedNow.f.marker.write(prepared());
  await assert.rejects(runCancel(landedNow.host, landedNow.io), { message: ALREADY_LANDED_MESSAGE });
  assert.equal(landedNow.f.writes.length, 0);

  const s = store({ landed: () => false });
  s.f.marker.write(prepared());
  await runCancel(s.host, s.io);
  assert.ok(s.f.writes.length === 3 && s.f.writes.every((w) => w.signer === OLD_FEED.address && w.value));
  assert.equal(s.f.marker.map.size, 0);
});

test("resume: finalizes a landed switch this device never committed; never moves without a session", async () => {
  const s = store({ kind: "passkey", session: false });
  s.f.oldRetracted();
  s.f.marker.write(prepared());
  await runResume(s.host, s.io);
  assert.ok(s.log.includes("wipeOldSeed"), "the email key's traces out");
  assert.equal(s.f.marker.map.get(PARENT)?.stage, "committed");
  assert.equal(s.f.writes.length, 0, "no session: the move waits");
  assert.ok(!s.log.includes("ensureSession"), "and a resume never mints one for itself");
  s.state.session = true;
  await runResume(s.host, s.io);
  assert.equal(s.f.writes.length, 3);
  assert.equal(s.f.marker.map.size, 0);
});

test("resume: a switch that has not landed changes nothing; another passkey's marker is left alone", async () => {
  const s = store({ kind: "passkey", landed: () => false });
  s.f.marker.write(prepared());
  await runResume(s.host, s.io);
  assert.equal(s.f.marker.map.get(PARENT)?.stage, "prepared");
  assert.equal(s.log.length, 0);
  const other = store({ kind: "passkey" });
  other.f.marker.write(prepared({ passkey: "0x4444444444444444444444444444444444444444" }));
  await runResume(other.host, other.io);
  assert.equal(other.f.marker.map.get(PARENT)?.stage, "prepared");
});

// ── Structure ────────────────────────────────────────────────────────────────

test("PQ4: the upgrade's code reaches no escrow, guardian or backup-setup path", () => {
  for (const file of ["upgrade-to-passkey.ts", "upgrade-to-passkey-live.ts", "upgrade-marker.ts"]) {
    const src = readFileSync(new URL(`../src/lib/auth/${file}`, import.meta.url), "utf8");
    for (const banned of ["recovery-escrow", "guardian-", "setupRecovery", "setupAccountRecovery", "storeIdentitySeed"]) {
      assert.ok(!src.includes(banned), `${file} mentions ${banned}`);
    }
  }
});
