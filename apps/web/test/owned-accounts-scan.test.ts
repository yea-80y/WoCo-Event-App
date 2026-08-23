/**
 * The cross-device owner scan (#234): paging that never returns a partial answer,
 * a tri-state per-hit re-read that aborts on any error, and the pinned event topic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toEventSelector } from "viem";
import {
  OWNER_REGISTERED_TOPIC,
  OWNER_SCAN_FLOOR_BLOCK,
  scanOwnedAccounts,
  type OwnedAccountsScanIO,
} from "../src/lib/auth/owned-accounts-scan.js";

const EOA = "0x" + "aa".repeat(20);
const TARGET = "0x" + "01".repeat(20);
const CF = "0x" + "02".repeat(20);
const K3 = "0x" + "03".repeat(20);
const K4 = "0x" + "04".repeat(20);

test("the event topic is keccak256('OwnerRegistered(address,address)')", () => {
  assert.equal(toEventSelector("OwnerRegistered(address indexed kernel, address indexed owner)"), OWNER_REGISTERED_TOPIC);
});

function io(over: Partial<OwnedAccountsScanIO> & { logs?: Record<string, string[]>; owners?: Record<string, string | null | "error"> } = {}): OwnedAccountsScanIO & { pages: Array<[bigint, bigint]>; reads: string[] } {
  const pages: Array<[bigint, bigint]> = [];
  const reads: string[] = [];
  return {
    pages,
    reads,
    head: over.head ?? (async () => OWNER_SCAN_FLOOR_BLOCK + 25n), // tiny range: pages of 10 → 3 pages
    getOwnerRegisteredKernels:
      over.getOwnerRegisteredKernels ??
      (async (from, to) => {
        pages.push([from, to]);
        return over.logs?.[`${from}`] ?? [];
      }),
    readOwner:
      over.readOwner ??
      (async (k) => {
        reads.push(k);
        return over.owners?.[k] ?? null;
      }),
    sleep: async () => {},
  };
}

test("clean: pages cover [floor, head] exactly, once each, and excluded kernels are not re-read", async () => {
  const f = OWNER_SCAN_FLOOR_BLOCK;
  const t = io({ logs: { [`${f}`]: [TARGET, CF] } });
  const pagesSeen: Array<[number, number]> = [];
  const r = await scanOwnedAccounts({
    eoa: EOA,
    exclude: [TARGET, CF.toUpperCase().replace("0X", "0x"), null, undefined],
    io: t,
    pageBlocks: 10n,
    onPage: (d, n) => pagesSeen.push([d, n]),
  });
  assert.deepEqual(t.pages, [[f, f + 9n], [f + 10n, f + 19n], [f + 20n, f + 25n]]);
  assert.deepEqual(pagesSeen, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(t.reads, []);
  assert.deepEqual(r, { status: "clean", head: f + 25n, pages: 3 });
});

test("collision: a hit whose CURRENT owner is the credential; a stale hit (owner moved / unset) is not", async () => {
  const f = OWNER_SCAN_FLOOR_BLOCK;
  const t = io({
    logs: { [`${f}`]: [K3], [`${f + 10n}`]: [K4, K3] },
    owners: { [K3]: EOA.toUpperCase().replace("0X", "0x"), [K4]: "0x" + "ff".repeat(20) },
  });
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [TARGET, CF], io: t, pageBlocks: 10n });
  assert.deepEqual(r, { status: "collision", head: f + 25n, kernels: [K3] });
  // de-duplicated: K3 appeared twice in the logs, read once
  assert.deepEqual(t.reads.sort(), [K3, K4].sort());
});

test("a failed owner re-read on ANY hit aborts the whole check as unknown — never a partial clean", async () => {
  const f = OWNER_SCAN_FLOOR_BLOCK;
  const t = io({ logs: { [`${f}`]: [K3, K4] }, owners: { [K3]: null, [K4]: "error" } });
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: t, pageBlocks: 10n });
  assert.equal(r.status, "unknown");
});

test("a log page that keeps failing aborts as unknown after retries; a page that fails once then succeeds is fine", async () => {
  let calls = 0;
  const flaky = io({
    getOwnerRegisteredKernels: async (from) => {
      calls++;
      if (from === OWNER_SCAN_FLOOR_BLOCK + 10n && calls < 3) throw new Error("429");
      return [];
    },
  });
  const ok = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: flaky, pageBlocks: 10n });
  assert.equal(ok.status, "clean");

  const dead = io({ getOwnerRegisteredKernels: async () => { throw new Error("timeout"); } });
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: dead, pageBlocks: 10n });
  assert.equal(r.status, "unknown");
  if (r.status === "unknown") assert.match(r.reason, /after 3 attempts/);
});

test("the head is snapshotted once: an advancing chain does not extend the scan", async () => {
  let h = OWNER_SCAN_FLOOR_BLOCK + 25n;
  const t = io({ head: async () => h++ });
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: t, pageBlocks: 10n });
  assert.equal(r.status, "clean");
  if (r.status === "clean") assert.equal(r.head, OWNER_SCAN_FLOOR_BLOCK + 25n);
  assert.equal(t.pages.length, 3);
});

test("tail re-scan: an explicit fromBlock/toBlock window is honoured (one page)", async () => {
  const t = io({});
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: t, fromBlock: 1_000n, toBlock: 1_500n, pageBlocks: 10_000n });
  assert.deepEqual(t.pages, [[1_000n, 1_500n]]);
  assert.equal(r.status, "clean");
});

test("a head read failure is unknown; a from above head is trivially clean", async () => {
  const r = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: io({ head: async () => { throw new Error("rpc down"); } }) });
  assert.equal(r.status, "unknown");
  const r2 = await scanOwnedAccounts({ eoa: EOA, exclude: [], io: io({}), fromBlock: OWNER_SCAN_FLOOR_BLOCK + 100n });
  assert.deepEqual(r2, { status: "clean", head: OWNER_SCAN_FLOOR_BLOCK + 25n, pages: 0 });
});
