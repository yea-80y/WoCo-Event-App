/**
 * "Make this device the main one" (#746 step 4, Fable consult 7).
 *
 * Both devices run against each other through an in-memory mailbox with the real
 * channel; the grants are signed with real keys and checked with the real check.
 * The chain is one variable, the server a set of nonces. What these pin:
 *  - nothing irreversible before the new main's grants exist and check out: the
 *    old main's envelope, then the rotation, then it becomes a linked device;
 *  - the old main is signed back in first, and a repeat registration is "done";
 *  - grants for a rotation that never happened are dropped once the code expires;
 *    grants for one that did are kept until registered, by either device;
 *  - only the chain decides who owns the account.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet, type TypedDataField } from "ethers";
import { DEVICE_GRANT_DOMAIN, DEVICE_GRANT_TYPES, credentialTagOf, PAIRING_TTL_MS } from "@woco/shared";
import {
  grantsMatch,
  MakeMainHandedOverError,
  resumeMakeMain,
  runApproveMakeMain,
  runMakeAddedMain,
  runMakeThisDeviceMain,
  checkMakeMainOffer,
  type MakeAddedMainContext,
  type PendingMakeMain,
  type PendingStore,
} from "../src/lib/auth/make-main.ts";
import {
  LINK_CODE_UNKNOWN,
  parseMakeMainAnswer,
  parseMakeMainOffer,
  parseMakeMainReply,
  readPairingOffer,
  type MakeMainOffer,
  type PairedDevice,
  type SignedGrant,
} from "../src/lib/auth/device-link.ts";
import { PairingExpiredError, type PairingTransport } from "../src/lib/auth/pairing-channel.ts";

const PARENT = "0x" + "12".repeat(20);
const mainKey = Wallet.createRandom();
const laptopKey = Wallet.createRandom();
const tabletKey = Wallet.createRandom();
const M = mainKey.address.toLowerCase();
const X = laptopKey.address.toLowerCase();
const T = tabletKey.address.toLowerCase();
const tag = (s: string) => credentialTagOf(new TextEncoder().encode(s));
const TAG_M = tag("main");
const TAG_X = tag("laptop");
const TAG_T = tag("tablet");

const types = DEVICE_GRANT_TYPES as unknown as Record<string, TypedDataField[]>;
async function sign(key: Wallet, d: PairedDevice, nonceByte = "01"): Promise<SignedGrant> {
  const grant = { parent: PARENT, grantee: d.grantee, credentialTag: d.credentialTag, issuedAt: 1_800_000_000, nonce: "0x" + nonceByte.repeat(32) };
  return { grant, grantSig: await key.signTypedData(DEVICE_GRANT_DOMAIN, types, grant) };
}

function mailbox(): PairingTransport {
  const slots = new Map<string, string>();
  return {
    async post(id, slot, box) {
      if (slots.has(`${id}/${slot}`)) throw new PairingExpiredError();
      slots.set(`${id}/${slot}`, box);
    },
    async read(id, slot) {
      return slots.get(`${id}/${slot}`) ?? null;
    },
  };
}

function memStore(): PendingStore & { map: Map<string, PendingMakeMain> } {
  const map = new Map<string, PendingMakeMain>();
  return {
    map,
    read: (p) => (map.has(p) ? structuredClone(map.get(p)!) : null),
    write: (p) => void map.set(p.parent, structuredClone(p)),
    clear: (p) => void map.delete(p),
  };
}

/** The world both devices share: one owner on chain, one grant list on the server. */
function world() {
  const log: string[] = [];
  const chain = { owner: M };
  const nonces = new Set<string>();
  const server = (who: string) => async (g: SignedGrant) => {
    if (nonces.has(g.grant.nonce)) {
      log.push(`${who}:repeat:${g.grant.grantee.slice(0, 6)}`);
      return "done" as const;
    }
    nonces.add(g.grant.nonce);
    log.push(`${who}:registered:${g.grant.grantee.slice(0, 6)}`);
    return "done" as const;
  };
  return { log, chain, server, nonces };
}

// Yields to the event loop, so one side's wait never starves the other's.
const DEVICES: PairedDevice[] = [
  { grantee: X, credentialTag: TAG_X },
  { grantee: T, credentialTag: TAG_T },
];

const noSleep = () => new Promise<void>((r) => setImmediate(r));

function runBoth(over: {
  signGrants?: (devices: PairedDevice[]) => Promise<SignedGrant[]>;
  writeOwnEnvelope?: () => Promise<void>;
  rotate?: (to: string) => Promise<void>;
  laptopNow?: () => number;
  devices?: PairedDevice[];
  known?: { owner: string; devices: PairedDevice[] };
  recheck?: () => Promise<PairedDevice[]>;
  becomeOwner?: () => Promise<void>;
} = {}) {
  const w = world();
  const m = mailbox();
  const phoneStore = memStore();
  const laptopStore = memStore();
  let nonce = 0;
  const phoneDone = { promise: null as null | Promise<{ registered: boolean }> };
  // The phone's waits end once the laptop has finished, either way: nothing it could
  // still be waiting for will come.
  let laptopSettled = false;
  const phoneSleep = async () => {
    if (laptopSettled) throw new Error("the other device stopped");
    await noSleep();
  };
  let shown!: () => void;
  const codeShown = new Promise<void>((r) => (shown = r));
  const laptop = runMakeThisDeviceMain(
    {
      onCode: ({ typed }) => {
        phoneDone.promise = (async () => {
          const { code, offer } = await readPairingOffer(typed, { apiBase: "", transport: m });
          assert.equal(offer.kind, "make-main");
          return runApproveMakeMain(code, offer as MakeMainOffer, {
            apiBase: "",
            parent: PARENT,
            self: M,
            selfTag: TAG_M,
            devices: over.devices ?? DEVICES,
            recheckDevices: over.recheck ?? (async () => over.devices ?? DEVICES),
            transport: m,
            store: phoneStore,
            sleep: phoneSleep,
            writeOwnEnvelope: over.writeOwnEnvelope ?? (async () => void w.log.push("phone:envelope")),
            rotate:
              over.rotate ??
              (async (to) => {
                w.log.push(`phone:rotate:${to.slice(0, 6)}`);
                w.chain.owner = to;
              }),
            becomeDevice: async () => void w.log.push("phone:became-device"),
            submit: w.server("phone"),
          });
        })();
        shown();
      },
    },
    {
      apiBase: "",
      parent: PARENT,
      self: X,
      selfTag: TAG_X,
      transport: m,
      store: laptopStore,
      sleep: noSleep,
      now: over.laptopNow,
      signGrants:
        over.signGrants ??
        (async (devices) => {
          w.log.push(`laptop:signed:${devices.map((d) => d.grantee.slice(0, 6)).join(",")}`);
          return Promise.all(devices.map((d) => sign(laptopKey, d, (++nonce).toString(16).padStart(2, "0"))));
        }),
      readOwner: async () => w.chain.owner,
      knownDevices: async () => over.known ?? { owner: M, devices: DEVICES },
      becomeOwner: over.becomeOwner ?? (async () => void w.log.push("laptop:became-owner")),
      submit: w.server("laptop"),
    },
  );
  // Either side may give up while the test is still awaiting the other.
  laptop.catch(() => {}).finally(() => (laptopSettled = true));
  return { w, laptop, phone: async () => { await codeShown; return phoneDone.promise!; }, phoneStore, laptopStore };
}

test("both devices: grants first, then envelope, rotation, the old main a device, the old main signed back in first", async () => {
  const run = runBoth();
  const laptopResult = await run.laptop;
  const phoneResult = await run.phone();
  assert.deepEqual(laptopResult, { registered: true });
  assert.deepEqual(phoneResult, { registered: true });
  assert.equal(run.w.chain.owner, X);
  const l = run.w.log;
  const at = (s: string) => l.findIndex((x) => x.startsWith(s));
  assert.equal(l[at("laptop:signed")], `laptop:signed:${M.slice(0, 6)},${T.slice(0, 6)}`, "the old main first");
  assert.ok(at("laptop:signed") < at("phone:envelope"));
  assert.ok(at("phone:envelope") < at("phone:rotate"));
  assert.ok(at("phone:rotate") < at("phone:became-device"));
  assert.ok(at("phone:became-device") < at("phone:registered"));
  assert.equal(l[at("phone:registered")], `phone:registered:${M.slice(0, 6)}`);
  assert.ok(at("laptop:became-owner") > at("phone:rotate"), "ownership read from the chain, after it changed");
  assert.equal(run.w.nonces.size, 2, "each grant registered once; the other device's copy is a repeat");
  assert.equal(run.phoneStore.map.size, 0);
  assert.equal(run.laptopStore.map.size, 0);
});

test("grants not signed by the new main are refused - no envelope, no rotation", async () => {
  const run = runBoth({
    signGrants: (devices) => Promise.all(devices.map((d) => sign(tabletKey, d))),
    laptopNow: (() => { let t = Date.now(); return () => (t += PAIRING_TTL_MS); })(),
  });
  await assert.rejects(run.phone(), { message: LINK_CODE_UNKNOWN });
  await assert.rejects(run.laptop, /didn't finish/);
  assert.equal(run.w.chain.owner, M);
  assert.ok(!run.w.log.some((x) => x.startsWith("phone:envelope") || x.startsWith("phone:rotate")));
  assert.equal(run.laptopStore.map.size, 0, "grants for a rotation that never happened are dropped");
});

test("a reply missing a device, or carrying one more, is refused", async () => {
  for (const pick of [(d: PairedDevice[]) => d.slice(0, 1), (d: PairedDevice[]) => [...d, { grantee: "0x" + "77".repeat(20), credentialTag: TAG_T }]]) {
    const run = runBoth({
      signGrants: (devices) => Promise.all(pick(devices).map((d, i) => sign(laptopKey, d, (i + 1).toString(16).padStart(2, "0")))),
      laptopNow: (() => { let t = Date.now(); return () => (t += PAIRING_TTL_MS); })(),
    });
    await assert.rejects(run.phone(), { message: LINK_CODE_UNKNOWN });
    await assert.rejects(run.laptop);
    assert.equal(run.w.chain.owner, M);
  }
});

test("no envelope, no rotation", async () => {
  const run = runBoth({
    writeOwnEnvelope: async () => {
      throw new Error("relay down");
    },
    laptopNow: (() => { let t = Date.now(); return () => (t += PAIRING_TTL_MS); })(),
  });
  await assert.rejects(run.phone(), /relay down/);
  await assert.rejects(run.laptop, /didn't finish/);
  assert.equal(run.w.chain.owner, M);
  assert.equal(run.phoneStore.map.size, 0);
});

test("a rotation with no receipt keeps the grants; inside the window the chain decides", async () => {
  const run = runBoth({
    rotate: async (to) => {
      run.w.chain.owner = to;
      throw new Error("Couldn't confirm the change yet");
    },
  });
  await assert.rejects(run.phone(), /confirm the change/);
  await run.laptop;
  const kept = run.phoneStore.map.get(PARENT);
  assert.ok(kept && kept.expiresAt !== null && kept.grants.length === 2);
  // Next sign-in on the phone: the owner changed, so it registers (repeats are done).
  const settled: string[] = [];
  const done = await resumeMakeMain({
    parent: PARENT,
    store: run.phoneStore,
    readOwner: async () => run.w.chain.owner,
    submit: run.w.server("phone"),
    settle: async (p) => void settled.push(`${p.previousOwner === M ? "device" : "owner"}`),
  });
  assert.equal(done, true);
  assert.deepEqual(settled, ["device"]);
  assert.equal(run.phoneStore.map.size, 0);
});

test("resume: unanswered chain keeps everything; unchanged owner after expiry drops; landed submits what is left", async () => {
  const store = memStore();
  const g = await sign(laptopKey, { grantee: M, credentialTag: TAG_M });
  const base: PendingMakeMain = { parent: PARENT, newOwner: X, previousOwner: M, grants: [g], expiresAt: 1_000 };
  store.write(base);
  assert.equal(await resumeMakeMain({ parent: PARENT, store, readOwner: async () => "error", submit: async () => "done", now: () => 999 }), false);
  assert.equal(store.map.size, 1, "an unanswered chain inside the window decides nothing");
  assert.equal(await resumeMakeMain({ parent: PARENT, store, readOwner: async () => M, submit: async () => "done", now: () => 999 }), false);
  assert.equal(store.map.size, 1, "inside the window: the other device may still rotate");
  assert.equal(await resumeMakeMain({ parent: PARENT, store, readOwner: async () => "error", submit: async () => "done", now: () => 5_000 }), true);
  assert.equal(store.map.size, 0, "past the window it goes, without asking the chain");

  const g2 = await sign(laptopKey, { grantee: T, credentialTag: TAG_T }, "02");
  store.write({ ...base, grants: [g, g2], expiresAt: null });
  assert.equal(await resumeMakeMain({ parent: PARENT, store, readOwner: async () => X, submit: async (s) => (s.grant.nonce === g.grant.nonce ? "done" : "later") }), false);
  assert.deepEqual(store.map.get(PARENT)!.grants, [g2], "only what did not land is kept");
  assert.equal(await resumeMakeMain({ parent: PARENT, store, readOwner: async () => X, submit: async () => "done" }), true);
  assert.equal(store.map.size, 0);
});

test("the new main refuses an answer that names itself - and signs nothing", async () => {
  const { pairingChannel, parsePairingCode } = await import("../src/lib/auth/pairing-channel.ts");
  for (const answer of [
    { v: 1, kind: "make-main", previous: { grantee: X, credentialTag: TAG_X }, devices: [] },
    { v: 1, kind: "make-main", previous: { grantee: M, credentialTag: TAG_M }, devices: [{ grantee: X, credentialTag: TAG_X }] },
  ]) {
    const m = mailbox();
    let signed = false;
    const run = runMakeThisDeviceMain(
      {
        onCode: ({ typed }) => {
          void (async () => {
            const ch = pairingChannel(parsePairingCode(typed)!);
            await m.post(ch.id, "answer", await ch.seal("answer", answer));
          })();
        },
      },
      {
        apiBase: "",
        parent: PARENT,
        self: X,
        selfTag: TAG_X,
        transport: m,
        store: memStore(),
        sleep: noSleep,
        signGrants: async () => {
          signed = true;
          return [];
        },
        readOwner: async () => M,
        knownDevices: async () => ({ owner: M, devices: DEVICES }),
        becomeOwner: async () => {},
        submit: async () => "done",
      },
    );
    await assert.rejects(run, { message: LINK_CODE_UNKNOWN });
    assert.equal(signed, false);
  }
});

test("MUST-1: grants with a deadline go once it passes, even if the same key becomes the owner later", async () => {
  const store = memStore();
  const g = await sign(laptopKey, { grantee: T, credentialTag: TAG_T });
  store.write({ parent: PARENT, newOwner: X, previousOwner: M, grants: [g], expiresAt: 1_000 });
  let submitted = 0;
  const done = await resumeMakeMain({ parent: PARENT, store, readOwner: async () => X, submit: async () => (submitted++, "done"), now: () => 5_000 });
  assert.equal(done, true);
  assert.equal(submitted, 0, "a removed device must not come back through an old grant");
  assert.equal(store.map.size, 0);
});

test("the new main refuses an answer that is not this account's own main and devices - and signs nothing", async () => {
  const stranger = Wallet.createRandom().address.toLowerCase();
  for (const known of [
    { owner: stranger, devices: DEVICES },
    { owner: M, devices: [DEVICES[0]] },
    { owner: M, devices: [DEVICES[0], { grantee: T, credentialTag: TAG_M }] },
  ]) {
    let signed = false;
    const run = runBoth({
      known,
      signGrants: async () => {
        signed = true;
        return [];
      },
    });
    await assert.rejects(run.laptop, { message: LINK_CODE_UNKNOWN });
    assert.equal(signed, false);
    assert.equal(run.w.chain.owner, M);
    await run.phone().catch(() => {});
  }
});

test("the main stops before the envelope if its devices changed while the other was signing", async () => {
  const run = runBoth({
    recheck: async () => [DEVICES[0]],
    laptopNow: (() => { let t = Date.now(); return () => (t += PAIRING_TTL_MS); })(),
  });
  await assert.rejects(run.phone(), /changed while this was in progress/);
  assert.ok(!run.w.log.some((x) => x.startsWith("phone:envelope") || x.startsWith("phone:rotate")));
  assert.equal(run.w.chain.owner, M);
});

test("the new main marks the change landed before it takes the owner role", async () => {
  let seen: PendingMakeMain | null | undefined;
  const run = runBoth({ becomeOwner: async () => void (seen = run.laptopStore.read(PARENT)) });
  await run.laptop;
  await run.phone();
  assert.ok(seen);
  assert.equal(seen!.expiresAt, null);
});

test("the main refuses an offer for another account, from itself, or for a device it does not list", () => {
  const devices = [{ grantee: X, credentialTag: TAG_X }];
  const offer: MakeMainOffer = { v: 1, kind: "make-main", parent: PARENT, grantee: X, credentialTag: TAG_X };
  assert.doesNotThrow(() => checkMakeMainOffer(offer, { parent: PARENT, self: M, devices }));
  assert.throws(() => checkMakeMainOffer({ ...offer, parent: "0x" + "34".repeat(20) }, { parent: PARENT, self: M, devices }), /different account/);
  assert.throws(() => checkMakeMainOffer({ ...offer, grantee: M }, { parent: PARENT, self: M, devices }), /from this device/);
  assert.throws(() => checkMakeMainOffer({ ...offer, grantee: T }, { parent: PARENT, self: M, devices }), /isn't linked/);
  assert.throws(() => checkMakeMainOffer({ ...offer, credentialTag: TAG_T }, { parent: PARENT, self: M, devices }), /isn't linked/);
});

test("grantsMatch: one per device, this account, the new main's signature", async () => {
  const devices = [{ grantee: M, credentialTag: TAG_M }, { grantee: T, credentialTag: TAG_T }];
  const good = [await sign(laptopKey, devices[0], "01"), await sign(laptopKey, devices[1], "02")];
  assert.ok(grantsMatch(good, { parent: PARENT, newOwner: X, devices }));
  assert.ok(!grantsMatch([good[0], good[0]], { parent: PARENT, newOwner: X, devices }), "a duplicate is not two devices");
  assert.ok(!grantsMatch(good, { parent: "0x" + "34".repeat(20), newOwner: X, devices }));
  assert.ok(!grantsMatch(good, { parent: PARENT, newOwner: T, devices }));
  assert.ok(!grantsMatch([good[0], await sign(laptopKey, { grantee: T, credentialTag: TAG_M }, "03")], { parent: PARENT, newOwner: X, devices }));
  assert.ok(!grantsMatch([good[0], await sign(laptopKey, devices[1], "01")], { parent: PARENT, newOwner: X, devices }), "one nonce, two devices");
});

test("messages: shapes, and no more devices than the cap", async () => {
  const d = { grantee: X, credentialTag: TAG_X };
  assert.deepEqual(parseMakeMainOffer({ v: 1, kind: "make-main", parent: PARENT, ...d }), { v: 1, kind: "make-main", parent: PARENT, ...d });
  assert.equal(parseMakeMainOffer({ v: 1, kind: "make-main", ...d }), null);
  assert.ok(parseMakeMainAnswer({ v: 1, kind: "make-main", previous: d, devices: Array(9).fill(d) }));
  assert.equal(parseMakeMainAnswer({ v: 1, kind: "make-main", previous: d, devices: Array(10).fill(d) }), null);
  assert.equal(parseMakeMainAnswer({ v: 1, kind: "make-main", previous: d, devices: [{ grantee: "x" }] }), null);
  const g = await sign(laptopKey, d);
  assert.ok(parseMakeMainReply({ v: 1, kind: "make-main", grants: [g] }));
  assert.equal(parseMakeMainReply({ v: 1, kind: "make-main", grants: [{ ...g, grantSig: "0x12" }] }), null);
  assert.equal(parseMakeMainReply({ v: 1, kind: "make-main", grants: Array(11).fill(g) }), null);
});

// ---------------------------------------------------------------------------
// The auth store
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("store: roles follow the change both ways; a linked device never keeps reading as the owner", () => {
  const owner = body(STORE, "async function _becomeOwner(");
  assert.match(owner, /await _putRecoveryBinding\(seedAddr, parent\);\s*await _clearDeviceBinding\(seedAddr\);/);
  assert.match(owner, /_deviceRole = false;\s*_kernel = null;/);
  const device = body(STORE, "async function _becomeDevice(");
  assert.match(device, /await _putDeviceBinding\(seedAddr, parent\);\s*await _clearRecoveryBinding\(seedAddr\);\s*clearVerifiedBinding\("passkey", seedAddr\);\s*clearCachedKernelAddress\("passkey", seedAddr\);/);
  assert.match(device, /_deviceRole = true;\s*_kernel = null;/);
  // A server "device" verdict also drops a recovered binding: recovered wins in _boundKernelFor.
  assert.match(body(STORE, "async function _loginAddedPasskey("), /await _putDeviceBinding\(seedAddr, parent\);[\s\S]{0,200}await _clearRecoveryBinding\(seedAddr\);/);
});

test("store: a once-recovered main that moved asks the server instead of being refused outright", () => {
  const from = STORE.indexOf("const foreignOwner = provenOrphanOwner(answered, account.address);");
  assert.ok(from > 0);
  const branch = STORE.slice(from, STORE.indexOf("ownerAffirmed =", from));
  assert.match(branch, /await _loginAddedPasskey\(account, \{ parent: override, seed: null, onChainOwner: foreignOwner \}\);/);
  assert.doesNotMatch(branch, /refuseOrphanedCredential/);
});

test("store: resume costs a storage read and never mints a session; the handover asks for the passkey first", () => {
  const resume = body(STORE, "async function resumeMakeMain(");
  assert.ok(resume.indexOf("makeMainPendingKey(parent)") < resume.indexOf('await import("./make-main.js")'));
  assert.match(body(STORE, "async function _restoreCachedAuth("), /void resumeMakeMain\(\)\.catch\(/);
  const MM = read("../src/lib/auth/make-main.ts");
  assert.match(body(MM, "export async function resumeForHost("), /submit: async \(g\) => \(session \? submitGrant\(g\) : "later"\)/);
  const approve = body(MM, "export async function approveMakeMain(");
  const fresh = approve.indexOf("await host.freshMainPasskey();");
  assert.ok(fresh >= 0 && fresh < approve.indexOf("await liveDevices(parent, self)"));
  assert.match(approve, /\.\.\.oldMainSteps\(host, \{ parent, self, seed, prf \}\)/);
  assert.match(body(MM, "function oldMainSteps("), /recheckDevices: \(\) => liveDevices\(a\.parent, a\.self\)/);
  assert.match(body(MM, "async function liveDevices("), /verifyDeviceGrantList\(\(await listGrants\(\)\)\.grants, \{ parent, owner: self \}\)\s*\.filter\(\(d\) => d\.removedAt === null\)/);
  assert.match(body(MM, "export async function submitGrant("), /return res\.ok \|\| res\.code === "nonce-used" \? "done" : "later";/);
  // The store lends state, not flows: the make-main code stays out of every page load.
  assert.doesNotMatch(STORE, /listDeviceGrants|rotateOwnerSelf|writePortabilityEnvelope\(\{ prfSecret: prf/);
});

test("rotation: the two validator calls in ONE batch, confirmed at the landing block", () => {
  const k = body(read("../src/lib/auth/kernel-account.ts"), "export async function rotateOwnerSelf(");
  assert.match(k, /calls: \[\s*\{ to: validator, data: d\.encodeFunctionData\(\{ abi, functionName: "onUninstall", args: \["0x"\] \}\) \},\s*\{ to: validator, data: d\.encodeFunctionData\(\{ abi, functionName: "onInstall", args: \[newOwner\.toLowerCase\(\) as Hex\] \}\) \},\s*\]/);
  assert.match(k, /readKernelEcdsaOwnerStrict\(builtKernel\.address, blockNumber\)/);
  assert.match(k, /if \(owner !== newOwner\.toLowerCase\(\)\) \{/);
});

test("sign-off fixes pinned in the store and screens", () => {
  // SHOULD-3: an "owner" verdict the device's own chain read contradicts is no verdict.
  const added = body(STORE, "async function _loginAddedPasskey(");
  const contradiction = added.indexOf('if (verdict === "owner" && start.onChainOwner && start.onChainOwner.toLowerCase() !== seedAddr.toLowerCase()) {');
  assert.ok(contradiction > 0 && contradiction < added.indexOf("await clearSession();"), "checked before anything is kept");
  // A receipt means the rotation ran: an owner read failing after it is "not yet confirmed".
  const k = body(read("../src/lib/auth/kernel-account.ts"), "export async function rotateOwnerSelf(");
  assert.match(k, /if \(owner === "error"\) \{[\s\S]*?return \{ txHash, blockNumber, confirmed: false \};/);
  // The linked envelope is retried only with a session and the PRF output here; the
  // marker goes only when the envelope is written.
  const retry = body(STORE, "async function _retryLinkedEnvelope(");
  assert.match(retry, /if \(!globalThis\.localStorage\?\.getItem\(key\) \|\| !_sessionAddress \|\| !_passkeyPrfSecret\) return;/);
  assert.match(retry, /if \(await _maybeBackfillPortabilityEnvelope\(\)\) globalThis\.localStorage\?\.removeItem\(key\);/);
  assert.match(body(STORE, "async function _maybeBackfillPortabilityEnvelope("), /return outcome\.action === "wrote" \|\| outcome\.action === "skipped";/);
  // SHOULD-4: open panels outlive the role change they cause.
  const your = read("../src/lib/components/passkeys/YourPasskeys.svelte");
  const markup = your.slice(your.indexOf("</script>"));
  assert.ok(markup.indexOf("{#if makingMain}") < markup.indexOf("{#if !loaded}"));
  assert.ok(markup.indexOf("{#if linking}") < markup.indexOf("{#if !loaded}"));
  assert.doesNotMatch(markup, /\{#if !owner\}[\s\S]{0,400}<MakeThisDeviceMain/);
});

// ---------------------------------------------------------------------------
// The same phone: the main passkey hands over to a passkey this device added
// ---------------------------------------------------------------------------

function samePhone(over: Partial<MakeAddedMainContext> & { sheetKey?: Wallet } = {}) {
  const w = world();
  const store = memStore();
  let nonce = 0;
  const sheetKey = over.sheetKey ?? laptopKey;
  const ctx: MakeAddedMainContext = {
    parent: PARENT,
    self: M,
    selfTag: TAG_M,
    target: { grantee: X, credentialTag: TAG_X },
    devices: DEVICES,
    store,
    recheckDevices: async () => DEVICES,
    assertTarget: async () => {
      w.log.push("sheet");
      return { address: sheetKey.address, privateKey: sheetKey.privateKey, prfSecret: "00" };
    },
    signGrant: async (key, parent, grantee, credentialTag) => {
      w.log.push(`signed:${grantee.slice(0, 6)}`);
      assert.equal(parent, PARENT);
      return sign(new Wallet(key), { grantee, credentialTag }, (++nonce).toString(16).padStart(2, "0"));
    },
    writeOwnEnvelope: async () => void w.log.push("envelope"),
    rotate: async (to) => {
      w.log.push(`rotate:${to.slice(0, 6)}`);
      w.chain.owner = to;
    },
    becomeDevice: async () => void w.log.push("became-device"),
    submit: w.server("phone"),
    adopt: async (k) => void w.log.push(`adopt:${k.address.toLowerCase().slice(0, 6)}`),
    readOwner: async () => w.chain.owner,
    ...over,
  };
  return { w, store, run: () => runMakeAddedMain(ctx) };
}

test("same phone: the row's passkey signs the grants, then the same handover, then this tab becomes it", async () => {
  const submitted: SignedGrant[] = [];
  const { w, store, run } = samePhone({ submit: async (g) => (submitted.push(g), w.server("phone")(g)) });
  assert.deepEqual(await run(), { registered: true });
  assert.ok(grantsMatch(submitted, { parent: PARENT, newOwner: X, devices: [{ grantee: M, credentialTag: TAG_M }, DEVICES[1]] }));
  assert.equal(w.chain.owner, X);
  assert.deepEqual(w.log, [
    "sheet",
    `signed:${M.slice(0, 6)}`,
    `signed:${T.slice(0, 6)}`,
    "envelope",
    `rotate:${X.slice(0, 6)}`,
    "became-device",
    `phone:registered:${M.slice(0, 6)}`,
    `phone:registered:${T.slice(0, 6)}`,
    `adopt:${X.slice(0, 6)}`,
  ]);
  assert.equal(store.map.size, 0);
});

test("same phone: a sheet that answers with another passkey changes nothing", async () => {
  const { w, run } = samePhone({ sheetKey: tabletKey });
  await assert.rejects(run(), /different passkey/);
  assert.deepEqual(w.log, ["sheet"]);
  assert.equal(w.chain.owner, M);
});

test("same phone: only a live device of this account, never itself - checked before any sheet", async () => {
  for (const target of [
    { grantee: M, credentialTag: TAG_M },
    { grantee: X, credentialTag: TAG_T },
    { grantee: "0x" + "77".repeat(20), credentialTag: TAG_X },
  ]) {
    const { w, run } = samePhone({ target });
    await assert.rejects(run());
    assert.deepEqual(w.log, []);
  }
});

test("same phone: a list that changed stops before the envelope; a rotation that fails never adopts", async () => {
  const changed = samePhone({ recheckDevices: async () => [DEVICES[0]] });
  await assert.rejects(changed.run(), /changed while this was in progress/);
  assert.ok(!changed.w.log.some((x) => x === "envelope" || x.startsWith("rotate") || x.startsWith("adopt")));
  assert.equal(changed.store.map.size, 0);

  const failed = samePhone({
    rotate: async () => {
      throw new Error("The main passkey did not change");
    },
  });
  await assert.rejects(failed.run(), /did not change/);
  assert.ok(!failed.w.log.some((x) => x.startsWith("adopt") || x === "became-device"));
  const kept = failed.store.map.get(PARENT);
  assert.ok(kept && kept.expiresAt !== null, "kept with a deadline: dropped if the owner never changed");
});

test("same phone: grants that did not land wait, landed, for the next visit - and the tab still switches", async () => {
  const { w, store, run } = samePhone({ submit: async () => "later" });
  assert.deepEqual(await run(), { registered: false });
  assert.equal(w.log.at(-1), `adopt:${X.slice(0, 6)}`);
  const kept = store.map.get(PARENT)!;
  assert.equal(kept.expiresAt, null);
  assert.equal(kept.newOwner, X);
  assert.equal(kept.grants.length, 2);
});

test("store: same phone - main first, the row's own credential, and the switch in recoverAndRekey's order", () => {
  const MM = read("../src/lib/auth/make-main.ts");
  const prep = body(MM, "export async function prepareMakeAddedMain(");
  const fresh = prep.indexOf("await host.freshMainPasskey();");
  assert.ok(fresh >= 0 && fresh < prep.indexOf("readPasskeyMeta(parent)"), "the main confirms first");
  assert.match(prep, /if \(now\.parent !== parent \|\| now\.self !== self \|\| now\.device \|\| !seed \|\| !prf\) throw/);
  assert.match(prep, /restorePasskeyAccount\(\{ retryDiscoverable: false, credential \}\)/);
  assert.match(prep, /\.\.\.oldMainSteps\(host, \{ parent, self, seed, prf \}\)/);
  const adopt = body(STORE, "async function _adoptNewMain(");
  const order = [
    "await _becomeOwner(self, parent);",
    "await storeLockedSeed(self, parent, seed, key.prfSecret);",
    "await pinPasskeyCredential(credential);",
    "await putKV(StorageKeys.SEED_ADDRESS, self);",
    "_seedAddress = self;",
    "await _restoreAuthAfterRotation();",
  ].map((s) => adopt.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "binding, seed, pin, address, memory, then the session");
  assert.match(adopt, /_deviceRole = false;/);
});

test("SHOULD-1: anything failing after the rotation says so - never 'nothing changed'", async () => {
  for (const over of [
    { becomeDevice: async () => { throw new Error("storage full"); } },
    { adopt: async () => { throw new Error("storage full"); } },
  ] as Partial<MakeAddedMainContext>[]) {
    const { w, run } = samePhone(over);
    await assert.rejects(run(), (e: Error) => e instanceof MakeMainHandedOverError && e.name === "MakeMainHandedOverError");
    assert.equal(w.chain.owner, X);
  }
  // A rotation that is refused changed nothing, and says that.
  const refused = samePhone({ rotate: async () => { throw new Error("The main passkey did not change"); } });
  await assert.rejects(refused.run(), (e: Error) => !(e instanceof MakeMainHandedOverError));
});

test("SHOULD-2: a rotation that landed after its receipt timed out is not repeated on the retry", async () => {
  const { w, store, run } = samePhone();
  w.chain.owner = X; // the earlier try's op landed late
  assert.deepEqual(await run(), { registered: true });
  assert.ok(!w.log.some((x) => x.startsWith("rotate")), "no second rotation");
  assert.deepEqual(w.log.slice(-4), ["became-device", `phone:registered:${M.slice(0, 6)}`, `phone:registered:${T.slice(0, 6)}`, `adopt:${X.slice(0, 6)}`]);
  assert.equal(store.map.size, 0);
  // An owner that cannot be read decides nothing: the rotation runs as usual.
  const unread = samePhone({ readOwner: async () => "error" });
  await unread.run();
  assert.ok(unread.w.log.some((x) => x.startsWith("rotate")));
});

test("sign-off fixes (same phone) pinned in the store and screens", () => {
  const fresh = body(STORE, "async function _freshMainPasskey(");
  assert.match(fresh, /await _ensurePasskeyKey\(\)\.catch\(\(e\) => \{\s*throw asCeremonyCancel\(e\);/, "SHOULD-3");
  const restamp = fresh.indexOf("if (seed && _parent) _setUnlockedSeed(_seedAddress, _parent, seed);");
  assert.ok(restamp > fresh.indexOf("await _unlockPasskeySeed(_seedAddress)"), "SHOULD-5: a full window from the fresh sheet");
  const screen = read("../src/lib/components/passkeys/MakeAddedMain.svelte");
  assert.match(screen, /e\.name === "MakeMainHandedOverError"/);
  assert.doesNotMatch(screen, /isAccountOwner/, "SHOULD-1: the role is not the signal");
  const your = read("../src/lib/components/passkeys/YourPasskeys.svelte");
  assert.match(your, /const busy = \$derived\(promoting !== null \|\| makingMain \|\| linking\);/);
  assert.match(your, /\{#if \(owner \|\| mine\) && !busy\}/, "SHOULD-4");
  // "Move to another password manager": the add is followed by the make-main offer.
  const add = your.slice(your.indexOf("async function add("), your.indexOf("async function remove("));
  assert.ok(add.indexOf("await load();") < add.indexOf("promoting = active.find((r) => r.grantee === grantee) ?? null;"));
  assert.match(your, />\s*Move to another password manager\s*</);
});
