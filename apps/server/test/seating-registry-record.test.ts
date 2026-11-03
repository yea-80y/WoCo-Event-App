/**
 * A seated registration's record in `onchain-events.json` (must-survive): the plan is
 * recorded with the id, a malformed seated record fails closed, and seating is fixed
 * at registration. Its own file: the registry resolves `.data` against the working
 * directory when first imported, so nothing may import it before `before` moves there.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIGEST = `0x${"57".repeat(32)}`;
const CHAIN = 42161;
const LEDGER2 = "0x" + "2e".repeat(20);
const target = { chainId: CHAIN, address: LEDGER2, version: "ledger2" as const };
const BAD_KEY = "e0000000-0000-4000-8000-0000000000b1|s0000000-0000-4000-8000-0000000000b1";
const BAD = { onChainEventId: "0x" + "b1".repeat(32), chainId: CHAIN, contract: LEDGER2, version: "ledger2", seated: true };

let dir: string;
let cwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;
const file = () => JSON.parse(readFileSync(join(dir, ".data", "onchain-events.json"), "utf-8")) as Record<string, unknown>;

before(async () => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-seating-"));
  mkdirSync(join(dir, ".data"));
  // A seated record missing its plan: unreadable, never served as general admission.
  writeFileSync(join(dir, ".data", "onchain-events.json"), JSON.stringify({ [BAD_KEY]: BAD }));
  process.chdir(dir);
  process.env.WOCO_EVENT_CHAIN_ID ??= String(CHAIN);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

test("a seated record persists its plan and reads back", () => {
  registry.recordOnChainEventId("evt-r", "ser-r", "0x" + "01".repeat(32), target, { planDigest: DIGEST });
  assert.deepEqual(file()["evt-r|ser-r"], {
    onChainEventId: "0x" + "01".repeat(32), chainId: CHAIN, contract: LEDGER2, version: "ledger2", seated: true, planDigest: DIGEST,
  });
  assert.deepEqual(registry.registrationSeatingFor("evt-r", "ser-r"), { planDigest: DIGEST });
});

test("a malformed seated record is unreadable: not served, not seated, kept on disk", () => {
  const [e, s] = BAD_KEY.split("|");
  assert.equal(registry.lookupOnChainEventId(e, s), null);
  assert.equal(registry.registrationSeatingFor(e, s), null);
  assert.deepEqual(file()[BAD_KEY], BAD);
});

test("seating is fixed at registration: a replay may omit it, never add or change it", () => {
  const id = "0x" + "01".repeat(32);
  registry.recordOnChainEventId("evt-r", "ser-r", id, target);
  registry.recordOnChainEventId("evt-r", "ser-r", id, undefined, { planDigest: DIGEST });
  assert.deepEqual(registry.registrationSeatingFor("evt-r", "ser-r"), { planDigest: DIGEST }, "omitted or same: kept");
  assert.throws(
    () => registry.recordOnChainEventId("evt-r", "ser-r", id, target, { planDigest: `0x${"99".repeat(32)}` }),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  registry.recordOnChainEventId("evt-g", "ser-g", "0x" + "02".repeat(32), target);
  assert.equal(registry.registrationSeatingFor("evt-g", "ser-g"), null);
  assert.throws(
    () => registry.recordOnChainEventId("evt-g", "ser-g", "0x" + "02".repeat(32), target, { planDigest: DIGEST }),
    (err: Error) => err.name === "RegistrationRebindError",
    "a general registration never becomes seated",
  );
  assert.throws(() => registry.recordOnChainEventId("evt-n", "ser-n", "0x" + "03".repeat(32), undefined, { planDigest: DIGEST }));
  assert.throws(() => registry.recordOnChainEventId("evt-n", "ser-n", "0x" + "03".repeat(32), target, { planDigest: "0x12" }));
});
