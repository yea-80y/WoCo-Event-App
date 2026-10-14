/**
 * The automatic add of opted-in ticket buyers (owner decision 2026-10-14) - every
 * decision `runAudienceSync` makes, against fakes. The legal rules first: nobody
 * who said no is ever added, nobody the organiser deleted comes back, and a
 * background write never replaces a newer list with a stale one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { EventDirectoryEntry, MarketingCheckResult, MarketingListPayload, OrderEntry, OrderField } from "@woco/shared";
import {
  runAudienceSync,
  createSyncGate,
  createLock,
  watermarkStore,
  describeSync,
  addRemoved,
  clearRemoved,
  normaliseRemoved,
  listPayload,
  removedId,
  saveListChange,
  isListChanged,
  type ListSaveDeps,
  SETTLE_MS,
  STALE_MS,
  SYNC_INTERVAL_MS,
  type SyncDeps,
  type SyncResult,
} from "../src/lib/creator/audience/audience-sync.js";

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const FIELDS: OrderField[] = [
  { id: "f1", type: "text", label: "First Name", required: true, keepOnList: true },
  { id: "f2", type: "text", label: "Allergies", required: false, health: true, keepOnList: true },
];

type Claim = { claimerEmail?: string; fields?: Record<string, string> };
type Box = { claim?: Claim; bad?: true; sealed?: MarketingListPayload };

const order = (claim: Claim | "bad", seriesId = "s1"): OrderEntry => ({
  seriesId,
  seriesName: "GA",
  edition: 1,
  claimerAddress: "0x0",
  claimedAt: "",
  encryptedOrder: (claim === "bad" ? { bad: true } : { claim }) as unknown as OrderEntry["encryptedOrder"],
});

/** A tombstone as the screen writes it: hashed under the organiser, dated. */
const tomb = (email: string, at = "2026-10-10T00:00:00.000Z") => ({ h: removedId("0xOrg", email), at });

const event = (eventId: string, startDate = "2026-11-01"): EventDirectoryEntry =>
  ({ eventId, title: `Event ${eventId}`, startDate }) as EventDirectoryEntry;

interface World {
  now: number;
  events: EventDirectoryEntry[];
  orders: Record<string, OrderEntry[] | "throw">;
  /** What the cheap count call says, when it differs from the order list (a slot the server could not read). */
  counts?: Record<string, number>;
  fields: Record<string, OrderField[] | "throw">;
  answer: MarketingCheckResult | ((emails: string[]) => MarketingCheckResult | "throw");
  list: { payload: MarketingListPayload; updatedAt: string } | null;
  storage: Map<string, string>;
  locked?: boolean;
  sealLocked?: boolean;
  readFails?: boolean;
  openListFails?: boolean;
  writeFails?: boolean;
  /** The key ring moved on (a passkey removal) between taking the seal key and the upload. */
  keyMoved?: boolean;
  current?: boolean;
  /** Runs when the seal key is taken - "something saved elsewhere" after the re-read. */
  duringSeal?: (w: World) => void;
  /** Runs right after each check call - "an edit made elsewhere" mid-run. */
  duringCheck?: (w: World) => void;
  log: string[];
  writes: Array<{ payload: MarketingListPayload; emails: string[] }>;
}

function world(over: Partial<World> = {}): World {
  return {
    now: T0,
    events: [event("e1")],
    orders: { e1: [order({ claimerEmail: "Ada@X.com", fields: { f1: "Ada", f2: "Peanuts" } })] },
    fields: { e1: FIELDS },
    answer: { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] },
    list: null,
    storage: new Map(),
    log: [],
    writes: [],
    ...over,
  };
}

let stampSeq = 0;
function deps(w: World, extra: Partial<SyncDeps> = {}): SyncDeps {
  const storage = {
    getItem: (k: string) => w.storage.get(k) ?? null,
    setItem: (k: string, v: string) => void w.storage.set(k, v),
  };
  return {
    organiser: "0xOrg",
    async openKeys() {
      w.log.push("openKeys");
      if (w.locked) return null;
      return {
        async openOrder(box) {
          const b = box as unknown as Box;
          if (b.bad) throw new Error("wrong key");
          return b.claim!;
        },
        async openList(box) {
          if (w.openListFails) throw new Error("cannot open");
          return structuredClone((box as unknown as Box).sealed!);
        },
      };
    },
    async sealKeys() {
      w.log.push("sealKeys");
      w.duringSeal?.(w);
      if (w.sealLocked) return null;
      return {
        sealList: async (payload) => ({ sealed: structuredClone(payload) }) as never,
        unchanged: async () => !w.keyMoved,
      };
    },
    async listEvents() {
      w.log.push("listEvents");
      return w.events;
    },
    async listStamp() {
      return w.list?.updatedAt ?? null;
    },
    async orderCount(id) {
      w.log.push(`count:${id}`);
      if (w.counts?.[id] !== undefined) return w.counts[id]!;
      const o = w.orders[id];
      if (o === "throw" || !o) throw new Error("count unavailable");
      return w.counts?.[id] ?? o.length;
    },
    async getOrders(id) {
      w.log.push(`orders:${id}`);
      const o = w.orders[id];
      if (o === "throw" || !o) throw new Error("orders unavailable");
      return o;
    },
    async getOrderFields(ev) {
      w.log.push(`fields:${ev.eventId}`);
      const f = w.fields[ev.eventId];
      if (f === "throw" || !f) throw new Error("event unreadable");
      return f;
    },
    async check(emails) {
      w.log.push(`check:${emails.join(",")}`);
      const a = typeof w.answer === "function" ? w.answer(emails) : w.answer;
      w.duringCheck?.(w);
      if (a === "throw") throw new Error("check failed");
      return a;
    },
    async readList() {
      w.log.push("readList");
      if (w.readFails) throw new Error("swarm read failed");
      return w.list ? { sealedList: { sealed: structuredClone(w.list.payload) } as never, updatedAt: w.list.updatedAt } : null;
    },
    async writeList(sealed, emails, ifUpdatedAt) {
      w.log.push(`writeList:${ifUpdatedAt}`);
      if (w.writeFails) throw new Error("Adding contacts needs a verified Stripe account.");
      // The server's compare-and-swap: a list saved since the caller's re-read is never replaced.
      if (ifUpdatedAt !== (w.list?.updatedAt ?? null)) {
        throw Object.assign(new Error("Your list changed while this was saving, so nothing was overwritten. Try again."), { code: "LIST_CHANGED" });
      }
      const payload = (sealed as unknown as Box).sealed!;
      w.writes.push({ payload, emails });
      const updatedAt = `stamp-${++stampSeq}`;
      w.list = { payload, updatedAt };
      return { count: emails.length, updatedAt, swarmRef: "ab" };
    },
    stillCurrent: () => w.current !== false,
    withLock: createLock(),
    watermark: watermarkStore(storage, "0xOrg"),
    now: () => w.now,
    ...extra,
  };
}

const sync = (w: World, extra?: Partial<SyncDeps>) => runAudienceSync(deps(w, extra));
const emailsOf = (p: MarketingListPayload | undefined) => (p?.contacts ?? []).map((c) => c.email).sort();

// ── Who is added ───────────────────────────────────────────────────────────

test("a buyer with a checkout record is added, with only their kept answers", async () => {
  const w = world();
  const r = await sync(w);
  assert.equal(r.status, "ok");
  assert.equal(r.added, 1);
  assert.equal(w.writes.length, 1);
  const c = w.writes[0]!.payload.contacts[0]!;
  assert.equal(c.email, "ada@x.com");
  assert.equal(c.firstName, "Ada");
  assert.doesNotMatch(JSON.stringify(w.writes[0]!.payload), /Peanuts/, "never a health answer");
  assert.deepEqual(w.writes[0]!.emails, ["ada@x.com"]);
  assert.deepEqual(r.written?.payload, w.writes[0]!.payload);
});

test("soft opt-in buyers are added too; buyers with no record are not", async () => {
  const w = world({
    orders: { e1: [order({ claimerEmail: "soft@x.com" }), order({ claimerEmail: "none@x.com" })] },
    answer: { suppressed: [], alreadyInList: [], consented: [], softOptIn: ["soft@x.com"] },
  });
  await sync(w);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["soft@x.com"]);
});

test("a suppressed address is never added, even when it also holds consent or a soft opt-in", async () => {
  const w = world({
    orders: {
      e1: [order({ claimerEmail: "a@x.com" }), order({ claimerEmail: "b@x.com" }), order({ claimerEmail: "C@x.com" })],
    },
    // A later "no" outranks an earlier yes: unsubscribed, declined, bounced, complained or removed by hand.
    answer: { suppressed: ["a@x.com", "c@x.com"], alreadyInList: [], consented: ["a@x.com", "b@x.com"], softOptIn: ["c@x.com"] },
  });
  const r = await sync(w);
  assert.equal(r.added, 1);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["b@x.com"]);
});

test("a suppressed contact already on the list is not touched either", async () => {
  const w = world({
    answer: { suppressed: ["ada@x.com"], alreadyInList: ["ada@x.com"], consented: ["ada@x.com"], softOptIn: [] },
    list: { payload: { version: 1, contacts: [{ email: "ada@x.com", addedAt: "2026-01-01" }] }, updatedAt: "s0" },
  });
  const r = await sync(w);
  assert.equal(w.writes.length, 0);
  assert.equal(r.updated, 0);
});

// ── Deleted contacts ───────────────────────────────────────────────────────

test("a contact the organiser deleted is not re-added on a consent from before the deletion, or an undated one", async () => {
  for (const consentedAt of [{ "ada@x.com": "2026-10-09T00:00:00.000Z" }, {}]) {
    const w = world({
      orders: { e1: [order({ claimerEmail: "ADA@x.com " })] },
      answer: { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], consentedAt, softOptIn: [] },
      list: { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com")] }, updatedAt: "s0" },
    });
    const r = await sync(w);
    assert.equal(r.added, 0, JSON.stringify(consentedAt));
    assert.equal(w.writes.length, 0, "nothing changed, so nothing is written");
  }
});

test("an \"Email me\" ticked after the deletion brings them back and clears the tombstone", async () => {
  // Fable sign-off 2026-10-14 recommendation: a fresh, explicit yes outranks an old delete.
  const w = world({
    answer: { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], consentedAt: { "ada@x.com": "2026-10-12T09:00:00.000Z" }, softOptIn: [] },
    list: { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com"), tomb("zed@x.com")] }, updatedAt: "s0" },
  });
  const r = await sync(w);
  assert.equal(r.added, 1);
  assert.deepEqual(w.writes[0]!.payload.removed, [tomb("zed@x.com")], "only Ada's tombstone goes");
});

test("a soft opt-in after the deletion does not bring them back", async () => {
  const w = world({
    answer: { suppressed: [], alreadyInList: [], consented: [], softOptIn: ["ada@x.com"] },
    list: { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com")] }, updatedAt: "s0" },
  });
  const r = await sync(w);
  assert.equal(r.added, 0);
  assert.equal(w.writes.length, 0);
});

test("a later consent that is now suppressed does not bring them back either", async () => {
  const w = world({
    answer: { suppressed: ["ada@x.com"], alreadyInList: [], consented: ["ada@x.com"], consentedAt: { "ada@x.com": "2026-10-12T09:00:00.000Z" }, softOptIn: [] },
    list: { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com")] }, updatedAt: "s0" },
  });
  await sync(w);
  assert.equal(w.writes.length, 0);
});

test("the tombstone survives a write that adds someone else", async () => {
  const w = world({
    orders: { e1: [order({ claimerEmail: "ada@x.com" }), order({ claimerEmail: "bo@x.com" })] },
    answer: { suppressed: [], alreadyInList: [], consented: ["ada@x.com", "bo@x.com"], softOptIn: [] },
    list: { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com")] }, updatedAt: "s0" },
  });
  await sync(w);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["bo@x.com"]);
  assert.deepEqual(w.writes[0]?.payload.removed, [tomb("ada@x.com")]);
});

test("adding an address back on purpose clears its tombstone, and then the sync may keep it", async () => {
  const at = "2026-10-10T00:00:00.000Z";
  assert.deepEqual(addRemoved([], "0xORG", " Ada@X.com", at), [tomb("ada@x.com", at)]);
  assert.deepEqual(addRemoved([tomb("ada@x.com", at)], "0xorg", "ADA@x.com", "2026-10-11T00:00:00.000Z"), [tomb("ada@x.com", "2026-10-11T00:00:00.000Z")], "one per contact, the latest deletion");
  const cleared = clearRemoved([tomb("ada@x.com"), tomb("bo@x.com")], "0xOrg", ["ADA@X.COM"]);
  assert.deepEqual(cleared, [tomb("bo@x.com")]);
  const w = world({ list: { payload: { version: 1, contacts: [], removed: cleared }, updatedAt: "s0" } });
  const r = await sync(w);
  assert.equal(r.added, 1);
});

test("a tombstone is keyed under the organiser, never a plain email hash", async () => {
  const { createHash } = await import("node:crypto");
  const id = removedId("0xOrg", "ada@x.com");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, createHash("sha256").update("ada@x.com").digest("hex"));
  assert.notEqual(id, removedId("0xOther", "ada@x.com"), "another organiser's tombstone does not match");
  assert.equal(id, removedId(" 0XORG", " ADA@x.com"));
  assert.doesNotMatch(JSON.stringify(listPayload([], [tomb("ada@x.com")])), /ada/, "the address itself is not stored");
});

test("an older list without the field opens as no tombstones; the payload stays as it was when there are none", () => {
  assert.deepEqual(normaliseRemoved(undefined), []);
  assert.deepEqual(normaliseRemoved([1, "", "a@b.com", null, { h: "zz", at: "2026-01-01" }, { h: "a".repeat(64), at: "nope" }]), []);
  assert.deepEqual(listPayload([], []), { version: 1, contacts: [] });
  assert.deepEqual(listPayload([], [tomb("b@x.com")]), { version: 1, contacts: [], removed: [tomb("b@x.com")] });
});

// ── Read-merge-write ───────────────────────────────────────────────────────

test("the write merges onto the list as re-read just before it, never a stale copy", async () => {
  const w = world({
    list: { payload: { version: 1, contacts: [{ email: "old@x.com", addedAt: "2026-01-01" }] }, updatedAt: "s0" },
    // Another tab saves while this run is reading orders: adds Zed, deletes Ada.
    duringCheck: (x) => {
      x.list = {
        payload: { version: 1, contacts: [{ email: "old@x.com", addedAt: "2026-01-01" }, { email: "zed@x.com", addedAt: "2026-10-14" }], removed: [tomb("ada@x.com")] },
        updatedAt: "s1",
      };
    },
  });
  const r = await sync(w);
  assert.ok(w.log.indexOf("readList") > w.log.findIndex((l) => l.startsWith("check:")), "re-read after the orders were read");
  assert.equal(r.added, 0, "Ada was deleted elsewhere meanwhile");
  assert.equal(w.writes.length, 0);
  assert.deepEqual(emailsOf(w.list!.payload), ["old@x.com", "zed@x.com"], "the other tab's save stands");
});

test("an edit made elsewhere is kept when the sync does write", async () => {
  const w = world({
    list: { payload: { version: 1, contacts: [] }, updatedAt: "s0" },
    duringCheck: (x) => {
      x.list = { payload: { version: 1, contacts: [{ email: "zed@x.com", addedAt: "2026-10-14" }] }, updatedAt: "s1" };
    },
  });
  await sync(w);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["ada@x.com", "zed@x.com"]);
});

test("a failed re-read writes nothing - and neither does a list that will not open", async () => {
  for (const flag of ["readFails", "openListFails"] as const) {
    const w = world({ list: { payload: { version: 1, contacts: [] }, updatedAt: "s0" }, [flag]: true });
    const r = await sync(w);
    assert.equal(r.status, "failed", flag);
    assert.ok(!w.log.some((l) => l.startsWith("writeList")), `${flag}: no write is even attempted`);
    assert.equal(w.writes.length, 0, flag);
    assert.equal(w.storage.size, 0, `${flag}: nothing marked as covered, so the next run tries again`);
  }
});

test("a failed write is reported and marks nothing as covered", async () => {
  const w = world({ writeFails: true });
  const r = await sync(w);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /verified Stripe account/);
  assert.equal(w.storage.size, 0);
});

test("nothing changed = no write, and sealing is never even asked for", async () => {
  const w = world();
  await sync(w);
  w.log.length = 0;
  w.now += SYNC_INTERVAL_MS;
  const r = await sync(w);
  assert.equal(r.status, "ok");
  assert.equal(w.writes.length, 1, "only the first run wrote");
  assert.ok(!w.log.includes("sealKeys"));
});

test("a run never writes one account's buyers into another's list", async () => {
  const w = world({ current: false });
  const r = await sync(w);
  assert.equal(r.status, "failed");
  assert.equal(w.writes.length, 0);
  assert.ok(!w.log.includes("readList"));
});

test("an account switch after the list was read still writes nothing", async () => {
  const w = world();
  let calls = 0;
  const r = await sync(w, { stillCurrent: () => ++calls === 1 });
  assert.equal(r.status, "failed");
  assert.equal(w.writes.length, 0);
  assert.ok(w.log.includes("readList"), "the switch came after the re-read");
});

// ── Races (review 2026-10-14) ──────────────────────────────────────────────

test("someone who unsubscribes while the orders are being read is not added", async () => {
  let calls = 0;
  const w = world({
    answer: () =>
      ++calls === 1
        ? { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] }
        : { suppressed: ["ada@x.com"], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] },
  });
  const r = await sync(w);
  assert.equal(calls, 2, "asked again after the re-read");
  assert.ok(w.log.lastIndexOf("readList") < w.log.findLastIndex((l) => l.startsWith("check:")));
  assert.equal(r.added, 0);
  assert.equal(w.writes.length, 0);
});

test("an address is added only when both answers say yes", async () => {
  // The answer from the scan gates as well as the one just before the write: one
  // suppressed at the scan, or without a record then, waits for a later run.
  let calls = 0;
  const w = world({
    orders: { e1: ["x@x.com", "y@x.com", "z@x.com"].map((e) => order({ claimerEmail: e })) },
    answer: () =>
      ++calls === 1
        ? { suppressed: ["x@x.com"], alreadyInList: [], consented: ["x@x.com", "z@x.com"], softOptIn: [] }
        : { suppressed: [], alreadyInList: [], consented: ["x@x.com", "y@x.com", "z@x.com"], softOptIn: [] },
  });
  await sync(w);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["z@x.com"]);
});

test("no answer to the second check, no write", async () => {
  let calls = 0;
  const w = world({ answer: () => (++calls === 1 ? { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] } : "throw") });
  const r = await sync(w);
  assert.equal(r.status, "failed");
  assert.equal(w.writes.length, 0);
  assert.equal(w.storage.size, 0);
});

test("a delete saved in another tab after the re-read is never undone: refused, then merged onto the newer list", async () => {
  let seals = 0;
  const w = world({
    list: { payload: { version: 1, contacts: [{ email: "zed@x.com", addedAt: "2026-01-01" }] }, updatedAt: "s0" },
    duringSeal: (x) => {
      if (++seals === 1) x.list = { payload: { version: 1, contacts: [], removed: [tomb("zed@x.com")] }, updatedAt: "s1" };
    },
  });
  const r = await sync(w);
  assert.ok(w.log.includes("writeList:s0"), "the first write names the list it merged onto, and is refused");
  assert.ok(w.log.includes("writeList:s1"), "the retry merges onto the newer one");
  assert.equal(r.status, "ok", "a refusal that then succeeds is not a failure");
  assert.equal(r.error, undefined);
  assert.deepEqual(emailsOf(w.list!.payload), ["ada@x.com"], "Zed stays deleted");
  assert.deepEqual(w.list!.payload.removed, [tomb("zed@x.com")]);
});

test("the retry asks again who said yes, from a fresh re-read", async () => {
  let seals = 0;
  let checks = 0;
  const w = world({
    list: { payload: { version: 1, contacts: [] }, updatedAt: "s0" },
    duringSeal: (x) => {
      if (++seals === 1) x.list = { payload: { version: 1, contacts: [] }, updatedAt: "s1" };
    },
    // Ada unsubscribes between the first write attempt and the retry.
    answer: () =>
      ++checks <= 2
        ? { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] }
        : { suppressed: ["ada@x.com"], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] },
  });
  const r = await sync(w);
  assert.equal(w.log.filter((l) => l === "readList").length, 2);
  assert.equal(checks, 3);
  assert.equal(r.added, 0);
  assert.equal(w.writes.length, 0);
});

test("refused twice: reported once, plainly, nothing written, nothing marked", async () => {
  let n = 0;
  const w = world({
    list: { payload: { version: 1, contacts: [] }, updatedAt: "s0" },
    duringSeal: (x) => {
      x.list = { payload: { version: 1, contacts: [] }, updatedAt: `moved-${++n}` };
    },
  });
  const r = await sync(w);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "Your list kept changing while new buyers were being added.");
  assert.equal(w.writes.length, 0);
  assert.equal(w.storage.size, 0);
  assert.equal(w.log.filter((l) => l.startsWith("writeList")).length, 2, "one retry, not a loop");
});

test("a delete in this tab while a sync is reading orders stands", async () => {
  const withLock = createLock();
  let deleted: Promise<void> | undefined;
  const w = world({
    list: { payload: { version: 1, contacts: [{ email: "ada@x.com", addedAt: "2026-01-01" }] }, updatedAt: "s0" },
    // The organiser deletes Ada on the Audience screen mid-run: the screen saves under the tab lock.
    duringCheck: (x) => {
      deleted ??= withLock(async () => {
        await new Promise((r) => setTimeout(r, 20)); // the upload takes a while
        x.list = { payload: { version: 1, contacts: [], removed: [tomb("ada@x.com")] }, updatedAt: "s1" };
      });
    },
  });
  const r = await sync(w, { withLock });
  await deleted;
  assert.equal(r.added, 0);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(w.list!.payload, { version: 1, contacts: [], removed: [tomb("ada@x.com")] });
});

test("the seal key is taken at write time, after the re-read and the second check", async () => {
  const w = world();
  await sync(w);
  const seal = w.log.indexOf("sealKeys");
  assert.ok(seal > w.log.indexOf("readList"));
  assert.ok(seal > w.log.findLastIndex((l) => l.startsWith("check:")));
  assert.ok(seal < w.log.findIndex((l) => l.startsWith("writeList")));
});

test("a key ring that moves on before the upload means no write", async () => {
  // A passkey removal (#186) mid-run: never upload a list sealed to the replaced key.
  const w = world({ keyMoved: true });
  const r = await sync(w);
  assert.equal(r.status, "locked");
  assert.equal(w.writes.length, 0);
  assert.ok(!w.log.some((l) => l.startsWith("writeList")));
  assert.equal(w.storage.size, 0);
});

// ── The Audience screen's own saves (Fable sign-off 2026-10-14) ────────────

function screenSave(w: World): ListSaveDeps {
  const d = deps(w);
  return {
    readList: d.readList,
    openList: async (box) => structuredClone((box as unknown as Box).sealed!),
    sealList: async (payload) => ({ sealed: structuredClone(payload) }) as never,
    writeList: d.writeList,
  };
}

test("a stale tab's edit lands on the list as stored now: a contact deleted elsewhere stays deleted", async () => {
  // This tab opened the list with Zed on it; another tab has since deleted Zed.
  const w = world({ list: { payload: { version: 1, contacts: [{ email: "ada@x.com", addedAt: "2026-01-01" }], removed: [tomb("zed@x.com")] }, updatedAt: "s1" } });
  const edited = { email: "zed@x.com", firstName: "Zed", addedAt: "2026-01-01" };
  await saveListChange(screenSave(w), (list) => ({ ...list, contacts: list.contacts.map((c) => (c.email === edited.email ? edited : c)) }));
  assert.deepEqual(emailsOf(w.list!.payload), ["ada@x.com"], "editing a contact deleted elsewhere does not bring it back");
  assert.deepEqual(w.list!.payload.removed, [tomb("zed@x.com")], "and its tombstone survives");
  assert.ok(w.log.includes("writeList:s1"), "written only if nothing saved since this re-read");
});

test("a delete from a stale tab keeps what others added, and every tombstone", async () => {
  const w = world({
    list: { payload: { version: 1, contacts: [{ email: "ada@x.com", addedAt: "2026-01-01" }, { email: "bo@x.com", addedAt: "2026-10-14" }], removed: [tomb("zed@x.com")] }, updatedAt: "s1" },
  });
  await saveListChange(screenSave(w), (list) => ({
    contacts: list.contacts.filter((c) => c.email !== "ada@x.com"),
    removed: addRemoved(list.removed, "0xOrg", "ada@x.com", "2026-10-14T12:00:00.000Z"),
  }));
  assert.deepEqual(emailsOf(w.list!.payload), ["bo@x.com"]);
  assert.deepEqual(w.list!.payload.removed, [tomb("zed@x.com"), tomb("ada@x.com", "2026-10-14T12:00:00.000Z")]);
});

test("a screen save that loses the race is refused, not written over the newer list", async () => {
  const w = world({
    list: { payload: { version: 1, contacts: [], removed: [tomb("zed@x.com")] }, updatedAt: "s1" },
  });
  const d = screenSave(w);
  const racing: ListSaveDeps = {
    ...d,
    async sealList(payload) {
      w.list = { payload: { version: 1, contacts: [{ email: "new@x.com", addedAt: "2026-10-14" }], removed: [tomb("zed@x.com")] }, updatedAt: "s2" };
      return d.sealList(payload);
    },
  };
  await assert.rejects(saveListChange(racing, (list) => list), (err: unknown) => isListChanged(err));
  assert.equal(w.list!.updatedAt, "s2", "the other save stands");
  assert.equal(w.writes.length, 0);
});

test("a screen save with no list yet says so, and an unreadable list writes nothing", async () => {
  const w = world();
  await saveListChange(screenSave(w), (list) => ({ ...list, contacts: [{ email: "a@x.com", addedAt: "2026-10-14" }] }));
  assert.ok(w.log.includes("writeList:null"));
  const broken = world({ list: { payload: { version: 1, contacts: [] }, updatedAt: "s0" }, readFails: true });
  await assert.rejects(saveListChange(screenSave(broken), (list) => list));
  assert.equal(broken.writes.length, 0);
});

// ── Never prompting ────────────────────────────────────────────────────────

test("a locked account: nothing read, nothing written", async () => {
  const w = world({ locked: true });
  const r = await sync(w);
  assert.equal(r.status, "locked");
  assert.deepEqual(w.log, ["openKeys"]);
  assert.equal(w.writes.length, 0);
});

test("no confirmed key generation to seal with: no write, nothing marked", async () => {
  const w = world({ sealLocked: true });
  const r = await sync(w);
  assert.equal(r.status, "locked");
  assert.equal(w.writes.length, 0);
  assert.equal(w.storage.size, 0);
});

// ── One bad thing costs only itself ────────────────────────────────────────

test("an unreadable event, order or check stops only itself", async () => {
  const yes = ["a@x.com", "c@x.com", "d@x.com", "e@x.com"];
  const w = world({
    events: [event("A", "2026-01-01"), event("B", "2026-02-01"), event("C", "2026-03-01"), event("D", "2026-04-01"), event("E", "2026-05-01")],
    orders: {
      A: "throw",
      B: [order({ claimerEmail: "b@x.com" })],
      C: [order("bad"), order({ claimerEmail: "c@x.com" })],
      D: [order({ claimerEmail: "d@x.com" })],
      E: [order({ claimerEmail: "e@x.com" })],
    },
    fields: { B: "throw", C: [], D: [], E: [] },
    answer: (emails) =>
      emails.includes("d@x.com") ? "throw" : { suppressed: [], alreadyInList: [], consented: yes, softOptIn: [] },
  });
  const r = await sync(w);
  assert.equal(r.status, "partial");
  assert.equal(r.failedEvents, 3);
  assert.equal(r.unreadableOrders, 1);
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["c@x.com", "e@x.com"]);
  const marks = JSON.parse(w.storage.get("woco:audience-sync:0xorg")!).events;
  assert.deepEqual(Object.keys(marks), ["C", "E"], "events that could not be read are read again next run");
  assert.equal(marks.C.unopened, 1, "an order that will not open is remembered, not retried every run");
});

test("an order list that will not load, after the count did, costs only its event", async () => {
  const w = world({
    events: [event("A"), event("B")],
    counts: { A: 1 },
    orders: { A: "throw", B: [order({ claimerEmail: "ada@x.com" })] },
    fields: { A: [], B: [] },
  });
  const r = await sync(w);
  assert.equal(r.failedEvents, 1);
  assert.equal(r.status, "partial");
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["ada@x.com"]);
});

test("a list of events that will not load fails the run, writing nothing", async () => {
  const w = world();
  const r = await sync(w, { listEvents: async () => { throw new Error("offline"); } });
  assert.equal(r.status, "failed");
  assert.equal(w.writes.length, 0);
});

// ── Watermark ──────────────────────────────────────────────────────────────

test("an event is skipped once read with the same order count a settle period apart; a new order reads it again", async () => {
  const w = world();
  await sync(w); // first sight of the count
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  await sync(w); // read again, now settled
  assert.ok(w.log.includes("fields:e1"));
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  await sync(w);
  assert.ok(w.log.includes("count:e1"), "the count is still asked");
  assert.ok(!w.log.includes("orders:e1"), "but an unchanged event costs that one call");
  assert.ok(!w.log.includes("fields:e1"));
  assert.ok(!w.log.some((l) => l.startsWith("check:")));

  (w.orders.e1 as OrderEntry[]).push(order({ claimerEmail: "bo@x.com" }));
  w.answer = { suppressed: [], alreadyInList: [], consented: ["ada@x.com", "bo@x.com"], softOptIn: [] };
  w.now += SYNC_INTERVAL_MS;
  const r = await sync(w);
  assert.equal(r.added, 1);
});

test("a buyer whose choice is recorded a moment after their order shows is still added", async () => {
  // The sale reaches the ledger just before its marketing choice is recorded.
  const w = world({ answer: { suppressed: [], alreadyInList: [], consented: [], softOptIn: [] } });
  await sync(w);
  assert.equal(w.writes.length, 0);
  w.answer = { suppressed: [], alreadyInList: [], consented: ["ada@x.com"], softOptIn: [] };
  w.now += SYNC_INTERVAL_MS;
  const r = await sync(w);
  assert.equal(r.added, 1);
  assert.ok(SYNC_INTERVAL_MS >= SETTLE_MS, "a throttled run is always a settle period later");
});

test("an empty, unreadable or blocked watermark means a full scan", async () => {
  const settled = async (w: World) => {
    await sync(w);
    w.now += SYNC_INTERVAL_MS;
    await sync(w);
    w.now += SYNC_INTERVAL_MS;
    w.log.length = 0;
  };
  const garbage = world();
  await settled(garbage);
  garbage.storage.set("woco:audience-sync:0xorg", "{not json");
  await sync(garbage);
  assert.ok(garbage.log.includes("fields:e1"));

  const blocked = world();
  await settled(blocked);
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  const r = await sync(blocked, { watermark: watermarkStore(throwing, "0xOrg") });
  assert.ok(blocked.log.includes("fields:e1"));
  assert.notEqual(r.status, "failed", "storage trouble never fails the run");
});

test("a watermark of the wrong shape is ignored, mark by mark", async () => {
  const w = world();
  const key = "woco:audience-sync:0xorg";
  const settled = { n: 1, seen: 0, scanned: SETTLE_MS };
  for (const raw of [
    JSON.stringify({ v: 2, list: null, events: { e1: settled } }),
    JSON.stringify({ v: 1, list: null, events: "e1" }),
    JSON.stringify({ v: 1, list: null, events: { e1: { n: "1", seen: 0, scanned: SETTLE_MS } } }),
    JSON.stringify({ v: 1, list: null, events: { e1: { ...settled, unopened: "x" } } }),
  ]) {
    w.storage.set(key, raw);
    w.log.length = 0;
    await sync(w);
    assert.ok(w.log.includes("fields:e1"), raw);
    w.list = null;
    w.writes.length = 0;
  }
  // The right shape is trusted - the control that makes the three above mean something.
  w.storage.set(key, JSON.stringify({ v: 1, list: null, events: { e1: settled } }));
  w.log.length = 0;
  await sync(w);
  assert.ok(!w.log.includes("fields:e1"));
});

test("a list saved elsewhere since the last run means every event is read again", async () => {
  // A stale copy saved over the list could have dropped buyers this sync added.
  const w = world();
  await sync(w);
  w.now += SYNC_INTERVAL_MS;
  await sync(w);
  w.list = { payload: { version: 1, contacts: [] }, updatedAt: "someone-else" };
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  const r = await sync(w);
  assert.ok(w.log.includes("fields:e1"));
  assert.equal(r.added, 1, "the buyer lost to the other save comes back");
});

test("a list stamp that cannot be read trusts no mark", async () => {
  const w = world();
  await sync(w);
  w.now += SYNC_INTERVAL_MS;
  await sync(w);
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  await sync(w, { listStamp: async () => { throw new Error("meta down"); } });
  assert.ok(w.log.includes("fields:e1"));
});

// ── Cost (Fable sign-off 2026-10-14) ───────────────────────────────────────

test("an event past the longest order retention is skipped without a single request", async () => {
  const w = world({
    events: [
      event("old", "2025-08-01"), // ended 14 months ago: 12-month retention + 1 has passed
      { ...event("long", "2025-07-01"), endDate: "2025-10-01" } as EventDirectoryEntry, // ends 12.5 months ago
      event("recent", "2025-11-01"),
    ],
    orders: { old: [order({ claimerEmail: "old@x.com" })], long: [order({ claimerEmail: "long@x.com" })], recent: [order({ claimerEmail: "new@x.com" })] },
    fields: { old: [], long: [], recent: [] },
    answer: { suppressed: [], alreadyInList: [], consented: ["old@x.com", "long@x.com", "new@x.com"], softOptIn: [] },
  });
  await sync(w);
  assert.ok(!w.log.some((l) => l.endsWith(":old")), "no call at all for an event whose answers are all deleted");
  assert.ok(w.log.includes("count:long"), "the end date decides, not the start");
  assert.deepEqual(emailsOf(w.writes[0]?.payload), ["long@x.com", "new@x.com"]);
});

test("an order that will never open does not make its event be read every run", async () => {
  const w = world({ orders: { e1: [order("bad"), order({ claimerEmail: "ada@x.com" })] } });
  const first = await sync(w);
  assert.equal(first.unreadableOrders, 1);
  w.now += SYNC_INTERVAL_MS;
  await sync(w); // settles
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  const third = await sync(w);
  assert.ok(!w.log.includes("orders:e1"), "not re-read while the count stands");
  assert.equal(third.unreadableOrders, 1, "and still reported");
  (w.orders.e1 as OrderEntry[]).push(order({ claimerEmail: "bo@x.com" }));
  w.now += SYNC_INTERVAL_MS;
  w.log.length = 0;
  await sync(w);
  assert.ok(w.log.includes("orders:e1"), "a new sale reads it again");
});

test("a slot the server could not read, or an order it could not download, is read again next run", async () => {
  for (const over of [
    { counts: { e1: 2 } }, // the ledger says two, the order list came back with one
    { orders: { e1: [order({ claimerEmail: "ada@x.com" }), { ...order({}), encryptedOrder: undefined }] } },
  ] as Partial<World>[]) {
    const w = world(over);
    await sync(w);
    const marks = JSON.parse(w.storage.get("woco:audience-sync:0xorg")!).events;
    assert.equal(marks.e1, undefined, JSON.stringify(over));
  }
  // An order erased on request is gone for good, not missing.
  const w = world({ orders: { e1: [order({ claimerEmail: "ada@x.com" }), { ...order({}), encryptedOrder: undefined, erased: true }] } });
  await sync(w);
  assert.ok(JSON.parse(w.storage.get("woco:audience-sync:0xorg")!).events.e1);
});

test("the interval is an hour, kept across reloads; unreadable or future stamps mean run", async () => {
  assert.equal(SYNC_INTERVAL_MS, 60 * 60_000);
  let now = 0;
  const box = new Map<string, number | null>();
  const stamp = { read: () => box.get("t") ?? null, write: (t: number | null) => void box.set("t", t) };
  const ok = async (): Promise<SyncResult> => ({ status: "ok", added: 0, updated: 0, failedEvents: 0, unreadableOrders: 0 });
  const gate = () => createSyncGate<SyncResult>({ minIntervalMs: SYNC_INTERVAL_MS, now: () => now, counts: (r) => r.status !== "locked", stamp });
  await gate().run(false, ok);
  now += SYNC_INTERVAL_MS - 1;
  assert.equal(gate().run(false, ok), null, "a reload (a new gate) honours the last start");
  assert.ok(gate().run(true, ok), "Check now ignores it");
  await new Promise((r) => setTimeout(r, 0));
  now += SYNC_INTERVAL_MS;
  const locked = async (): Promise<SyncResult> => ({ status: "locked", added: 0, updated: 0, failedEvents: 0, unreadableOrders: 0 });
  const before = box.get("t");
  await gate().run(false, locked);
  assert.equal(box.get("t"), before, "a locked run gives the stored start back");
  box.set("t", now + 24 * 3_600_000);
  assert.ok(gate().run(false, ok), "a start in the future (a bad clock) is ignored");
  await new Promise((r) => setTimeout(r, 0));
  const broken = { read: () => { throw new Error("SecurityError"); }, write: () => { throw new Error("SecurityError"); } };
  const g = createSyncGate<SyncResult>({ minIntervalMs: SYNC_INTERVAL_MS, now: () => now, counts: () => true, stamp: broken });
  assert.ok(g.run(false, ok), "storage that throws never blocks a run");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(g.run(false, ok), null, "and this tab still remembers it");
});

// ── Merging across events ──────────────────────────────────────────────────

test("one buyer at two events is one addition, and their last event is the later one", async () => {
  const w = world({
    events: [event("late", "2026-12-01"), event("early", "2026-06-01")],
    orders: {
      late: [order({ claimerEmail: "ada@x.com" })],
      early: [order({ claimerEmail: "ada@x.com", fields: { f1: "Ada" } })],
    },
    // Only the earlier event asked her name: it fills that gap, and is still one new contact.
    fields: { late: [], early: FIELDS },
  });
  const r = await sync(w);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 0, "a new contact is not also an update");
  const c = w.writes[0]!.payload.contacts[0]!;
  assert.equal(c.lastEventName, "Event late");
  assert.equal(c.firstName, "Ada");
});

// ── Throttle and lock ──────────────────────────────────────────────────────

test("throttle: once per window per tab, never two at once, forced by Check now", async () => {
  let now = 0;
  let runs = 0;
  let release!: () => void;
  const gate = createSyncGate<SyncResult>({ minIntervalMs: SYNC_INTERVAL_MS, now: () => now, counts: (r) => r.status !== "locked" });
  const ok = (): SyncResult => ({ status: "ok", added: 0, updated: 0, failedEvents: 0, unreadableOrders: 0 });
  const slow = () => {
    runs++;
    return new Promise<SyncResult>((res) => (release = () => res(ok())));
  };
  const first = gate.run(false, slow);
  assert.ok(first);
  assert.equal(gate.run(true, slow), first, "a run in flight is joined, even when forced");
  release();
  await first;
  assert.equal(runs, 1);
  now += SYNC_INTERVAL_MS - 1;
  assert.equal(gate.run(false, slow), null, "inside the window");
  const forced = gate.run(true, async () => (runs++, ok()));
  await forced;
  assert.equal(runs, 2);
  now += SYNC_INTERVAL_MS;
  await gate.run(false, async () => (runs++, ok()));
  assert.equal(runs, 3);
});

test("throttle: a locked run does not use up the window; a failed one does", async () => {
  let now = 0;
  const gate = createSyncGate<SyncResult>({ minIntervalMs: SYNC_INTERVAL_MS, now: () => now, counts: (r) => r.status !== "locked" });
  const as = (status: SyncResult["status"]) => async (): Promise<SyncResult> => ({ status, added: 0, updated: 0, failedEvents: 0, unreadableOrders: 0 });
  await gate.run(false, as("locked"));
  now += 1;
  assert.ok(gate.run(false, as("failed")), "unlocking a minute later runs at once");
  await new Promise((r) => setTimeout(r, 0));
  now += 1;
  assert.equal(gate.run(false, as("ok")), null);
});

test("lock: one writer at a time, and a failure does not jam it", async () => {
  const withLock = createLock();
  const order: string[] = [];
  let release!: () => void;
  const a = withLock(() => new Promise<void>((r) => (release = () => (order.push("a"), r()))));
  const b = withLock(async () => {
    order.push("b");
    throw new Error("boom");
  });
  const c = withLock(async () => void order.push("c"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, []);
  release();
  await a;
  await assert.rejects(b);
  await c;
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("a save queued behind a sync write sees the sync's list first", async () => {
  const withLock = createLock();
  const w = world();
  const seen: string[] = [];
  let screen: string[] = [];
  let queued: Promise<void> | undefined;
  await sync(w, {
    withLock,
    async writeList(sealed, emails, ifUpdatedAt) {
      // The organiser presses save while the sync is writing.
      queued = withLock(async () => void seen.push(...screen));
      return deps(w).writeList(sealed, emails, ifUpdatedAt);
    },
    published: (payload) => (screen = payload.contacts.map((c) => c.email)),
  });
  await queued;
  assert.deepEqual(seen, ["ada@x.com"]);
});

// ── What the screen says ───────────────────────────────────────────────────

test("the status line: plain words, the last time, how many, and stale or failed said plainly", () => {
  const rec = (over = {}) => ({ at: T0, status: "ok" as const, added: 0, failedEvents: 0, unreadableOrders: 0, ...over });
  assert.equal(describeSync(null, true, T0).text, "Checking your events for new buyers…");
  assert.equal(describeSync(null, false, T0).text, "Not checked on this device yet.");
  assert.equal(describeSync(rec({ added: 3 }), false, T0 + 5 * 60_000).text, "Last checked 5 minutes ago - 3 added.");
  assert.equal(describeSync(rec(), false, T0).text, "Last checked just now - no one new.");
  const stale = describeSync(rec(), false, T0 + STALE_MS + 1);
  assert.equal(stale.text, "Last checked yesterday - no one new. Press Check now to look for new buyers.");
  assert.equal(stale.warn, true);
  const twice = describeSync(rec({ status: "failed", error: "Adding contacts needs a verified Stripe account. Verify in Payments, then try again." }), false, T0);
  assert.equal(twice.text, "Couldn't finish checking just now. Adding contacts needs a verified Stripe account. Verify in Payments, then try again.", "one piece of advice, not two");
  const failed = describeSync(rec({ status: "failed", error: "Adding contacts needs a verified Stripe account" }), false, T0 + 2 * 3_600_000);
  assert.equal(failed.text, "Couldn't finish checking 2 hours ago. Adding contacts needs a verified Stripe account. Press Check now to try again.");
  assert.equal(failed.warn, true);
  const partial = describeSync(rec({ status: "partial", added: 1, failedEvents: 1, unreadableOrders: 2 }), false, T0);
  assert.equal(partial.text, "Last checked just now - 1 added. 1 event couldn't be read, so we'll try again next time. 2 orders couldn't be opened on this device.");
  const waiting = describeSync(rec({ status: "locked" }), false, T0);
  assert.equal(waiting.text, "New buyers are waiting - press Check now to confirm it's you and add them.");
  assert.equal(waiting.warn, true);
  assert.equal(
    describeSync(rec({ status: "locked", manual: true }), false, T0).text,
    "Couldn't confirm it's you, so no one was added yet. Press Check now to try again.",
  );
  for (const r of [stale, failed, partial, waiting, describeSync(rec({ status: "locked", manual: true }), false, T0)]) {
    assert.doesNotMatch(r.text, /[–—]/, "spaced hyphen, never an em or en dash");
  }
});
