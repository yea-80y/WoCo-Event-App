/**
 * The browser's wiring of the chain scan for an account's ledger v2 events
 * (src/lib/keyring/organiser-event-scan.ts): each page tried on every endpoint in turn,
 * the registrant filter sent in the query, and an unreadable chain reported as
 * incomplete - never as "no events" (#186, no platform index on this path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scanOwnLedger2Events, type ScanClient } from "../src/lib/keyring/organiser-event-scan.ts";

const LEDGER = "0x" + "1e".repeat(20);
const ORG = "0x" + "a1".repeat(20);
const SPONSOR = "0x" + "5a".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");

type Call = { event: string; args?: Record<string, unknown>; from: bigint; to: bigint };

function client(opts: { head?: bigint; failLogs?: boolean; failHead?: boolean; ids?: string[] }, calls: Call[]): ScanClient {
  return {
    async getBlockNumber() {
      if (opts.failHead) throw new Error("head unreadable");
      return opts.head ?? 100n;
    },
    async getLogs(a) {
      const name = (a.event as { name: string }).name;
      calls.push({ event: name, args: a.args, from: a.fromBlock, to: a.toBlock });
      if (opts.failLogs) throw new Error("logs unreadable");
      if (name === "SponsorAdded") return [{ args: { sponsor: SPONSOR } }];
      return (opts.ids ?? []).map((eventId) => ({ args: { eventId } }));
    },
  };
}

test("a page refused by the first endpoint is read from the next; the filter rides in the query", async () => {
  const calls: Call[] = [];
  const res = await scanOwnLedger2Events(ORG, { address: LEDGER, deployBlock: 40 }, [
    client({ failLogs: true }, calls),
    client({ ids: [id(1), id(2)] }, calls),
  ]);
  assert.deepEqual(res, { ids: [id(1), id(2)], complete: true });
  const reg = calls.filter((c) => c.event === "Registered");
  assert.ok(reg.length >= 2, "the Registered page was not retried on the second endpoint");
  const sent = reg.at(-1)!;
  assert.equal(sent.args?.organiser, ORG);
  assert.deepEqual([...(sent.args?.registrant as string[])].sort(), [ORG, SPONSOR.toLowerCase()].sort());
  assert.equal(sent.from, 40n);
  assert.equal(sent.to, 100n);
});

test("every endpoint refusing: incomplete, never 'no events'", async () => {
  const calls: Call[] = [];
  const res = await scanOwnLedger2Events(ORG, { address: LEDGER, deployBlock: 0 }, [
    client({ failLogs: true }, calls),
    client({ failLogs: true }, calls),
  ]);
  assert.equal(res.complete, false);
  assert.deepEqual(res.ids, []);
});

test("no head from any endpoint: incomplete, and nothing thrown at the caller", async () => {
  const res = await scanOwnLedger2Events(ORG, { address: LEDGER, deployBlock: 0 }, [
    client({ failHead: true }, []),
    client({ failHead: true }, []),
  ]);
  assert.deepEqual(res, { ids: [], complete: false });
});

test("the head comes from the next endpoint when the first cannot give one", async () => {
  const calls: Call[] = [];
  const res = await scanOwnLedger2Events(ORG, { address: LEDGER, deployBlock: 0 }, [
    client({ failHead: true, ids: [id(9)] }, calls),
    client({ head: 77n, ids: [id(9)] }, calls),
  ]);
  assert.equal(res.complete, true);
  assert.ok(calls.every((c) => c.to === 77n), "a page did not stop at the one head snapshot");
});
