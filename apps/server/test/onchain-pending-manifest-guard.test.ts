/**
 * #434 — the tier-3 fill must not hand out an on-chain event whose registration
 * is still in flight for somebody else.
 *
 * THE WINDOW. A registration is journalled before the tx is broadcast, but the
 * RECORD is written by `confirmSeriesOnChain` only after the tx resolves. Between
 * the mining and the confirm the victim's on-chain event exists and this server
 * has no record of it — so `findKeyBoundTo`, the tier-3 re-bind guard, answers
 * null, and an attacker publishing a feed that names the victim's `manifestRef`
 * gets the victim's event bound to THEIR series. Since #433 the victim's own
 * confirm then throws `RegistrationRebindError` on every retry: no theft any
 * more, but a permanent wedge with nothing surfacing it.
 *
 * The pending marker is the state that closes the window — the server's own
 * evidence that a registration for that digest is in flight, which a creator
 * cannot write. It now carries the manifestRef so the fill can ask.
 *
 * WHAT IS AND IS NOT PROVEN HERE. The refusal's inputs are pinned exhaustively:
 * the marker plumbing that fills them, and `findPendingKeyByManifestRef` itself.
 * Driving `applyOnChainEventIds` through tier 3 is NOT possible in a unit test —
 * the fill only reaches that branch when `byManifestRef` is populated, and only a
 * full sponsor chain walk populates it (the same reason `indexWalkedRegistrations`
 * is exported, and the same limit `onchain-event-id-binding.test.ts` states for
 * the `findKeyBoundTo` guard). A source guard therefore pins that the fill still
 * ASKS, and is stated as what it is: it does not prove the fill behaves.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VICTIM_EVENT = "evt-victim-434";
const VICTIM_SERIES = "ser-victim-434";
const ATTACKER_EVENT = "evt-attacker-434";
const ATTACKER_SERIES = "ser-attacker-434";
const MANIFEST = `0x${"c3".repeat(32)}`;

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-434-"));
  // The store captures `join(process.cwd(), ".data")` at module load, so the
  // chdir must happen before the first import.
  process.chdir(dir);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function k(eventId: string, seriesId: string): string {
  return `${eventId}|${seriesId}`;
}

// ---------------------------------------------------------------------------
// The marker carries the digest
// ---------------------------------------------------------------------------

test("an INTENT marker carries the manifestRef, lowercased", () => {
  // Phase 1 of the #318 journal — written before the tx leaves the process, which
  // is the earliest point the window can open, so the guard has to be armed here
  // and not only after the broadcast.
  registry.recordRegistrationIntent(VICTIM_EVENT, VICTIM_SERIES, { nonce: 7, chainId: 421614 }, MANIFEST.toUpperCase());

  const marker = registry.lookupPendingRegistration(VICTIM_EVENT, VICTIM_SERIES);
  assert.equal(marker.manifestRef, MANIFEST.toLowerCase());
  assert.equal(marker.txHash, undefined, "an intent marker has no hash yet");
});

test("the hash UPGRADE keeps the manifestRef — phase 2 must not erase it", () => {
  // `recordPendingRegistration` replaces the entry outright rather than merging,
  // so a caller that stopped passing the digest here would silently disarm the
  // guard for the whole confirmation window — which is most of the window.
  registry.recordPendingRegistration(
    VICTIM_EVENT,
    VICTIM_SERIES,
    { txHash: "0xtx", nonce: 7, chainId: 421614 },
    MANIFEST,
  );

  const marker = registry.lookupPendingRegistration(VICTIM_EVENT, VICTIM_SERIES);
  assert.equal(marker.manifestRef, MANIFEST.toLowerCase());
  assert.equal(marker.txHash, "0xtx");
});

test("the marker reaches DISK with the digest — a restart must not disarm the guard", () => {
  const persisted = JSON.parse(
    readFileSync(join(dir, ".data", "pending-registrations.json"), "utf-8"),
  ) as Record<string, { manifestRef?: string }>;
  assert.equal(persisted[k(VICTIM_EVENT, VICTIM_SERIES)].manifestRef, MANIFEST.toLowerCase());
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

test("a pending registration is found by its manifestRef, case-insensitively", () => {
  assert.equal(
    registry.findPendingKeyByManifestRef(MANIFEST),
    k(VICTIM_EVENT, VICTIM_SERIES),
  );
  assert.equal(
    registry.findPendingKeyByManifestRef(MANIFEST.toUpperCase()),
    k(VICTIM_EVENT, VICTIM_SERIES),
    "hex casing is the creator's to choose — it must not decide the answer",
  );
});

test("REFUSAL: the attacker's key is not the pending key, so tier 3 must not bind", () => {
  // The decision in one line. The attacker names the victim's digest under their
  // own (eventId, seriesId); the marker names the victim's. Different key ⇒ the
  // fill refuses and moves on, and the honest owner is unaffected because for
  // THEM the pending key IS their own key.
  const pendingKey = registry.findPendingKeyByManifestRef(MANIFEST);
  assert.notEqual(pendingKey, k(ATTACKER_EVENT, ATTACKER_SERIES));
  assert.equal(pendingKey, k(VICTIM_EVENT, VICTIM_SERIES));
});

test("an unrelated digest finds nothing", () => {
  assert.equal(registry.findPendingKeyByManifestRef(`0x${"d4".repeat(32)}`), null);
});

test("a marker with NO manifestRef blocks nothing", () => {
  // Additive field: markers written before it existed carry none. They must match
  // nothing rather than everything — the alternative would wedge every tier-3
  // fill for the life of one stale marker.
  registry.recordRegistrationIntent("evt-legacy", "ser-legacy", { nonce: 9, chainId: 421614 });
  assert.equal(registry.lookupPendingRegistration("evt-legacy", "ser-legacy").manifestRef, undefined);
  assert.equal(
    registry.findPendingKeyByManifestRef(`0x${"e5".repeat(32)}`),
    null,
    "a digest-less marker matched a digest",
  );
});

test("clearing the marker lifts the refusal — the honest path is not blocked forever", () => {
  // The other half of the guard, and the reason it is safe to be strict: the
  // marker is cleared the moment the confirm completes, after which the record
  // exists and tier 1/2 answers without ever reaching tier 3.
  registry.clearPendingRegistration(VICTIM_EVENT, VICTIM_SERIES);
  assert.equal(registry.findPendingKeyByManifestRef(MANIFEST), null);
});

// ---------------------------------------------------------------------------
// The call site
// ---------------------------------------------------------------------------

test("SOURCE GUARD: the tier-3 fill still asks, and asks BEFORE it writes", () => {
  // Honest about what it is: this proves the call exists and is ordered, not that
  // the fill behaves. Reaching the fill needs `byManifestRef`, which only a chain
  // walk populates. The regression this catches is the one that actually happens —
  // a guard deleted or moved below the write, not a wrong comparison.
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/event/onchain-registry.ts", import.meta.url)),
    "utf-8",
  );
  const fill = src.slice(src.indexOf("export async function applyOnChainEventIds"));
  assert.ok(fill.length > 0, "applyOnChainEventIds not found — update this guard");

  const asks = fill.indexOf("findPendingKeyByManifestRef(");
  const writes = fill.indexOf("recordOnChainEventId(");
  assert.ok(asks > -1, "the tier-3 fill no longer consults the pending markers (#434)");
  assert.ok(writes > -1, "the tier-3 fill no longer writes a record — update this guard");
  assert.ok(asks < writes, "the pending-marker guard must run BEFORE the record write");
});
