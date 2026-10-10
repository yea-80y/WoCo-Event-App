/**
 * `onchain-events.json` exists but cannot be loaded at all (Fable review item 6).
 *
 * The loader used to treat that exactly like a first boot — no file — and
 * start empty, so the next registration persisted the empty map OVER the file:
 * every registration record gone, silently, on the file whose loss stops all
 * sales. Pinned: a present-but-unloadable file is never written, no new
 * registration is broadcast or recorded, `/api/health` alarms, and an absent
 * file is still the ordinary first boot.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const savedEnv = {
  chain: process.env.WOCO_EVENT_CHAIN_ID,
  version: process.env.WOCO_EVENT_VERSION_421614,
};
const dirs: string[] = [];
after(() => {
  process.chdir(originalCwd);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of [["WOCO_EVENT_CHAIN_ID", savedEnv.chain], ["WOCO_EVENT_VERSION_421614", savedEnv.version]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A fresh registry module whose `.data` is a new temp dir holding `contents` (or no file). */
async function registryWith(contents: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "woco-registry-file-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".data"));
  if (contents !== null) writeFileSync(join(dir, ".data", "onchain-events.json"), contents);
  // The store captures its path at module load, so chdir BEFORE the import.
  process.chdir(dir);
  const registry = await import(`../src/lib/event/onchain-registry.js?case=${dirs.length}`);
  return { registry, dir, file: join(dir, ".data", "onchain-events.json") };
}

const E = "e0000000-0000-4000-8000-0000000000f1";
const S = "s0000000-0000-4000-8000-0000000000f1";
const ID = "0x" + "f1".repeat(32);
const TARGET = { chainId: 421614, address: "0x" + "c2".repeat(20), version: "v2" as const };
// A file cut off mid-write — the realistic shape of this failure.
const TRUNCATED = `{"${E}|${S}": "0x${"aa".repeat(32)}", "e2|s2": "0x`;

for (const [name, contents] of [
  ["truncated JSON", TRUNCATED],
  ["JSON null", "null"],
  ["a JSON array", `["0x${"aa".repeat(32)}"]`],
] as const) {
  test(`${name}: the file is NEVER overwritten, and nothing registers`, async () => {
    const { registry, file } = await registryWith(contents);
    assert.equal(registry.lookupOnChainEventId(E, S), null, "nothing is served from a file not understood");
    assert.throws(
      () => registry.recordOnChainEventId(E, S, ID, TARGET),
      (err: Error) => err.name === "RegistryUnreadableError",
    );
    assert.equal(readFileSync(file, "utf-8"), contents, "the file must be exactly as found");
  });

  test(`${name}: a new registration is refused BEFORE its broadcast`, async () => {
    const { registry, dir } = await registryWith(contents);
    assert.throws(
      () => registry.recordRegistrationIntent(E, S, { nonce: 1, chainId: 421614 }, "0x" + "ab".repeat(32)),
      (err: Error) => err.name === "RegistryUnreadableError",
    );
    assert.equal(existsSync(join(dir, ".data", "pending-registrations.json")), false, "no intent was journalled");
  });

  test(`${name}: no contract is guessed — the legacy rule has nothing to answer for`, async () => {
    // Env names a perfectly good default contract, which the legacy rule would
    // return for a series with no record. Here "no record" means "not read".
    process.env.WOCO_EVENT_CHAIN_ID = "421614";
    process.env.WOCO_EVENT_VERSION_421614 = "v2";
    const { registry } = await registryWith(contents);
    assert.equal(registry.registrationContractFor(E, S), undefined);
    assert.deepEqual(registry.saleContractFor(E, S), { ok: false, reason: "no-contract" });
  });

  test(`${name}: /api/health alarms`, async () => {
    const { registry } = await registryWith(contents);
    const h = registry.onchainRegistryHealth();
    assert.equal(h.ok, false);
    assert.equal(h.fileUnreadable, true);
  });
}

test("no file at all is the ordinary first boot — registrations record and the file is created", async () => {
  process.env.WOCO_EVENT_CHAIN_ID = "421614";
  process.env.WOCO_EVENT_VERSION_421614 = "v2";
  const { registry, file } = await registryWith(null);
  // Nothing read and nothing wrong: the legacy rule answers as always.
  assert.equal(registry.registrationContractFor(E, S)?.version, "v2");
  registry.recordOnChainEventId(E, S, ID, TARGET);
  assert.equal(registry.lookupOnChainEventId(E, S), ID);
  assert.ok(existsSync(file));
  const h = registry.onchainRegistryHealth();
  assert.equal(h.ok, true);
  assert.equal(h.fileUnreadable, false);
});
