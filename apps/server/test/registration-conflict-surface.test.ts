/**
 * #434 — a wedged registration must be VISIBLE, to the organiser and to an
 * operator.
 *
 * Since #433 a registration whose on-chain event is already bound to another
 * series can never complete: `confirmSeriesOnChain` throws
 * `RegistrationRebindError` on every retry, the pending marker never clears, and
 * the only recovery is an operator restoring `onchain-events.json` and
 * restarting. That is the right refusal — the alternative was silently minting
 * out of another organiser's supply — but it surfaced as an anonymous 500 loop
 * and an exception among thousands of log lines.
 *
 * Two surfaces, tested here: the organiser gets a definitive 409 with a code
 * rather than a retryable-looking 500, and `/api/health` carries a count an
 * uptime check can alarm on.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;
let registerOnChainErrorResponse: (err: unknown) => {
  status: number;
  body: { ok: false; error: string; message?: string };
};

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-434-surface-"));
  // Both modules capture `join(process.cwd(), ".data")` at load, and the route
  // module pulls the registry in with it — so BOTH imports must follow the chdir,
  // or this suite reads and writes the repo's own `.data`.
  process.chdir(dir);
  process.env.EMAIL_HASH_SECRET ??= "test-secret-434-surface";
  registry = await import("../src/lib/event/onchain-registry.js");
  ({ registerOnChainErrorResponse } = await import("../src/routes/events.js"));
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The organiser's answer
// ---------------------------------------------------------------------------

test("register-on-chain answers a rebind conflict with 409 registration_conflict", async () => {
  const { RegistrationRebindError } = registry;
  const res = registerOnChainErrorResponse(
    new RegistrationRebindError("refusing to bind 0xabc… : already bound to evt-x|ser-y"),
  );

  assert.equal(res.status, 409, "a conflict that never succeeds on retry must not read as a 500");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "registration_conflict");
  assert.ok(res.body.message && res.body.message.length > 0, "the organiser needs a sentence, not a code");
});

test("the 409 body leaks no internals — not the ids, not the thrown message", () => {
  const { RegistrationRebindError } = registry;
  const res = registerOnChainErrorResponse(
    new RegistrationRebindError("refusing to bind 0xdeadbeef… to evt-secret/ser-secret: already bound to evt-victim|ser-victim"),
  );
  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes("evt-victim"), "another organiser's event id reached the caller");
  assert.ok(!serialised.includes("0xdeadbeef"), "the on-chain id reached the caller");
  assert.ok(!serialised.includes("refusing to bind"), "the internal message reached the caller");
});

test("every other failure keeps its 500 — the 409 is for the one thing retry cannot fix", () => {
  const res = registerOnChainErrorResponse(new Error("timeout"));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "timeout");

  const nonError = registerOnChainErrorResponse("nope");
  assert.equal(nonError.status, 500);
  assert.equal(nonError.body.error, "registerEvent tx failed");
});

// ---------------------------------------------------------------------------
// The operator's answer
// ---------------------------------------------------------------------------

test("health starts ok with nothing wedged", () => {
  assert.deepEqual(registry.onchainRegistryHealth(), { ok: true, rebindConflicts: 0 });
});

test("one conflict flips ok:false with a count of 1", () => {
  registry.noteRebindConflict("evt-wedged", "ser-wedged");
  assert.deepEqual(registry.onchainRegistryHealth(), { ok: false, rebindConflicts: 1 });
});

test("retrying the SAME series stays at 1 — the number means 'series stuck', not 'attempts'", () => {
  // An organiser hammering a broken publish button must not look like a spreading
  // incident; the count has to be something an operator can act on.
  registry.noteRebindConflict("evt-wedged", "ser-wedged");
  registry.noteRebindConflict("evt-wedged", "ser-wedged");
  assert.deepEqual(registry.onchainRegistryHealth(), { ok: false, rebindConflicts: 1 });
});

test("a SECOND wedged series counts separately", () => {
  registry.noteRebindConflict("evt-wedged-2", "ser-wedged-2");
  assert.deepEqual(registry.onchainRegistryHealth(), { ok: false, rebindConflicts: 2 });
});

test("the section is public-safe: booleans and counts only", () => {
  const section = registry.onchainRegistryHealth() as Record<string, unknown>;
  assert.deepEqual(Object.keys(section).sort(), ["ok", "rebindConflicts"]);
  assert.equal(typeof section.ok, "boolean");
  assert.equal(typeof section.rebindConflicts, "number");
  // Nothing in the serialised section may name an event, a series or a chain id.
  assert.ok(!JSON.stringify(section).includes("evt-wedged"));
});

// Fable gate, 2026-09-11: the health tests above call `noteRebindConflict`
// directly, so removing the call from `confirmSeriesOnChain` survived a
// mutation. This one goes through the real confirm; the rebind refusal is its
// first statement, so no Swarm or chain is touched before the throw.
test("a wedged CONFIRM is what raises the alarm — not a direct call to the counter", async () => {
  const service = await import("../src/lib/event/service.js");
  const id = `0x${"c7".repeat(32)}`;
  const before = registry.onchainRegistryHealth().rebindConflicts;
  registry.recordOnChainEventId("evt-held-434", "ser-held-434", id);

  await assert.rejects(
    service.confirmSeriesOnChain("evt-wedged-434", "ser-wedged-434", id),
    registry.RegistrationRebindError,
  );
  assert.deepEqual(registry.onchainRegistryHealth(), { ok: false, rebindConflicts: before + 1 });

  await assert.rejects(service.confirmSeriesOnChain("evt-wedged-434", "ser-wedged-434", id));
  assert.equal(registry.onchainRegistryHealth().rebindConflicts, before + 1, "a retry of the same key does not double-count");
});
