/**
 * Finding an account's ledger v2 events from the chain alone (src/ticket/ledger2-scan.ts)
 * and planning which move onto a new organiser key (src/ticket/ledger2.ts): the
 * passkey-removal path that must not depend on the platform's index (#186).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanOrganiserEvents, type OrganiserEventScanIO } from "../src/ticket/ledger2-scan.js";
import { planOrganiserKeyMoves, parseLedger2Override, organiserKeyStatesFrom, type OrganiserKeyEventState } from "../src/ticket/ledger2.js";
import { LOG_SCAN_WINDOW, logScanWindows } from "../src/chain/log-windows.js";

const ORG = "0x" + "a1".repeat(20);
const SPONSOR_OLD = "0x" + "5a".repeat(20);
const SPONSOR_NOW = "0x" + "5b".repeat(20);
const JUNKER = "0x" + "66".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");

interface Reg {
  block: number;
  id: string;
  registrant: string;
}

/** A ledger's logs held in memory; `failPage` makes one window's read throw. */
function fakeLedger(opts: {
  sponsors: Array<{ block: number; sponsor: string }>;
  registrations: Reg[];
  failSponsorPage?: number;
  failRegisteredPage?: number;
}) {
  const seen: Array<{ kind: string; from: number; to: number; registrants?: readonly string[] }> = [];
  let sponsorPage = 0;
  let registeredPage = 0;
  const io: OrganiserEventScanIO = {
    async sponsorsAdded(from, to) {
      seen.push({ kind: "sponsors", from, to });
      if (sponsorPage++ === opts.failSponsorPage) throw new Error("rpc down");
      return opts.sponsors.filter((s) => s.block >= from && s.block <= to).map((s) => s.sponsor.toUpperCase());
    },
    async registered(organiser, registrants, from, to) {
      seen.push({ kind: "registered", from, to, registrants });
      if (registeredPage++ === opts.failRegisteredPage) throw new Error("rpc down");
      assert.equal(organiser, ORG);
      return opts.registrations
        .filter((r) => r.block >= from && r.block <= to && registrants.includes(r.registrant))
        .map((r) => r.id);
    },
  };
  return { io, seen };
}

test("log windows cover start..latest, none wider than the public RPC allows", () => {
  const w = logScanWindows(100, 100 + 2 * LOG_SCAN_WINDOW + 5);
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], [100, 100 + LOG_SCAN_WINDOW - 1]);
  assert.equal(w.at(-1)![1], 100 + 2 * LOG_SCAN_WINDOW + 5);
  for (const [from, to] of w) assert.ok(to - from + 1 <= LOG_SCAN_WINDOW);
  assert.deepEqual(logScanWindows(5, 4), []);
});

test("the registrant filter: sponsors ever added and the account itself, never a stranger", async () => {
  const { io, seen } = fakeLedger({
    sponsors: [
      { block: 10, sponsor: SPONSOR_OLD },
      { block: LOG_SCAN_WINDOW + 20, sponsor: SPONSOR_NOW },
    ],
    registrations: [
      { block: 11, id: id(1), registrant: SPONSOR_OLD },
      { block: 12, id: id(2), registrant: JUNKER },
      { block: LOG_SCAN_WINDOW + 30, id: id(3), registrant: SPONSOR_NOW },
      { block: LOG_SCAN_WINDOW + 31, id: id(4), registrant: ORG },
      { block: LOG_SCAN_WINDOW + 32, id: id(1), registrant: SPONSOR_OLD },
    ],
  });
  const res = await scanOrganiserEvents(io, ORG.toUpperCase(), 0, LOG_SCAN_WINDOW + 40);
  assert.equal(res.complete, true);
  assert.deepEqual(res.ids.sort(), [id(1), id(3), id(4)]);
  // A sponsor added in a LATER window still filters registrations in an earlier one:
  // the sponsor set is read whole before any Registered page.
  const firstRegistered = seen.findIndex((s) => s.kind === "registered");
  assert.ok(seen.slice(0, firstRegistered).every((s) => s.kind === "sponsors"));
  const registrants = seen.find((s) => s.kind === "registered")!.registrants!;
  assert.deepEqual([...registrants].sort(), [ORG, SPONSOR_NOW, SPONSOR_OLD].sort());
});

test("a Registered page that cannot be read: what was found, marked incomplete", async () => {
  const { io } = fakeLedger({
    sponsors: [{ block: 10, sponsor: SPONSOR_OLD }],
    registrations: [
      { block: 11, id: id(1), registrant: SPONSOR_OLD },
      { block: LOG_SCAN_WINDOW + 5, id: id(2), registrant: SPONSOR_OLD },
    ],
    failRegisteredPage: 1,
  });
  const res = await scanOrganiserEvents(io, ORG, 0, LOG_SCAN_WINDOW + 10);
  assert.equal(res.complete, false);
  assert.deepEqual(res.ids, [id(1)]);
});

test("a sponsor page that cannot be read makes the scan incomplete too", async () => {
  const { io } = fakeLedger({
    sponsors: [{ block: 10, sponsor: SPONSOR_OLD }],
    registrations: [
      { block: 11, id: id(1), registrant: SPONSOR_OLD },
      { block: 12, id: id(2), registrant: ORG },
    ],
    failSponsorPage: 0,
  });
  const res = await scanOrganiserEvents(io, ORG, 0, 100);
  assert.equal(res.complete, false);
  // The sponsor's registration is hidden; the account's own still found.
  assert.deepEqual(res.ids, [id(2)]);
});

test("ids are lowercased, deduplicated, and malformed ones dropped", async () => {
  const io: OrganiserEventScanIO = {
    sponsorsAdded: async () => ["not-an-address"],
    registered: async () => [id(7).toUpperCase().replace("0X", "0x"), id(7), "0x1234"],
  };
  const res = await scanOrganiserEvents(io, ORG, 0, 10);
  assert.deepEqual(res, { ids: [id(7)], complete: true });
});

function st(n: number, over: Partial<OrganiserKeyEventState> = {}): OrganiserKeyEventState {
  return { id: id(n), organiser: ORG, key: "0x" + "01".repeat(20), eventEndTs: 2_000, cancelled: false, nextSlot: 0, ...over };
}

test("the plan: the account's own, not cancelled, not already moved; on sale first, busiest first, ended last", () => {
  const NEW = "0x" + "0e".repeat(20);
  const now = 1_000;
  const plan = planOrganiserKeyMoves(
    [
      st(1, { eventEndTs: 500 }), // ended: last
      st(2, { nextSlot: 3 }),
      st(3, { nextSlot: 40 }), // busiest on-sale: first
      st(4, { cancelled: true }),
      st(5, { key: NEW }), // already moved
      st(6, { organiser: JUNKER }),
      st(7, { nextSlot: 0 }),
    ],
    ORG.toUpperCase(),
    NEW.toUpperCase(),
    now,
  );
  assert.deepEqual(plan, [id(3), id(2), id(7), id(1)]);
});

test("live states: an unknown id is left out, any other failed read is 'error', never 'nothing to move'", () => {
  const KEY = "0x" + "ee".repeat(20);
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const fail = (error: unknown) => ({ status: "failure" as const, error });
  const NOT_FOUND = { name: "EventNotFound" };
  const isNotFound = (e: unknown) => e === NOT_FOUND;
  const known = [ok([10n, 4n, ORG.toUpperCase(), "0x" + "00".repeat(32)]), ok([900n, false]), ok(KEY.toUpperCase())];

  assert.deepEqual(organiserKeyStatesFrom([id(1), id(2)], [...known, fail(NOT_FOUND), fail(NOT_FOUND), fail(NOT_FOUND)], isNotFound), [
    { id: id(1), organiser: ORG, key: KEY, eventEndTs: 900, cancelled: false, nextSlot: 4 },
  ]);
  const rpcDown = new Error("timeout");
  assert.equal(organiserKeyStatesFrom([id(1), id(2)], [...known, fail(rpcDown), ok([0n, false]), ok(KEY)], isNotFound), "error");
  assert.equal(organiserKeyStatesFrom([id(1)], [known[0]!, fail(NOT_FOUND), known[2]!], isNotFound), "error", "only getEvent's not-found skips");
  assert.equal(organiserKeyStatesFrom([id(1), id(2)], known, isNotFound), "error", "a short answer is never read as whole");
});

test("the override: address, or address:deployBlock; anything else ignored", () => {
  const a = "0x" + "ab".repeat(20);
  assert.deepEqual(parseLedger2Override(a), { address: a, deployBlock: 0 });
  assert.deepEqual(parseLedger2Override(` ${a.toUpperCase().replace("0X", "0x")}:12345 `), { address: a, deployBlock: 12345 });
  assert.equal(parseLedger2Override(`${a}:abc`), null);
  assert.equal(parseLedger2Override("0x1234"), null);
  assert.equal(parseLedger2Override(""), null);
  assert.equal(parseLedger2Override(undefined), null);
});
