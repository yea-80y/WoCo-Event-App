/**
 * First saves on a never-written feed (#943), run for real.
 *
 * Bee 2.8 stops retrieving a chunk it has missed a few times, for a minute: our
 * gateway answers 500 and the server 503. A new organiser's notice (and a new
 * profile) has never been written, and their own screens have already asked
 * about its first version - so the write-time version probe came back
 * inconclusive and the first save refused, and so did trying again.
 *
 * The fix, proven here against the faked network (fake-swarm-net.ts) with the
 * REAL readers, signer and verified writer:
 * - a save whose base read was thorough and CLEAN writes at the version that read
 *   proved next, asking the network nothing more first;
 * - a read that could not say never supplies a version, and nothing is written;
 * - another device taking that version is caught (`superseded`) and answered by
 *   reading again;
 * - an inconclusive save is tried once more after the skip list has expired.
 *
 * MUTATION (each run and restored, 2026-10-20): let `nextVersionAfter` take a
 * found version under a dirty scan and "a found under a dirty scan never names
 * the version" goes red; let it read an unanswered read as absent and the four
 * skip-list tests go red; drop the second attempt from `retryOnceIfInconclusive`
 * and the late-retry tests go red; return on `superseded` in `writeAtNextVersion`
 * and both superseded tests go red; drop the base's owner check and "a base read
 * under another signer" goes red; drop `knownVersion` (the write-time probe comes
 * back) and both "asking nothing first" tests go red.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculateSocAddress,
  contentFeedSocIdentifier,
  mergeProfileText,
  organiserNoticeContentTopic,
  profileAvatarContentTopic,
  profileDataContentTopic,
  versionedSocIdentifier,
  type UserProfile,
} from "@woco/shared";
import { nextVersionAfter } from "../src/lib/swarm/content-feed.js";
import { ETHERNA_GATEWAY_URL, FEED_ROUTES } from "../src/lib/swarm/gateways.js";
import {
  InconclusiveReadError,
  LATE_RETRY_MS,
  LateRetryCancelled,
  retryOnceIfInconclusive,
} from "../src/lib/swarm/late-retry.js";
import {
  noticeForPublish,
  readOwnNotice,
  readOwnNoticeWithLateRetry,
  writeOwnNotice,
} from "../src/lib/legal/organiser-notice.js";
import {
  PROFILE_BASE_RETRY,
  PROFILE_PHOTO_RETRY,
  writeProfileAvatar,
  writeProfileData,
} from "../src/lib/api/profile-save.js";
import {
  OTHER_KEY,
  OWNER,
  OWNER_PRIV,
  clearRequests,
  hex,
  install,
  requests,
  resetNet,
  restoreNet,
  soc,
  transport,
  unhex,
  type Net,
  type StoredSoc,
} from "./fake-swarm-net.js";

beforeEach(resetNet);
afterEach(restoreNet);

const ACCOUNT = `0x${"ab".repeat(20)}`;
const signer = { privKey: OWNER_PRIV, address: `0x${OWNER}` };
const NOTICE = organiserNoticeContentTopic(ACCOUNT);
const PROFILE = profileDataContentTopic(ACCOUNT);
const AVATAR = profileAvatarContentTopic(ACCOUNT);

const idAt = (topic: string, v: number) => versionedSocIdentifier(contentFeedSocIdentifier(topic), v);
const addressAt = (topic: string, v: number, owner = OWNER) => hex(calculateSocAddress(idAt(topic, v), unhex(owner)));
const put = (store: Map<string, StoredSoc>, chunk: StoredSoc) => void store.set(chunk.address, chunk);
const payloadAt = (net: Net, topic: string, v: number, owner = OWNER) => {
  const a = addressAt(topic, v, owner);
  const chunk = net.ourBee.get(a) ?? net.etherna.get(a);
  return chunk ? JSON.parse(new TextDecoder().decode(chunk.payload)) : undefined;
};
/** Requests (gateway or server) that asked about this chunk. */
const asked = (id: Uint8Array, owner = OWNER) => {
  const address = hex(calculateSocAddress(id, unhex(owner)));
  const idHex = hex(id);
  return requests.filter((u) => u.includes(address) || u.includes(idHex)).length;
};

const draft = { organiserName: "Example Events Ltd", contactEmail: "privacy@example.com", sharing: ["venue" as const], orderRetentionMonths: 6 as const };
const notice = () => noticeForPublish(ACCOUNT, draft);
const otherDevicesNotice = () => noticeForPublish(ACCOUNT, { ...draft, organiserName: "Example Events" });

/** A transport that records how many requests had been made when the chunk left. */
function countingTransport(net: Net) {
  const t = transport(net);
  const before: number[] = [];
  return {
    log: t.log,
    before,
    send: async (body: Parameters<typeof t.transport>[0]) => {
      before.push(requests.length);
      return t.transport(body);
    },
  };
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("only a definitive verdict names the next version", () => {
  assert.equal(nextVersionAfter({ status: "absent" }), 0);
  assert.equal(nextVersionAfter({ status: "found", value: {}, version: 3, scanClean: true }), 4);
  assert.equal(nextVersionAfter({ status: "found", value: {}, version: -1, scanClean: true }), 0, "the pre-versioning chunk, as the probing writer does");
  assert.equal(nextVersionAfter({ status: "found", value: {}, version: 3, scanClean: false }), null, "a dirty scan may have stopped below the head");
  assert.equal(nextVersionAfter({ status: "unavailable", reason: "x" }), null);
  assert.equal(nextVersionAfter({ status: "unavailable", reason: "x", unusableAt: 2 }), 3, "a spent version is written past");
  assert.equal(LATE_RETRY_MS > 60_000, true, "past bee's one-minute skip list");
});

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

test("a first notice save writes version 0 from the editor's clean read, asking the network nothing first", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const own = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(own.status, "absent");
  assert.equal(own.status === "absent" && own.base.nextVersion, 0);

  clearRequests();
  const { send, log, before } = countingTransport(net);
  const n = notice();
  const out = await writeOwnNotice(ACCOUNT, signer, n, { base: own.status === "absent" ? own.base : null, transport: send });

  assert.deepEqual(before, [0], "no read before the write - the probe that failed every first save is gone");
  assert.deepEqual(log.map((s) => s.address), [addressAt(NOTICE, 0)]);
  assert.equal(log[0].gatewayUrl, ETHERNA_GATEWAY_URL);
  assert.equal(asked(idAt(NOTICE, 1)), 0, "version 1 is never asked about");
  assert.deepEqual(payloadAt(net, NOTICE, 0), n);
  assert.equal(out.base?.nextVersion, 1, "a confirmed write is the next publish's base");

  const again = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(again.status, "found");
});

test("a skip-listed first version: the read is inconclusive, and the save writes nothing", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map(), beeSkipList: new Set([addressAt(NOTICE, 0)]) };
  install(net);
  const own = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(own.status, "unavailable");
  assert.equal(own.status === "unavailable" && own.inconclusive, true);

  const { send, log } = countingTransport(net);
  await assert.rejects(
    writeOwnNotice(ACCOUNT, signer, notice(), { transport: send }),
    (e: unknown) => e instanceof InconclusiveReadError && /nothing was published/.test(e.message),
  );
  assert.equal(log.length, 0);
});

test("a found under a dirty scan never names the version - the save reads again and refuses", async () => {
  // Version 1 was published from another device and Etherna cannot answer for it
  // right now. A write at 1 would land on a taken address and keep THEIR bytes -
  // and the read-back could not see that either, so it would report success.
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.etherna, soc(idAt(NOTICE, 0), otherDevicesNotice()));
  put(net.etherna, soc(idAt(NOTICE, 1), otherDevicesNotice()));
  const v1 = addressAt(NOTICE, 1);
  net.ethernaDown = (_n, address) => address === v1;
  install(net);

  const own = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(own.status, "found", "the editor still fills its form");
  assert.equal(own.status === "found" && own.base.nextVersion, null);

  const { send, log } = countingTransport(net);
  await assert.rejects(
    writeOwnNotice(ACCOUNT, signer, notice(), { base: own.status === "found" ? own.base : null, transport: send }),
    (e: unknown) => e instanceof InconclusiveReadError,
  );
  assert.equal(log.length, 0);
});

test("superseded: another device published after the editor loaded - the save reads again and lands one past it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const own = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(own.status, "absent");
  const theirs = otherDevicesNotice();
  put(net.etherna, soc(idAt(NOTICE, 0), theirs));

  const { send, log } = countingTransport(net);
  const n = notice();
  const out = await writeOwnNotice(ACCOUNT, signer, n, { base: own.status === "absent" ? own.base : null, transport: send });

  assert.deepEqual(log.map((s) => s.address), [addressAt(NOTICE, 0), addressAt(NOTICE, 1)]);
  assert.deepEqual(payloadAt(net, NOTICE, 0), theirs, "their version is untouched");
  assert.equal(payloadAt(net, NOTICE, 1).organiserName, n.organiserName, "ours is the newest");
  assert.equal(out.base?.nextVersion, 2);
});

test("a base read under another signer is never used - the write reads its own feed", async () => {
  // A key-ring rotation can change the signer under an open editor. The old
  // signer's next version on the new signer's feed would leave a gap no reader
  // walks across: the publish would verify and still be invisible.
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  for (const v of [0, 1, 2]) put(net.etherna, soc(idAt(NOTICE, v), otherDevicesNotice()));
  install(net);
  const own = await readOwnNotice(ACCOUNT, signer.address);
  assert.equal(own.status === "found" && own.base.nextVersion, 3);

  const other = OTHER_KEY.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
  const rotated = { privKey: `0x${"22".repeat(32)}`, address: `0x${other}` };
  const { send, log } = countingTransport(net);
  await writeOwnNotice(ACCOUNT, rotated, notice(), { base: own.status === "found" ? own.base : null, transport: send });
  assert.deepEqual(log.map((s) => s.address), [addressAt(NOTICE, 0, other)]);
});

// ---------------------------------------------------------------------------
// The late retry
// ---------------------------------------------------------------------------

const flush = () => new Promise<void>((r) => setImmediate(r));

test("the late retry runs once, only after the delay, and then surfaces the error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0;
  const waits: number[] = [];
  const p = retryOnceIfInconclusive(async () => {
    runs++;
    throw new InconclusiveReadError("could not say");
  }, { onWait: (ms) => waits.push(ms) });
  const settled = p.catch((e: unknown) => e);

  await flush();
  assert.equal(runs, 1);
  assert.deepEqual(waits, [LATE_RETRY_MS]);
  t.mock.timers.tick(LATE_RETRY_MS - 1);
  await flush();
  assert.equal(runs, 1, "not inside the minute");
  t.mock.timers.tick(1);
  const e = await settled;
  assert.equal(runs, 2);
  assert.ok(e instanceof InconclusiveReadError && e.message === "could not say", "the second answer, as it is");
  assert.deepEqual(waits, [LATE_RETRY_MS], "one wait, never two");
});

test("a verdict is not retried; a retry that works returns its answer", async () => {
  let runs = 0;
  await assert.rejects(
    retryOnceIfInconclusive(async () => { runs++; throw new Error("refused"); }, { delayMs: 0 }),
    /refused/,
  );
  assert.equal(runs, 1);

  runs = 0;
  const value = await retryOnceIfInconclusive(async () => {
    if (runs++ === 0) throw new InconclusiveReadError("not yet");
    return "saved";
  }, { delayMs: 0 });
  assert.equal(value, "saved");
  assert.equal(runs, 2);
});

test("leaving the page during the wait cancels the retry: it never runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const life = new AbortController();
  let runs = 0;
  const settled = retryOnceIfInconclusive(async () => {
    runs++;
    throw new InconclusiveReadError("not yet");
  }, { signal: life.signal }).catch((e: unknown) => e);
  await flush();
  life.abort();
  assert.ok((await settled) instanceof LateRetryCancelled);
  t.mock.timers.tick(LATE_RETRY_MS);
  await flush();
  assert.equal(runs, 1);

  // Already gone: no wait at all.
  const gone = new AbortController();
  gone.abort();
  let waited = false;
  await assert.rejects(
    retryOnceIfInconclusive(async () => { throw new InconclusiveReadError("x"); }, { signal: gone.signal, onWait: () => { waited = true; } }),
    (e: unknown) => e instanceof LateRetryCancelled,
  );
  assert.equal(waited, false);
});

test("a first notice save that meets the skip list waits once, then lands at version 0", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map(), beeSkipList: new Set([addressAt(NOTICE, 0), addressAt(NOTICE, 1)]) };
  install(net);
  const { send, log } = countingTransport(net);
  let waits = 0;
  const n = notice();
  await retryOnceIfInconclusive(() => writeOwnNotice(ACCOUNT, signer, n, { transport: send }), {
    delayMs: 0,
    onWait: () => { waits++; net.beeSkipList!.clear(); }, // the minute passes
  });
  assert.equal(waits, 1);
  assert.deepEqual(log.map((s) => s.address), [addressAt(NOTICE, 0)]);
  assert.deepEqual(payloadAt(net, NOTICE, 0), n);
});

test("the editor's load waits once too, and still inconclusive shows the existing error", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map(), beeSkipList: new Set([addressAt(NOTICE, 0)]) };
  install(net);
  let waits = 0;
  const recovered = await readOwnNoticeWithLateRetry(ACCOUNT, signer.address, {
    delayMs: 0,
    onWait: () => { waits++; net.beeSkipList!.clear(); },
  });
  assert.equal(waits, 1);
  assert.equal(recovered.status, "absent");
  assert.equal(recovered.status === "absent" && recovered.base.nextVersion, 0);

  net.beeSkipList = new Set([addressAt(NOTICE, 0)]);
  resetNet();
  install(net);
  waits = 0;
  const still = await readOwnNoticeWithLateRetry(ACCOUNT, signer.address, { delayMs: 0, onWait: () => { waits++; } });
  assert.equal(waits, 1);
  assert.deepEqual(still, { status: "unavailable", error: "Couldn't load your saved notice - check your connection and try again.", inconclusive: true });
});

// ---------------------------------------------------------------------------
// The profile and its photo
// ---------------------------------------------------------------------------

const buildFrom = (updates: Parameters<typeof mergeProfileText>[0]) => (existing: UserProfile | null): UserProfile => ({
  v: 1,
  address: ACCOUNT as UserProfile["address"],
  ...mergeProfileText(updates, existing),
  updatedAt: "2026-10-20T12:00:00.000Z",
});

test("a first profile save writes version 0 from its one base read - no second probe before the write", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const counts: Array<[number, number]> = [];
  const t = transport(net);
  const send = async (body: Parameters<typeof t.transport>[0]) => {
    counts.push([asked(idAt(PROFILE, 0)), asked(idAt(PROFILE, 1))]);
    return t.transport(body);
  };
  const saved = await writeProfileData({ signer, topic: PROFILE, route: FEED_ROUTES.profile, build: buildFrom({ displayName: "Sam" }), transport: send });

  // Our gateway, then the server, once each - the base read. The write-time
  // probe asked both again, and that second ask is what met the skip list.
  assert.deepEqual(counts, [[2, 2]]);
  assert.deepEqual(t.log.map((s) => s.address), [addressAt(PROFILE, 0)]);
  assert.equal(t.log[0].gatewayUrl, ETHERNA_GATEWAY_URL);
  assert.deepEqual(payloadAt(net, PROFILE, 0), saved);
  assert.equal(saved.displayName, "Sam");
});

test("a profile save whose base read is inconclusive writes nothing, and says so", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map(), beeSkipList: new Set([addressAt(PROFILE, 0)]) };
  install(net);
  const t = transport(net);
  await assert.rejects(
    writeProfileData({ signer, topic: PROFILE, route: FEED_ROUTES.profile, build: buildFrom({ displayName: "Sam" }), transport: t.transport }),
    (e: unknown) => e instanceof InconclusiveReadError && e.message === PROFILE_BASE_RETRY,
  );
  assert.equal(t.log.length, 0);
});

test("superseded profile save: re-read and MERGE onto the other device's save, never revert it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const t = transport(net);
  let builds = 0;
  const build = buildFrom({ displayName: "Sam" });
  const saved = await writeProfileData({
    signer,
    topic: PROFILE,
    route: FEED_ROUTES.profile,
    build: (existing) => {
      // Between our base read and our write, another device saves a bio.
      if (builds++ === 0) put(net.etherna, soc(idAt(PROFILE, 0), { v: 1, address: ACCOUNT, bio: "theirs", updatedAt: "x" }));
      return build(existing);
    },
    transport: t.transport,
  });
  assert.equal(builds, 2);
  assert.deepEqual(t.log.map((s) => s.address), [addressAt(PROFILE, 0), addressAt(PROFILE, 1)]);
  assert.equal(payloadAt(net, PROFILE, 0).bio, "theirs");
  assert.equal(saved.displayName, "Sam");
  assert.equal(saved.bio, "theirs", "their field carried forward");
  assert.deepEqual(payloadAt(net, PROFILE, 1), saved);
});

test("a first photo save writes version 0 without asking for the pre-versioning chunk; inconclusive writes nothing", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const t = transport(net);
  await writeProfileAvatar({ signer, topic: AVATAR, route: FEED_ROUTES.profile, avatarRef: "aa".repeat(32), transport: t.transport });
  assert.deepEqual(t.log.map((s) => s.address), [addressAt(AVATAR, 0)]);
  assert.deepEqual(payloadAt(net, AVATAR, 0), { v: 1, avatarRef: "aa".repeat(32) });
  assert.equal(asked(contentFeedSocIdentifier(AVATAR)), 0);

  const skip: Net = { ourBee: new Map(), etherna: new Map(), beeSkipList: new Set([addressAt(AVATAR, 0)]) };
  resetNet();
  install(skip);
  const t2 = transport(skip);
  await assert.rejects(
    writeProfileAvatar({ signer, topic: AVATAR, route: FEED_ROUTES.profile, avatarRef: "bb".repeat(32), transport: t2.transport }),
    (e: unknown) => e instanceof InconclusiveReadError && e.message === PROFILE_PHOTO_RETRY,
  );
  assert.equal(t2.log.length, 0);

  let waits = 0;
  await retryOnceIfInconclusive(
    () => writeProfileAvatar({ signer, topic: AVATAR, route: FEED_ROUTES.profile, avatarRef: "bb".repeat(32), transport: t2.transport }),
    { delayMs: 0, onWait: () => { waits++; skip.beeSkipList!.clear(); } },
  );
  assert.equal(waits, 1);
  assert.deepEqual(t2.log.map((s) => s.address), [addressAt(AVATAR, 0)]);
});

// ---------------------------------------------------------------------------
// The wiring the behaviour depends on
// ---------------------------------------------------------------------------

const SRC = new URL("../src/", import.meta.url).pathname;
/** Comments stripped: these files name the old call in order to warn about it. */
const code = (p: string) =>
  readFileSync(SRC + p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `not found: ${from} .. ${to}`);
  return s.slice(a, b);
};

test("the write base is thorough by construction, and the writer targets it exactly", () => {
  const feed = code("lib/swarm/content-feed.ts");
  const baseRead = between(feed, "export async function readContentFeedWriteBase", "export async function readContentFeedAtVersion");
  assert.match(baseRead, /thorough: true/);
  assert.doesNotMatch(baseRead, /thorough: opts/, "no way to turn it off");
  const writer = between(code("lib/swarm/verified-write.ts"), "export async function writeAtNextVersion", "\n}\n");
  assert.match(writer, /knownVersion: base\.nextVersion/);
  assert.match(writer, /args\.base && names\(args\.base\)/);
  assert.match(writer, /if \(base\.nextVersion === null\) throw new InconclusiveReadError/);
});

test("the notice, profile and photo saves no longer probe at write time", () => {
  for (const f of ["lib/legal/organiser-notice.ts", "lib/api/profiles.ts", "lib/api/profile-save.ts"]) {
    assert.doesNotMatch(code(f), /writeContentFeed\(/, f);
  }
  const notice = code("lib/legal/organiser-notice.ts");
  assert.match(between(notice, "export async function readOwnNotice(", "export async function readOwnNoticeWithLateRetry"), /readContentFeedWriteBase<unknown>\(signerAddress, organiserNoticeContentTopic\(account\)/);
  assert.match(between(notice, "export async function publishOwnNotice(", "export function stripEmpty"), /writeOwnNotice\(account, signer, notice, \{ base: opts\.base \}\)/);

  const profiles = code("lib/api/profiles.ts");
  const update = between(profiles, "export async function updateProfile(", "export async function uploadAvatar(");
  assert.match(update, /writeProfileData\(\{[\s\S]*route: FEED_ROUTES\.profile/);
  assert.match(update, /\.\.\.mergeProfileText\(updates, existing\)/);
  assert.match(update, /opts\.lateRetry \? await retryOnceIfInconclusive\(save, opts\.lateRetry\) : await save\(\)/);
  const avatar = profiles.slice(profiles.indexOf("export async function uploadAvatar("));
  assert.match(avatar, /writeProfileAvatar\(\{ signer, topic: profileAvatarContentTopic\(parent\), route: FEED_ROUTES\.profile, avatarRef \}\)/);
  assert.ok(avatar.indexOf('"/api/profile/avatar"') < avatar.indexOf("retryOnceIfInconclusive(point"), "the image is uploaded once, before the retried feed write");
});

test("the editor hands its base to the publish, waits once with a visible state, and cancels with the screen", () => {
  const ed = code("lib/creator/privacy/PrivacyNoticeEditor.svelte");
  assert.match(ed, /onDestroy\(\(\) => lifetime\?\.abort\(\)\)/);
  const load = between(ed, "async function load()", "async function publish()");
  assert.match(load, /lifetime\?\.abort\(\);/);
  assert.match(load, /readOwnNoticeWithLateRetry\(parent, signerAddress, \{\s*signal: life\.signal,/);
  assert.match(load, /writeBase = own\.base;/);
  const publish = between(ed, "async function publish()", "const ABOUT");
  assert.match(publish, /const confirmed = payload\(\);/);
  assert.match(publish, /retryOnceIfInconclusive\(async \(\) => \{[\s\S]*auth\.parent\?\.toLowerCase\(\) !== parent[\s\S]*publishOwnNotice\(parent, signer, confirmed, \{ base: first \}\)[\s\S]*signal: life\?\.signal/);
  assert.match(publish, /if \(e instanceof LateRetryCancelled\) return;/);
  assert.match(ed, /\{#if waiting === "publish"\}/);
  assert.match(ed, /<fieldset disabled=\{waiting === "publish"\}>/);
});

test("the profile page retries the feed writes late, shows it, and cancels with the page or account", () => {
  const page = code("lib/components/profile/ProfilePage.svelte");
  const save = between(page, "async function saveProfile()", "async function guardRename()");
  assert.match(save, /const lateRetry: LateRetry = \{ signal: life\.signal, onWait: \(\) => \{ saveWaiting = true; \} \};/);
  assert.match(save, /updateProfile\(changes, undefined, \{ lateRetry \}\)/);
  assert.match(save, /uploadAvatar\(pendingAvatarDataUrl, \{ lateRetry \}\)/);
  assert.match(save, /if \(err instanceof LateRetryCancelled\) return;/);
  assert.match(between(page, "let _prevView", "loadProfile();"), /saveLifetime\?\.abort\(\);/);
  assert.match(between(page, "onDestroy(() => {", "});"), /saveLifetime\?\.abort\(\);/);
  // The template from the raw source: `accept="image/*"` reads as a comment opener to `code`.
  assert.match(readFileSync(SRC + "lib/components/profile/ProfilePage.svelte", "utf8"), /\{#if saveWaiting\}[\s\S]*Still saving/);
});
