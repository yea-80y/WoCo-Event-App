/**
 * The Etherna failover (#912): the relay ledger, the read rule it makes exact,
 * the relay's detour to the WoCo batch, and the sweep that moves chunks back.
 *
 * Bee and Etherna are a stubbed `fetch`; the ledger file lives in a temp cwd.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@ethersphere/bee-js";
import { calculateCacAddress, calculateSocAddress, encodeSpan } from "@woco/shared";

const BEE = "http://bee.test";
const ETH = "http://etherna.test";
const T0 = Date.parse("2026-10-16T00:00:00Z");
const PARENT = "0x" + "aa".repeat(20);
const WOCO_BATCH = "ab".repeat(32);
const ETH_BATCH = "cd".repeat(32);

process.env.BEE_URL = BEE;
process.env.ETHERNA_GATEWAY_URL = ETH;
process.env.ETHERNA_TOKEN_ENDPOINT = `${ETH}/token`;
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.POSTAGE_BATCH_ID = WOCO_BATCH;
const PROXY = "http://proxy.test";
process.env.PROXY_URL = PROXY;
process.env.UPLOAD_SECRET = "s";
delete process.env.ETHERNA_FAILOVER;

type Call = { url: string; method: string; batch?: string };
const calls: Call[] = [];
let ethernaSocStatus: () => number = () => 201;
let beeSocStatus = 201;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const batch = (init?.headers as Record<string, string> | undefined)?.["Swarm-Postage-Batch-Id"];
  calls.push({ url, method, ...(batch ? { batch } : {}) });
  if (url === `${ETH}/token`) {
    return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  }
  if (url === `${PROXY}/admin/whitelist`) return new Response("{}", { status: 200 });
  if (url.startsWith(`${ETH}/soc/`)) return new Response("etherna says no", { status: ethernaSocStatus() });
  if (url.startsWith(`${ETH}/api/v0.3/resources/`)) return new Response(null, { status: 200 });
  if (url.startsWith(`${BEE}/soc/`)) return new Response("bee says no", { status: beeSocStatus });
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

let ledger: typeof import("../src/lib/etherna/relay-ledger.js");
let failover: typeof import("../src/lib/etherna/failover.js");
let breaker: typeof import("../src/lib/etherna/breaker.js");
let socRead: typeof import("../src/lib/swarm/soc-read.js");
let socUpload: typeof import("../src/lib/swarm/soc-upload.js");
let dir: string;
let originalCwd: string;
let now = T0;

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-etherna-failover-"));
  process.chdir(dir);
  ledger = await import("../src/lib/etherna/relay-ledger.js");
  failover = await import("../src/lib/etherna/failover.js");
  breaker = await import("../src/lib/etherna/breaker.js");
  socRead = await import("../src/lib/swarm/soc-read.js");
  socUpload = await import("../src/lib/swarm/soc-upload.js");
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = realFetch;
});

const LEDGER = () => join(dir, ".data", "etherna-relay-ledger");
const STATE = () => join(LEDGER(), "_state.json");

/** A fresh, empty ledger in its own directory, on our clock, warm unless told otherwise. */
function freshLedger(opts: { warm?: boolean; maxEntries?: number } = {}): void {
  dir = mkdtempSync(join(tmpdir(), "woco-etherna-failover-"));
  process.chdir(dir);
  ledger.__resetRelayLedgerForTest({ now: () => now, ...(opts.maxEntries ? { maxEntries: opts.maxEntries } : {}) });
  ledger.loadRelayLedger();
  if (opts.warm !== false) now += ledger.WARMUP_MS;
}

/** Reload what is on disk in the current directory, as a restart would. */
function restart(): void {
  ledger.__resetRelayLedgerForTest({ now: () => now });
  ledger.loadRelayLedger();
}

beforeEach(() => {
  now = T0;
  calls.length = 0;
  ethernaSocStatus = () => 201;
  beeSocStatus = 201;
  delete process.env.ETHERNA_FAILOVER;
  breaker.__resetEthernaBreaker();
  failover.__resetFailoverStatsForTest();
  freshLedger();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

/** A SOC signed exactly as `content-feed-write.ts` signs one, plus its stored form. */
function signedSoc(seed: number, text = '{"hello":"world"}') {
  const signer = new PrivateKey("0x" + seed.toString(16).padStart(2, "0").repeat(32));
  const payload = new TextEncoder().encode(text);
  const span = encodeSpan(payload.length);
  const identifier = new Uint8Array(32).fill(seed);
  const sig = (signer.sign(new Uint8Array([...identifier, ...calculateCacAddress(span, payload)])) as unknown as {
    toUint8Array(): Uint8Array;
  }).toUint8Array();
  const owner = signer.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
  const address = hex(calculateSocAddress(identifier, unhex(owner)));
  const raw = new Uint8Array([...identifier, ...sig, ...span, ...payload]);
  return {
    input: { owner, identifier: hex(identifier), signature: hex(sig), span: hex(span), payload: hex(payload) },
    owner,
    identifier: hex(identifier),
    address,
    raw,
    sigHex: hex(sig),
    body: new Uint8Array([...span, ...payload]),
  };
}

const ETHERNA_DEST = { target: "etherna" as const, batchId: ETH_BATCH };
const posts = (base: string) => calls.filter((c) => c.method === "POST" && c.url.startsWith(`${base}/soc/`));

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("ledger: a new ledger records its start at load and is not trusted until warm", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  now = T0;
  freshLedger({ warm: false });
  const state = JSON.parse(readFileSync(STATE(), "utf-8"));
  assert.equal(state.v, 1);
  assert.equal(state.since, new Date(T0).toISOString());
  const a = signedSoc(1).address;
  assert.equal(ledger.relayLedgerClearsAbsent(a), false, "cold: not trusted");
  now += ledger.WARMUP_MS - 1;
  assert.equal(ledger.relayLedgerClearsAbsent(a), false);
  now += 1;
  assert.equal(ledger.relayLedgerClearsAbsent(a), true, "warm and unlisted");
});

test("ledger: a restart keeps the warm-up, but a rail that was off starts it again", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  now = T0;
  freshLedger({ warm: false });
  now += ledger.WARMUP_MS;
  restart();
  assert.equal(ledger.relayLedgerState().warm, true, "same rail, same start");

  // The last process ran with the rail off: it recorded nothing.
  writeFileSync(STATE(), JSON.stringify({ v: 1, since: new Date(T0).toISOString(), mode: "off" }));
  restart();
  assert.equal(ledger.relayLedgerState().warm, false);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(1).address), false);
});

test("ledger: nothing is recorded with the rail off", () => {
  const s = signedSoc(1);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(ledger.getRelayEntry(s.address), undefined);
  assert.deepEqual(readdirSync(LEDGER()).filter((n) => n !== "_state.json"), []);
});

test("ledger: the rule is off with the rail off, whatever the mode string", () => {
  delete process.env.ETHERNA_FAILOVER;
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(1).address), false);
  process.env.ETHERNA_FAILOVER = "off";
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(1).address), false);
  process.env.ETHERNA_FAILOVER = "sometimes";
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(1).address), false);
  assert.match(ledger.failoverMode().configError ?? "", /not off\|auto\|force/);
  assert.equal(failover.ethernaFailoverHealth().ok, false, "a mode it does not know is red");
});

test("ledger: a listed address is never cleared, pending or failover", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const p = signedSoc(1);
  const f = signedSoc(2);
  ledger.noteEthernaSend(p.address, p.owner, p.identifier);
  ledger.noteFailover(f.address, f.owner, f.identifier, PARENT);
  assert.equal(ledger.relayLedgerClearsAbsent(p.address), false);
  assert.equal(ledger.relayLedgerClearsAbsent(f.address), false);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(3).address), true);
  ledger.resolveEntries([p.address, f.address].map((address) => ({ address, updatedAt: ledger.getRelayEntry(address)!.updatedAt })));
  assert.equal(ledger.relayLedgerClearsAbsent(p.address), true);
  assert.equal(existsSync(join(LEDGER(), `${p.address}.json`)), false, "its file goes with it");
});

test("ledger: a send never downgrades a failover entry; a failover overwrites a pending one", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(1);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "pending");
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
  assert.equal(ledger.getRelayEntry(s.address)?.parent, PARENT);
  const before = ledger.getRelayEntry(s.address)?.updatedAt;
  now += 1;
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
  assert.equal(ledger.getRelayEntry(s.address)?.updatedAt, before, "a move back's own send must not make its entry look re-sent");
});

test("ledger: entries survive a restart, one file each", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  freshLedger(); // loaded with the rail on, as a real auto process is
  const s = signedSoc(1);
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  assert.ok(existsSync(join(LEDGER(), `${s.address}.json`)));
  restart();
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
  assert.equal(ledger.relayLedgerState().warm, true);
});

test("ledger: an unreadable entry or state file refuses the ledger, which is then never written", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const bad = '{"owner":"nope"}';
  const badFile = join(LEDGER(), `${"ee".repeat(32)}.json`);
  writeFileSync(badFile, bad);
  restart();
  const s = signedSoc(1);
  assert.equal(ledger.relayLedgerUsable(), false);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(ledger.noteFailover(s.address, s.owner, s.identifier, PARENT), false);
  assert.equal(readFileSync(badFile, "utf-8"), bad, "never overwritten");
  assert.equal(existsSync(join(LEDGER(), `${s.address}.json`)), false);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(9).address), false);
  assert.equal(failover.relayPlan(), "etherna", "an unusable ledger is the rail switched off");
  assert.equal(failover.ethernaFailoverHealth().ok, false);

  freshLedger();
  writeFileSync(STATE(), "");
  restart();
  assert.equal(ledger.relayLedgerUsable(), false, "an empty state file is unreadable, not new");
  assert.equal(readFileSync(STATE(), "utf-8"), "");
});

test("ledger: a write that does not reach disk restarts the warm-up and turns health red", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(9).address), true);
  const s = signedSoc(1);
  chmodSync(LEDGER(), 0o500);
  try {
    ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  } finally {
    chmodSync(LEDGER(), 0o700);
  }
  assert.ok(ledger.relayLedgerState().recordFailures >= 1);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(9).address), false, "not trusted until whole for a warm-up");
  assert.equal(ledger.relayLedgerClearsAbsent(s.address), false, "memory still lists it");
  assert.equal(failover.ethernaFailoverHealth().ok, false);
});

test("ledger: one entry that does not land is counted and red, even when the rest of the disk is fine", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(1);
  // A directory where its file should go: that one write fails, the state file still writes.
  mkdirSync(join(LEDGER(), `${s.address}.json`));
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(ledger.relayLedgerState().recordFailures, 1);
  assert.equal(JSON.parse(readFileSync(STATE(), "utf-8")).since, new Date(now).toISOString(), "warm-up restarted on disk too");
  assert.equal(failover.ethernaFailoverHealth().ok, false);
});

test("ledger: a write that did not land is retried, and health turns green once it has", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(2);
  chmodSync(LEDGER(), 0o500);
  try {
    ledger.noteEthernaSend(s.address, s.owner, s.identifier);
    assert.equal(ledger.relayLedgerState().dirty, true);
    ledger.retryUnsaved();
    assert.equal(ledger.relayLedgerState().dirty, true, "still cannot write");
  } finally {
    chmodSync(LEDGER(), 0o700);
  }
  const failedAt = now;
  assert.equal(failover.ethernaFailoverHealth().ok, false);
  ledger.retryUnsaved();
  assert.equal(ledger.relayLedgerState().dirty, false);
  assert.equal(failover.ethernaFailoverHealth().ok, true);
  restart();
  assert.equal(ledger.getRelayEntry(s.address)?.status, "pending");
  assert.equal(ledger.relayLedgerState().since, new Date(failedAt).toISOString(), "the restarted warm-up reached the disk");
});

test("ledger: an entry whose time does not parse refuses the ledger", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(3);
  writeFileSync(
    join(LEDGER(), `${s.address}.json`),
    JSON.stringify({ owner: s.owner, identifier: s.identifier, status: "pending", at: "soon", updatedAt: new Date(now).toISOString() }),
  );
  restart();
  assert.equal(ledger.relayLedgerUsable(), false, "at");
  freshLedger();
  writeFileSync(
    join(LEDGER(), `${s.address}.json`),
    JSON.stringify({ owner: s.owner, identifier: s.identifier, status: "pending", at: new Date(now).toISOString(), updatedAt: "soon" }),
  );
  restart();
  assert.equal(ledger.relayLedgerUsable(), false, "updatedAt");
});

test("ledger: a repeat send restarts the settle age without rewriting the file; a restart grants it too", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  freshLedger();
  const s = signedSoc(5);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  const first = readFileSync(join(LEDGER(), `${s.address}.json`), "utf-8");
  now += ledger.SETTLE_MIN_AGE_MS;
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal(readFileSync(join(LEDGER(), `${s.address}.json`), "utf-8"), first, "no write per attempt");
  assert.deepEqual(ledger.dueEntries("pending", 10), [], "but the age restarted");
  now += ledger.SETTLE_MIN_AGE_MS;
  restart();
  assert.deepEqual(ledger.dueEntries("pending", 10), [], "a send cut off by the restart may still be landing");
  now += ledger.SETTLE_MIN_AGE_MS;
  assert.equal(ledger.dueEntries("pending", 10).length, 1);
});

test("ledger: a full list lists nothing more, stops trusting itself, and switches the rail off", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  freshLedger({ maxEntries: 2 });
  const [a, b, c, d] = [signedSoc(1), signedSoc(2), signedSoc(3), signedSoc(4)];
  assert.equal(ledger.noteFailover(a.address, a.owner, a.identifier, PARENT), true);
  ledger.noteEthernaSend(b.address, b.owner, b.identifier);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(9).address), true);
  assert.equal(ledger.noteFailover(c.address, c.owner, c.identifier, PARENT), false);
  assert.equal(ledger.getRelayEntry(c.address), undefined);
  ledger.noteEthernaSend(d.address, d.owner, d.identifier);
  assert.equal(ledger.getRelayEntry(d.address), undefined);
  assert.equal(ledger.relayLedgerClearsAbsent(signedSoc(9).address), false, "an unlisted send: not whole");
  assert.equal(failover.relayPlan(), "etherna", "full is off");
  const h = failover.ethernaFailoverHealth();
  assert.equal(h.ok, false);
  assert.equal((h.ledger as { full: boolean; unlisted: number }).full, true);
  assert.equal((h.ledger as { unlisted: number }).unlisted, 2);
  // An address already listed still updates.
  ledger.noteFailover(b.address, b.owner, b.identifier, PARENT);
  assert.equal(ledger.getRelayEntry(b.address)?.status, "failover");
});

test("ledger: due entries are old enough, of the asked status only", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const p = signedSoc(1);
  const f = signedSoc(2);
  ledger.noteEthernaSend(p.address, p.owner, p.identifier);
  ledger.noteFailover(f.address, f.owner, f.identifier);
  assert.deepEqual(ledger.dueEntries("pending", 10), []);
  now += ledger.SETTLE_MIN_AGE_MS;
  assert.deepEqual(ledger.dueEntries("pending", 10).map((e) => e.address), [p.address]);
  assert.deepEqual(ledger.dueEntries("failover", 10).map((e) => e.address), [f.address]);
  // A fresh attempt at the same address starts its age again.
  ledger.noteEthernaSend(p.address, p.owner, p.identifier);
  assert.deepEqual(ledger.dueEntries("pending", 10), []);
});

// ---------------------------------------------------------------------------
// The read rule
// ---------------------------------------------------------------------------

const src = (name: string, read: import("../src/lib/swarm/soc-read.js").RawSocRead, listed = false) => ({
  name,
  negativeAuthority: "verdict" as const,
  ...(listed ? { listedInRelayLedger: true } : {}),
  read: async () => read,
});
const ABSENT = { status: "absent" as const };
const DOWN = { status: "unavailable" as const, reason: "HTTP 503" };

test("aggregate: a listed source that cannot be asked is excused only with the ledger's clearance", () => {
  const answers = [
    { source: src("bee", ABSENT), read: ABSENT },
    { source: src("etherna", DOWN, true), read: DOWN },
  ];
  assert.equal(socRead.aggregateSocReads(answers).status, "unavailable");
  assert.equal(socRead.aggregateSocReads(answers, { ledgerClears: false }).status, "unavailable");
  assert.equal(socRead.aggregateSocReads(answers, { ledgerClears: true }).status, "absent");
});

test("aggregate: clearance never excuses an unlisted source, and never stands alone", () => {
  const beeDown = [
    { source: src("bee", DOWN), read: DOWN },
    { source: src("etherna", DOWN, true), read: DOWN },
  ];
  assert.equal(socRead.aggregateSocReads(beeDown, { ledgerClears: true }).status, "unavailable");
  // One answered absent, but a second, unlisted source could not be asked: no verdict.
  const otherDown = [
    { source: src("bee", ABSENT), read: ABSENT },
    { source: src("operator", DOWN), read: DOWN },
    { source: src("etherna", DOWN, true), read: DOWN },
  ];
  assert.equal(socRead.aggregateSocReads(otherDown, { ledgerClears: true }).status, "unavailable");
  const ethernaOnly = [{ source: src("etherna", DOWN, true), read: DOWN }];
  const r = socRead.aggregateSocReads(ethernaOnly, { ledgerClears: true });
  assert.equal(r.status, "unavailable");
  if (r.status === "unavailable") assert.match(r.reason, /etherna: HTTP 503/);
});

test("the live Etherna source is the listed one; our bee is not", () => {
  assert.equal(socRead.ethernaSource.listedInRelayLedger, true);
  assert.notEqual(socRead.wocoBeeSource.listedInRelayLedger, true);
});

test("readVerifiedSoc: our bee's 404 decides while Etherna is down, unless the address is listed", async () => {
  const s = signedSoc(4);
  const sources = [src("bee", ABSENT), src("etherna", DOWN, true)];
  assert.equal((await socRead.readVerifiedSoc(s.owner, s.identifier, { sources })).status, "unavailable", "rail off");
  process.env.ETHERNA_FAILOVER = "auto";
  assert.equal((await socRead.readVerifiedSoc(s.owner, s.identifier, { sources })).status, "absent");
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  assert.equal((await socRead.readVerifiedSoc(s.owner, s.identifier, { sources })).status, "unavailable");
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

const RELAY = { failover: { parent: PARENT } };

test("relay, rail off: Etherna's refusal fails the save and nothing goes to WoCo or the ledger", async () => {
  const s = signedSoc(5);
  ethernaSocStatus = () => 400;
  await assert.rejects(socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY), (e: Error & { status?: number }) => e.status === 502);
  assert.equal(posts(BEE).length, 0);
  assert.equal(posts(ETH).length, 1);
  assert.equal(ledger.getRelayEntry(s.address), undefined, "the rail off records nothing");
});

test("relay, auto: Etherna failing twice stamps the same SOC on WoCo and lists it for the move back", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(6);
  ethernaSocStatus = () => 503;
  const ref = await socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY);
  assert.equal(ref.address, s.address);
  assert.equal(posts(ETH).length, failover.FAILOVER_ETHERNA_ATTEMPTS);
  const woco = posts(BEE);
  assert.equal(woco.length, 1);
  assert.equal(woco[0].batch, WOCO_BATCH);
  assert.ok(woco[0].url.startsWith(`${BEE}/soc/${s.owner}/${s.identifier}?sig=${s.sigHex}`), "the same signed chunk");
  const e = ledger.getRelayEntry(s.address);
  assert.equal(e?.status, "failover");
  assert.equal(e?.parent, PARENT);
  assert.equal((failover.ethernaFailoverHealth().sinceBoot as { failedOver: number }).failedOver, 1);
});

test("relay, auto: Etherna taking it is the normal path - no WoCo stamp, listed pending", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(7);
  await socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY);
  assert.equal(posts(ETH).length, 1);
  assert.equal(posts(ETH)[0].batch, ETH_BATCH);
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "pending");
});

test("relay, force: Etherna is not asked at all", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  const s = signedSoc(8);
  await socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY);
  assert.equal(posts(ETH).length, 0);
  assert.equal(posts(BEE).length, 1);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
});

test("relay, auto: a paused Etherna, or a batch the router refused, goes straight to WoCo", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  breaker.noteEthernaFailure("hung", performance.now() - 60_000);
  const a = signedSoc(10);
  await socUpload.uploadSignedSoc(a.input, ETHERNA_DEST, RELAY);
  assert.equal(posts(ETH).length, 0);
  assert.equal(ledger.getRelayEntry(a.address)?.status, "failover");

  breaker.__resetEthernaBreaker();
  calls.length = 0;
  const b = signedSoc(11);
  assert.equal(failover.relayPlan("batch not found on Etherna"), "woco");
  await socUpload.uploadSignedSoc(b.input, { target: "etherna", batchId: "" }, {
    failover: { parent: PARENT, ethernaRefused: "batch not found on Etherna" },
  });
  assert.equal(posts(ETH).length, 0);
  assert.equal(ledger.getRelayEntry(b.address)?.status, "failover");
});

test("relay, auto: the failover is listed before the WoCo stamp, so a failed stamp still leaves it listed", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(12);
  ethernaSocStatus = () => 400;
  beeSocStatus = 400;
  await assert.rejects(socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY));
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover", "written ahead; the sweep ends it if no store has it");
});

test("relay, force: works with Etherna not configured at all", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  process.env.ETHERNA_ENABLED = "false";
  try {
    const s = signedSoc(15);
    await socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY);
    assert.equal(posts(BEE).length, 1);
    assert.equal(calls.filter((c) => c.url.startsWith(ETH)).length, 0);
  } finally {
    process.env.ETHERNA_ENABLED = "true";
  }
});

test("a server write without the relay's option never detours, rail on or not", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(13);
  ethernaSocStatus = () => 400;
  await assert.rejects(socUpload.uploadSignedSoc(s.input, ETHERNA_DEST), (e: Error & { status?: number }) => e.status === 502);
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "pending", "listed as sent, never as failover");
});

test("a slow Etherna write failure pauses Etherna, so the next relay does not wait on it", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  breaker.__resetEthernaBreaker({ slowMs: 0 });
  ethernaSocStatus = () => 400;
  const s = signedSoc(14);
  await socUpload.uploadSignedSoc(s.input, ETHERNA_DEST, RELAY);
  assert.notEqual(breaker.ethernaPaused(), null);
  assert.equal(failover.relayPlan(), "woco");
  const read = await socRead.ethernaSource.read(signedSoc(16).address);
  assert.equal(read.status, "unavailable");
  if (read.status === "unavailable") assert.match(read.reason, /paused/, "reads are paused by a write's slow failure too");
});

test("the relay route asks for the failover, and detours a refused batch only when the plan says so", () => {
  const route = readFileSync(fileURLToPath(new URL("../src/routes/swarm.ts", import.meta.url)), "utf-8");
  assert.match(route, /instanceof PlatformBatchUnavailable\) \|\| relayPlan\(err\.reason\) !== "woco"\) throw err;/);
  assert.match(route, /\{ failover: \{ parent: parentAddress, \.\.\.\(ethernaRefused \? \{ ethernaRefused \} : \{\}\) \} \}/);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Io = import("../src/lib/etherna/failover.js").SweepIo;
type Read = import("../src/lib/swarm/soc-read.js").RawSocRead;

function fakeIo(bee: Record<string, Read>, etherna: Record<string, Read> = {}) {
  const posted: Array<Parameters<Io["post"]>[0]> = [];
  const offered: string[] = [];
  const io: Io & { posted: typeof posted; offered: string[]; postFails?: boolean; routeFails?: boolean } = {
    posted,
    offered,
    readBee: async (a) => bee[a] ?? ABSENT,
    readEtherna: async (a) => etherna[a] ?? ABSENT,
    route: () => {
      if (io.routeFails) throw new Error("Storage is temporarily unavailable");
      return { batchId: ETH_BATCH, target: "etherna" };
    },
    // Like postSocToEtherna: the send is listed first.
    post: async (p) => {
      ledger.noteEthernaSend(hex(calculateSocAddress(unhex(p.identifierHex), unhex(p.ownerHex))), p.ownerHex, p.identifierHex);
      posted.push(p);
      if (io.postFails) throw new Error("Etherna SOC write 503");
    },
    offer: async (a) => {
      offered.push(a);
    },
  };
  return io;
}

const found = (raw: Uint8Array): Read => ({ status: "found", raw });

test("sweep: a pending entry goes once our bee serves the chunk, or neither store has it", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const seen = signedSoc(20);
  const gone = signedSoc(21);
  const stillInEtherna = signedSoc(22);
  const beeDown = signedSoc(23);
  const wrongBytes = signedSoc(24);
  for (const s of [seen, gone, stillInEtherna, beeDown, wrongBytes]) ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  const fresh = signedSoc(25);
  now += ledger.SETTLE_MIN_AGE_MS;
  ledger.noteEthernaSend(fresh.address, fresh.owner, fresh.identifier);
  const io = fakeIo(
    {
      [seen.address]: found(seen.raw),
      [beeDown.address]: DOWN,
      [wrongBytes.address]: found(signedSoc(26).raw),
      [fresh.address]: found(fresh.raw),
    },
    { [stillInEtherna.address]: found(stillInEtherna.raw), [beeDown.address]: ABSENT },
  );
  const r = await failover.sweepRelayLedger(io);
  assert.equal(r.settled, 1);
  assert.equal(ledger.getRelayEntry(seen.address), undefined);
  assert.ok(ledger.getRelayEntry(gone.address), "one 404 from each store is not yet a verdict");
  assert.ok(ledger.getRelayEntry(stillInEtherna.address), "Etherna holds it: it may still surface");
  assert.ok(ledger.getRelayEntry(beeDown.address), "our bee could not answer");
  assert.ok(ledger.getRelayEntry(wrongBytes.address), "bytes that are not this chunk prove nothing");
  assert.ok(ledger.getRelayEntry(fresh.address), "too young to judge");
  now += ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(gone.address), undefined, "the second look, minutes later, drops it");
  assert.ok(ledger.getRelayEntry(stillInEtherna.address));
});

test("sweep: a failover chunk is re-posted to Etherna as the same signed bytes, then dropped", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(30);
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [s.address]: found(s.raw) });
  const r = await failover.sweepRelayLedger(io);
  assert.equal(r.migrated, 1);
  assert.equal(io.posted.length, 1);
  const p = io.posted[0];
  assert.equal(p.ownerHex, s.owner);
  assert.equal(p.identifierHex, s.identifier);
  assert.equal(p.sigHex, s.sigHex);
  assert.deepEqual([...p.body], [...s.body]);
  assert.equal(p.batchId, ETH_BATCH);
  assert.deepEqual(io.offered, [s.address]);
  assert.equal(ledger.getRelayEntry(s.address), undefined);
});

test("sweep: Etherna refusing the move keeps the entry and stops the pass", async () => {
  const a = signedSoc(31);
  const b = signedSoc(32);
  ledger.noteFailover(a.address, a.owner, a.identifier, PARENT);
  ledger.noteFailover(b.address, b.owner, b.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [a.address]: found(a.raw), [b.address]: found(b.raw) });
  io.postFails = true;
  assert.equal((await failover.sweepRelayLedger(io)).migrated, 0);
  assert.equal(io.posted.length, 1, "the rest wait for the next pass");
  assert.ok(ledger.getRelayEntry(a.address) && ledger.getRelayEntry(b.address));
  assert.match(String((failover.ethernaFailoverHealth().lastMigrationError as { error: string }).error), /503/);

  io.postFails = false;
  io.routeFails = true;
  assert.equal((await failover.sweepRelayLedger(io)).migrated, 0);
  assert.ok(ledger.getRelayEntry(a.address), "no batch to move to: kept");
});

test("sweep: bytes on our bee that are not this chunk are never moved", async () => {
  const s = signedSoc(37);
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [s.address]: found(signedSoc(38).raw) });
  await failover.sweepRelayLedger(io);
  assert.equal(io.posted.length, 0);
  assert.ok(ledger.getRelayEntry(s.address));
});

test("sweep: Etherna refusing one chunk does not hold up the others", async () => {
  const bad = signedSoc(39);
  const good = signedSoc(40);
  ledger.noteFailover(bad.address, bad.owner, bad.identifier, PARENT);
  ledger.noteFailover(good.address, good.owner, good.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [bad.address]: found(bad.raw), [good.address]: found(good.raw) });
  io.post = async (p) => {
    io.posted.push(p);
    if (p.identifierHex === bad.identifier) throw Object.assign(new Error("Etherna SOC write 400"), { status: 400 });
  };
  assert.equal((await failover.sweepRelayLedger(io)).migrated, 1);
  assert.ok(ledger.getRelayEntry(bad.address), "kept, to retry");
  assert.equal(ledger.getRelayEntry(good.address), undefined);
});

test("sweep: entries it keeps go to the back, so a stuck one never pins the front", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const stuck = [signedSoc(41), signedSoc(42), signedSoc(43)];
  for (const s of stuck) ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo(Object.fromEntries(stuck.map((s) => [s.address, DOWN])));
  const looked: string[] = [];
  const readBee = io.readBee;
  io.readBee = async (a) => {
    looked.push(a);
    return readBee(a);
  };
  for (let i = 0; i < 3; i++) await failover.sweepRelayLedger(io, { settle: 1, migrate: 1 });
  assert.deepEqual(looked, stuck.map((s) => s.address));
});

test("sweep: Etherna refusing one account's batch (402) does not hold up the others", async () => {
  const bad = signedSoc(44);
  const good = signedSoc(45);
  ledger.noteFailover(bad.address, bad.owner, bad.identifier, PARENT);
  ledger.noteFailover(good.address, good.owner, good.identifier, "0x" + "bb".repeat(20));
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [bad.address]: found(bad.raw), [good.address]: found(good.raw) });
  io.post = async (p) => {
    io.posted.push(p);
    if (p.identifierHex === bad.identifier) throw Object.assign(new Error("Etherna SOC write 402"), { status: 402 });
  };
  assert.equal((await failover.sweepRelayLedger(io)).migrated, 1);
  assert.ok(ledger.getRelayEntry(bad.address));
});

test("sweep: a kept entry waits longer each time before it is looked at again", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(46);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [s.address]: DOWN });
  let looks = 0;
  io.readBee = async () => {
    looks++;
    return DOWN;
  };
  await failover.sweepRelayLedger(io);
  await failover.sweepRelayLedger(io);
  assert.equal(looks, 1, "not again at once");
  now += ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(looks, 2);
  now += ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(looks, 2, "the gap doubled");
  now += ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(looks, 3);
});

test("sweep: an entry sent again while the sweep was looking is not the sweep's to drop", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(47);
  ledger.noteEthernaSend(s.address, s.owner, s.identifier);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({ [s.address]: found(s.raw) });
  io.readBee = async (a) => {
    // Another device relays the same version mid-pass.
    now += 1;
    ledger.noteEthernaSend(s.address, s.owner, s.identifier);
    return found(s.raw);
  };
  await failover.sweepRelayLedger(io);
  assert.ok(ledger.getRelayEntry(s.address), "the re-send keeps it listed");
});

test("sweep: a failover entry listed again mid-pass is not turned back to pending", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const s = signedSoc(48);
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({}, { [s.address]: found(s.raw) });
  io.readEtherna = async () => {
    now += 1;
    ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
    return found(s.raw);
  };
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
});

test("sweep: nothing moves while Etherna is paused", async () => {
  const s = signedSoc(33);
  ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  breaker.noteEthernaFailure("hung", performance.now() - 60_000);
  const io = fakeIo({ [s.address]: found(s.raw) });
  assert.equal((await failover.sweepRelayLedger(io)).migrated, 0);
  assert.equal(io.posted.length, 0);
  assert.ok(ledger.getRelayEntry(s.address));
});

test("sweep: a failover chunk our bee lost but Etherna holds goes back to pending; one nobody holds ends", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const onEtherna = signedSoc(34);
  const nowhere = signedSoc(35);
  const unknown = signedSoc(36);
  for (const s of [onEtherna, nowhere, unknown]) ledger.noteFailover(s.address, s.owner, s.identifier, PARENT);
  now += ledger.SETTLE_MIN_AGE_MS;
  const io = fakeIo({}, { [onEtherna.address]: found(onEtherna.raw), [unknown.address]: DOWN });
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(onEtherna.address)?.status, "pending", "in Etherna, not on the network: still listed");
  assert.equal(ledger.relayLedgerClearsAbsent(onEtherna.address), false);
  assert.ok(ledger.getRelayEntry(nowhere.address), "first look");
  assert.ok(ledger.getRelayEntry(unknown.address));
  now += ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(nowhere.address), undefined);
  assert.ok(ledger.getRelayEntry(unknown.address), "could not ask: kept");
  assert.equal(io.posted.length, 0);
});

// ---------------------------------------------------------------------------
// One sender
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
function sourceFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every SOC this server sends to Etherna goes through postSocToEtherna, which lists it first", () => {
  const hits: string[] = [];
  for (const p of sourceFiles(SRC)) {
    const text = readFileSync(p, "utf-8");
    // A raw POST to Etherna's /soc, by whichever name the Etherna base goes.
    for (const m of text.matchAll(/\$\{ETHERNA_[A-Z_]+\}\/soc\//g)) hits.push(`${p.slice(SRC.length)}@${m.index}`);
  }
  assert.equal(hits.length, 1, `Etherna /soc senders: ${hits.join(", ")}`);
  assert.match(hits[0], /^lib\/etherna\/upload\.ts@/);
  const upload = readFileSync(join(SRC, "lib/etherna/upload.ts"), "utf-8");
  const fn = upload.slice(upload.indexOf("export async function postSocToEtherna("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.indexOf("noteEthernaSend(") > 0 && body.indexOf("noteEthernaSend(") < body.indexOf("/soc/"), "listed before the POST");
  // bee-js pointed at Etherna could write a SOC around it; only the site deploy holds one,
  // and its Etherna branches use the raw writers above.
  const code = (p: string) => readFileSync(p, "utf-8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const holders = sourceFiles(SRC).filter((p) => /getEthernaBee\(\)/.test(code(p)));
  assert.deepEqual(holders.map((p) => p.slice(SRC.length)).sort(), ["lib/etherna/upload.ts", "routes/sites.ts"]);
});
