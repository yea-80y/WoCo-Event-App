/**
 * The organiser's side of a ledger2 change (`src/lib/ledger2/organiser-changes.ts`),
 * against a fake chain and relay: what is read, the digest cross-check before any
 * signature, the key check, the retry loop, and "Cancel" while saving - which signs a
 * revoke at the SAME nonce and lets the chain say what happened. Plus the copy rule:
 * nothing an organiser reads mentions the chain or a revoke.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { EventFeed } from "@woco/shared";
import {
  ledger2Digest,
  recoverLedger2Signer,
  type Ledger2Action,
  type Ledger2RelayRequest,
  type Ledger2RelayResult,
} from "@woco/shared/ticket/ledger2-terms";
import {
  Ledger2ChangeError,
  messageFor,
  readLedger2Event,
  signTermsChanges,
  startTermsChange,
  type ChangePhase,
  type Ledger2ClientIO,
  type SeriesRead,
} from "../src/lib/ledger2/organiser-changes.js";

const LEDGER = "0x00000000000000000000000000000000000000aa";
const TARGET = { chainId: 42161, address: LEDGER };
const PARENT = "0x00000000000000000000000000000000000000b1";
const ID_A = `0x${"0a".repeat(32)}`;
const ID_B = `0x${"0b".repeat(32)}`;
const NOW = 1_800_000_000;

const key = Wallet.createRandom();

const EVENT = {
  eventId: "evt-1",
  title: "Gig",
  series: [
    { seriesId: "a", name: "Standing", onChainEventId: ID_A },
    { seriesId: "b", name: "Balcony", onChainEventId: ID_B },
    { seriesId: "c", name: "Unregistered" },
  ],
} as unknown as EventFeed;

function read(over: Partial<SeriesRead> = {}): SeriesRead {
  return {
    organiser: PARENT,
    organiserKey: key.address.toLowerCase(),
    totalSupply: 100,
    nextSlot: 40,
    registeredSupply: 200,
    eventEndTs: NOW + 86_400,
    cancelled: false,
    termsNonce: 3n,
    seated: false,
    ...over,
  };
}

interface Fake {
  io: Ledger2ClientIO;
  chain: Map<string, SeriesRead>;
  relayed: Ledger2RelayRequest[];
  relay: (req: Ledger2RelayRequest) => Promise<Ledger2RelayResult>;
  keysDerived: Uint8Array[];
  digestFor: (a: Ledger2Action) => string;
}

function fake(): Fake {
  const f: Fake = {
    chain: new Map([[ID_A, read()], [ID_B, read()]]),
    relayed: [],
    relay: async () => ({ status: "landed", txHash: "0x1", landed: [true] }),
    keysDerived: [],
    digestFor: (a) => ledger2Digest(TARGET, a),
    io: undefined as unknown as Ledger2ClientIO,
  };
  f.io = {
    deployment: async () => TARGET,
    readSeries: async (_l, ids) => ids.map((id) => f.chain.get(id) ?? null),
    chainNow: async () => NOW,
    chainDigest: async (_l, a) => f.digestFor(a),
    organiserKey: async () => {
      const pk = hexToBytes(key.privateKey.slice(2));
      f.keysDerived.push(pk);
      return { privateKey: pk, address: key.address.toLowerCase() };
    },
    relay: async (_e, req) => {
      f.relayed.push(req);
      return f.relay(req);
    },
    sleep: async () => {},
  };
  return f;
}

const codeErr = (code: string) => Object.assign(new Error(code), { code });

test("reads only this account's ticket types on the ledger; nothing at all before a deployment", async () => {
  const f = fake();
  f.chain.set(ID_B, read({ organiser: "0x00000000000000000000000000000000000000ee" }));
  const view = await readLedger2Event(EVENT, PARENT.toUpperCase().replace("0X", "0x"), f.io);
  assert.deepEqual(view?.series.map((s) => s.seriesId), ["a"]);
  assert.equal(view?.chainNow, NOW);

  const g = fake();
  g.io.deployment = async () => null;
  assert.equal(await readLedger2Event(EVENT, PARENT, g.io), null);
  const h = fake();
  h.chain.clear();
  assert.equal(await readLedger2Event(EVENT, PARENT, h.io), null, "ids from another contract are not on this ledger");
});

test("signs at the view's nonce, on the chain clock, and zeroes the key", async () => {
  const f = fake();
  const view = (await readLedger2Event(EVENT, PARENT, f.io))!;
  const [item] = await signTermsChanges(view, [{ kind: "setSupply", seriesId: "a", supply: 120 }], f.io);
  assert.equal(item!.issuedAt, NOW - 900);
  assert.equal(item!.deadline, NOW + 3600);
  const action: Ledger2Action = { kind: "setSupply", eventId: ID_A, supply: 120, nonce: 3n, issuedAt: item!.issuedAt, deadline: item!.deadline };
  assert.equal(recoverLedger2Signer(TARGET, action, item!.sig), key.address.toLowerCase());
  assert.ok(f.keysDerived[0]!.every((b) => b === 0), "key zeroed");
});

test("a digest that disagrees with the ledger's own refuses to sign - the key is never derived", async () => {
  const f = fake();
  f.digestFor = () => `0x${"00".repeat(32)}`;
  const view = (await readLedger2Event(EVENT, PARENT, f.io))!;
  await assert.rejects(signTermsChanges(view, [{ kind: "cancel", seriesId: "a" }], f.io), (e: Ledger2ChangeError) => e.code === "digest_mismatch");
  assert.equal(f.keysDerived.length, 0);
});

test("a device whose key is not the event's current key does not sign", async () => {
  const f = fake();
  f.chain.set(ID_A, read({ organiserKey: "0x00000000000000000000000000000000000000ff" }));
  const view = (await readLedger2Event(EVENT, PARENT, f.io))!;
  await assert.rejects(signTermsChanges(view, [{ kind: "cancel", seriesId: "a" }], f.io), (e: Ledger2ChangeError) => e.code === "key_moved");
  assert.ok(f.keysDerived[0]!.every((b) => b === 0), "zeroed on the refusal too");
});

async function start(f: Fake, changes = [{ kind: "setSupply" as const, seriesId: "a", supply: 120 }]) {
  const phases: ChangePhase[] = [];
  const view = (await readLedger2Event(EVENT, PARENT, f.io))!;
  const s = await startTermsChange(EVENT, PARENT, view, changes, f.io, (p) => phases.push(p));
  return { ...s, phases };
}

test("saving: a request with no verdict is retried, then the answer is read from the receipt", async () => {
  const f = fake();
  let n = 0;
  f.relay = async () => {
    if (n++ < 2) throw codeErr("relay_failed");
    return { status: "landed", txHash: "0x1", landed: [true] };
  };
  const { done, phases } = await start(f);
  await done;
  assert.equal(f.relayed.length, 3);
  assert.deepEqual(phases.map((p) => p.phase), ["saving", "saved"]);
});

test("saving: a relay that stays unavailable is given up after a few tries, not an hour", async () => {
  const f = fake();
  f.relay = async () => {
    throw codeErr("relay_unavailable");
  };
  const { done, phases } = await start(f);
  await done;
  assert.equal(f.relayed.length, 8);
  assert.equal(phases.at(-1)!.phase, "failed");
});

test("saving: a refusal is final; the chain decides whether it had saved anyway", async () => {
  const f = fake();
  f.relay = async () => {
    throw Object.assign(new Error("x"), { code: "supply_below_sold_or_held", body: { minSupply: 55, held: 15, holdsExpireBy: "2027-01-01T14:32:00.000Z" } });
  };
  const { done, phases } = await start(f);
  await done;
  assert.equal(f.relayed.length, 1);
  const last = phases.at(-1)!;
  assert.equal(last.phase, "failed");
  assert.match((last as { message: string }).message, /baskets.*lowest you can set is 55/);

  const g = fake();
  g.relay = async () => {
    g.chain.set(ID_A, read({ totalSupply: 120, termsNonce: 4n }));
    throw codeErr("signature_stale");
  };
  const r = await start(g);
  await r.done;
  assert.equal(r.phases.at(-1)!.phase, "saved", "already on chain = saved");
});

test("saving: a terms write that did not land on one series reads as partly saved", async () => {
  const f = fake();
  f.relay = async () => ({ status: "landed", txHash: "0x1", landed: [true, false] });
  const { done, phases } = await start(f, [
    { kind: "setSupply", seriesId: "a", supply: 120 },
    { kind: "setSupply", seriesId: "b", supply: 150 },
  ]);
  await done;
  assert.deepEqual(phases.at(-1), { phase: "partly_saved", landed: ["a"] });
});

test("Cancel while saving: a revoke at the SAME nonce, and nothing changed", async () => {
  const f = fake();
  let release: (() => void) | null = null;
  f.relay = (req) =>
    req.items[0]!.kind === "revoke"
      ? Promise.resolve({ status: "landed", txHash: "0x2", landed: [true] })
      : new Promise((_, reject) => {
          release = () => reject(codeErr("relay_failed"));
        });
  const { change, done, phases } = await start(f);
  await new Promise((r) => setImmediate(r));
  const cancelling = change.cancel();
  release!();
  await Promise.all([cancelling, done]);
  const revoke = f.relayed.find((r) => r.items[0]!.kind === "revoke")!;
  assert.ok(revoke, "a revoke was sent");
  const action: Ledger2Action = { kind: "revoke", eventId: ID_A, nonce: 3n, issuedAt: revoke.items[0]!.issuedAt, deadline: revoke.items[0]!.deadline };
  assert.equal(recoverLedger2Signer(TARGET, action, revoke.items[0]!.sig), key.address.toLowerCase(), "signed at the change's nonce");
  assert.deepEqual(phases.map((p) => p.phase), ["saving", "cancelling", "cancelled"]);
});

test("Cancel whose revoke was sent but did not land (the change landed between) is NOT 'cancelled'", async () => {
  const f = fake();
  let failNext: (() => void) | null = null;
  f.relay = (req) => {
    if (req.items[0]!.kind === "revoke") {
      // The change landed first: the revoke's call failed inside the batch.
      f.chain.set(ID_A, read({ totalSupply: 120, termsNonce: 4n }));
      return Promise.resolve({ status: "landed", txHash: "0x2", landed: [false] });
    }
    return new Promise((_, reject) => (failNext = () => reject(codeErr("relay_failed"))));
  };
  const { change, done, phases } = await start(f);
  await new Promise((r) => setImmediate(r));
  const cancelling = change.cancel();
  failNext!();
  await Promise.all([cancelling, done]);
  assert.equal(phases.at(-1)!.phase, "already_saved");
  assert.equal(phases.filter((p) => p.phase === "cancelled").length, 0);
});

test("Cancel during the slow-receipt watch: the cancel's answer stands, nothing overwrites it", async () => {
  const f = fake();
  let watching: (() => void) | null = null;
  f.relay = (req) =>
    req.items[0]!.kind === "revoke"
      ? Promise.resolve({ status: "landed", txHash: "0x2", landed: [true] })
      : Promise.resolve({ status: "unconfirmed", txHash: "0x1" });
  const sleep = f.io.sleep;
  f.io.sleep = (ms) => (ms === 5_000 ? new Promise<void>((r) => (watching = r)) : sleep(ms));
  const { change, done, phases } = await start(f);
  while (!watching) await new Promise((r) => setImmediate(r));
  await change.cancel();
  watching!();
  await done;
  assert.deepEqual(phases.map((p) => p.phase), ["saving", "cancelling", "cancelled"]);
});

test("Cancel while a request is in flight that lands on only some ticket types", async () => {
  const f = fake();
  let resolve: (() => void) | null = null;
  f.relay = () => new Promise((r) => (resolve = () => r({ status: "landed", txHash: "0x1", landed: [true, false] })));
  const { change, done, phases } = await start(f, [
    { kind: "setSupply", seriesId: "a", supply: 120 },
    { kind: "setSupply", seriesId: "b", supply: 150 },
  ]);
  await new Promise((r) => setImmediate(r));
  const cancelling = change.cancel();
  resolve!();
  await Promise.all([cancelling, done]);
  assert.deepEqual(phases.at(-1), { phase: "partly_saved", landed: ["a"] });
});

test("Cancel too late: the request in flight landed first", async () => {
  const f = fake();
  let resolve: (() => void) | null = null;
  f.relay = () => new Promise((r) => (resolve = () => r({ status: "landed", txHash: "0x1", landed: [true] })));
  const { change, done, phases } = await start(f);
  await new Promise((r) => setImmediate(r));
  const cancelling = change.cancel();
  resolve!();
  await Promise.all([cancelling, done]);
  assert.equal(phases.at(-1)!.phase, "already_saved");
  assert.equal(f.relayed.filter((r) => r.items[0]!.kind === "revoke").length, 0);
});

test("Cancel after the nonce moved: our values present = already saved, else changed elsewhere", async () => {
  for (const [supply, expect] of [[120, "already_saved"], [130, "changed_elsewhere"]] as const) {
    const f = fake();
    let failNext: (() => void) | null = null;
    f.relay = () => new Promise((_, reject) => (failNext = () => reject(codeErr("relay_failed"))));
    const { change, done, phases } = await start(f);
    await new Promise((r) => setImmediate(r));
    f.chain.set(ID_A, read({ totalSupply: supply, termsNonce: 4n }));
    const cancelling = change.cancel();
    failNext!();
    await Promise.all([cancelling, done]);
    assert.equal(phases.at(-1)!.phase, expect);
  }
});

test("Cancel whose revoke meets a moved nonce reads the chain afterwards", async () => {
  const f = fake();
  let failNext: (() => void) | null = null;
  f.relay = (req) => {
    if (req.items[0]!.kind === "revoke") {
      f.chain.set(ID_A, read({ totalSupply: 120, termsNonce: 4n }));
      return Promise.reject(codeErr("nonce_moved"));
    }
    return new Promise((_, reject) => (failNext = () => reject(codeErr("relay_failed"))));
  };
  const { change, done, phases } = await start(f);
  await new Promise((r) => setImmediate(r));
  const cancelling = change.cancel();
  failNext!();
  await Promise.all([cancelling, done]);
  assert.equal(phases.at(-1)!.phase, "already_saved");
});

test("Cancel on a device whose account key moved says so, not 'changed elsewhere'", async () => {
  const f = fake();
  let failNext: (() => void) | null = null;
  f.relay = () => new Promise((_, reject) => (failNext = () => reject(codeErr("relay_failed"))));
  const { change, done, phases } = await start(f);
  await new Promise((r) => setImmediate(r));
  f.chain.set(ID_A, read({ organiserKey: "0x00000000000000000000000000000000000000ff", termsNonce: 4n }));
  const cancelling = change.cancel();
  failNext!();
  await Promise.all([cancelling, done]);
  assert.deepEqual(phases.at(-1), { phase: "failed", message: "Your account's keys changed on another device. Reload this page.", code: "key_moved" });
});

test("organiser-facing copy never mentions the chain, a signature or a revoke", () => {
  const codes = [
    "supply_below_sold_or_held", "supply_above_registered", "supply_unchanged", "sales_closed", "event_cancelled",
    "already_cancelled", "sales_end_not_later", "sales_end_too_far", "signature_stale", "nonce_moved", "key_moved",
    "rate_limited", "not_available", "relay_failed", "in_flight", "chain_unverified", "whatever",
  ];
  for (const code of codes) {
    const m = messageFor({ code, body: { minSupply: 5, held: 2, holdsExpireBy: "2027-01-01T00:00:00Z", max: 9, sold: 3 } });
    assert.doesNotMatch(m, /chain|ledger|revoke|signature|sign(ed)? |nonce|relay|gas|blockchain|onchain/i, `${code}: ${m}`);
  }
});
