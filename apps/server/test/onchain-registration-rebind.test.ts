/**
 * #433 — the registration record must be unwritable by anyone but the series
 * that owns it.
 *
 * `byEventSeries` is the anchor the whole money path rests on: `routes/stripe.ts`
 * refuses to charge for a series whose claimed on-chain event contradicts it, and
 * `applyOnChainEventIds` rewrites a feed to agree with it. #424 chose it precisely
 * because a creator cannot write it.
 *
 * That was not true. `POST /api/events/:id/confirm-chain` authorised the caller
 * against the ON-CHAIN event they named (`onChain.organiser === parentAddress`)
 * and never against the WoCo event they were writing to — no
 * `feed.creatorAddress === parentAddress` check, unlike its sibling
 * `register-on-chain`. Since `registerEvent` is permissionless on both contracts,
 * an attacker registered an event of their own carrying the VICTIM's manifest
 * digest (public, content-addressed — copying it forges nothing), then called
 * confirm-chain against the VICTIM's eventId. Every gate passed and
 * `recordOnChainEventId` overwrote the victim's record. From there the poisoned
 * record healed the victim's feed to the attacker's id and the checkout anchor
 * agreed with the forgery — every sale minting into an event whose supply and
 * end time the attacker controlled, and which as organiser they could cancel.
 *
 * The route is deleted. These tests pin the STORE-level property, which is what
 * holds for callers that do not exist yet: one on-chain event ↔ one
 * (eventId, seriesId), in both directions, with same-value replay staying
 * idempotent because `register-once` heals a landed registration that way.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VICTIM_EVENT   = "11111111-1111-4111-8111-111111111111";
const VICTIM_SERIES  = "22222222-2222-4222-8222-222222222222";
const ATTACKER_EVENT = "33333333-3333-4333-8333-333333333333";
const ATTACKER_SERIES= "44444444-4444-4444-8444-444444444444";

const VICTIM_ONCHAIN   = `0x${"a1".repeat(32)}`;
const ATTACKER_ONCHAIN = `0x${"b2".repeat(32)}`;

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-433-"));
  // The store captures `join(process.cwd(), ".data")` at module load, so the
  // chdir must happen before the first import.
  process.chdir(dir);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** What actually reached disk — a refusal must not leave a half-write behind. */
function persisted(): Record<string, string> {
  return JSON.parse(readFileSync(join(dir, ".data", "onchain-events.json"), "utf-8"));
}

test("a first registration binds", () => {
  registry.recordOnChainEventId(VICTIM_EVENT, VICTIM_SERIES, VICTIM_ONCHAIN);
  assert.equal(registry.lookupOnChainEventId(VICTIM_EVENT, VICTIM_SERIES), VICTIM_ONCHAIN);
});

test("re-recording the SAME id is idempotent — register-once heals a landed tx this way", () => {
  // register-once.ts:122-127 replays confirmSeriesOnChain with the id it just
  // read back out of this map, to redo a feed write that failed. If that threw,
  // a registration whose tx landed could never have its feed healed.
  assert.doesNotThrow(() =>
    registry.recordOnChainEventId(VICTIM_EVENT, VICTIM_SERIES, VICTIM_ONCHAIN),
  );
  assert.equal(registry.lookupOnChainEventId(VICTIM_EVENT, VICTIM_SERIES), VICTIM_ONCHAIN);
});

test("the same id in different case is the same id, not a rebind", () => {
  assert.doesNotThrow(() =>
    registry.recordOnChainEventId(VICTIM_EVENT, VICTIM_SERIES, VICTIM_ONCHAIN.toUpperCase()),
  );
});

test("ANCHOR: a different id for an existing key is REFUSED — the #433 attack", () => {
  // The whole attack in one line: confirm-chain reached this call with the
  // victim's (eventId, seriesId) and the attacker's on-chain event.
  assert.throws(
    () => registry.recordOnChainEventId(VICTIM_EVENT, VICTIM_SERIES, ATTACKER_ONCHAIN),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  // The victim's binding is untouched — in memory and on disk.
  assert.equal(registry.lookupOnChainEventId(VICTIM_EVENT, VICTIM_SERIES), VICTIM_ONCHAIN);
  assert.equal(persisted()[`${VICTIM_EVENT}|${VICTIM_SERIES}`], VICTIM_ONCHAIN);
});

test("ANCHOR, other direction: an id already bound elsewhere cannot be re-bound", () => {
  // The mirror image — the attacker writes under their OWN key but names the
  // victim's on-chain event, which is what the tier-3 fill's `findKeyBoundTo`
  // guard has always refused. The property belongs to the store, not to one
  // call site.
  assert.throws(
    () => registry.recordOnChainEventId(ATTACKER_EVENT, ATTACKER_SERIES, VICTIM_ONCHAIN),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  assert.equal(registry.lookupOnChainEventId(ATTACKER_EVENT, ATTACKER_SERIES), null);
  assert.equal(persisted()[`${ATTACKER_EVENT}|${ATTACKER_SERIES}`], undefined);
});

test("a refusal does not block an unrelated, genuinely new registration", () => {
  registry.recordOnChainEventId(ATTACKER_EVENT, ATTACKER_SERIES, ATTACKER_ONCHAIN);
  assert.equal(registry.lookupOnChainEventId(ATTACKER_EVENT, ATTACKER_SERIES), ATTACKER_ONCHAIN);
  // Both bindings coexist; neither was disturbed by the refusals above.
  assert.equal(registry.lookupOnChainEventId(VICTIM_EVENT, VICTIM_SERIES), VICTIM_ONCHAIN);
});
