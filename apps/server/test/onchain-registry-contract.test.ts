/**
 * #563 — the registration record names the contract a registration lives on.
 *
 * A successor events contract has to run BESIDE the old one: the old one's
 * tickets stay mintable until sold out and verifiable forever. So the mint
 * target and every pre-charge read must follow the contract the series was
 * registered on — server state, never the organiser-signed feed (#424/#426) —
 * and not whatever `WOCO_EVENT_VERSION_*` selects after the flip.
 *
 * `onchain-events.json` is a MUST-SURVIVE file. Pinned here: records written
 * before this change keep working and are never rewritten, a record this build
 * cannot read is kept on disk untouched and never served, and the contract is
 * part of the binding (a replay naming another contract refuses).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAIN = 421614;
const V2 = "0x351070aff6deca449506a6ea6dc6cb84d13caedf";
const LEDGER = "0x" + "1e".repeat(20);

const LEGACY_KEY = "e0000000-0000-4000-8000-000000000001|s0000000-0000-4000-8000-000000000001";
const LEGACY_ID = "0x" + "aa".repeat(32);
const BROKEN_KEY = "e0000000-0000-4000-8000-000000000002|s0000000-0000-4000-8000-000000000002";
const BROKEN = { onChainEventId: "0x" + "bb".repeat(32), chainId: "not-a-number", contract: "0xnope" };
// Well-formed but for a version this build does not know: dispatching it would
// pick an ABI by guess.
const FUTURE_KEY = "e0000000-0000-4000-8000-000000000004|s0000000-0000-4000-8000-000000000004";
const FUTURE = { onChainEventId: "0x" + "ee".repeat(32), chainId: 421614, contract: "0x" + "ee".repeat(20), version: "v9" };

const NEW_EVENT = "e0000000-0000-4000-8000-000000000003";
const NEW_SERIES = "s0000000-0000-4000-8000-000000000003";
const NEW_ID = "0x" + "cc".repeat(32);

let dir: string;
let originalCwd: string;
const savedEnv = new Map<string, string | undefined>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;

function setEnv(k: string, v: string | undefined): void {
  if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

const file = () => JSON.parse(readFileSync(join(dir, ".data", "onchain-events.json"), "utf-8")) as Record<string, unknown>;
const v2Target = { chainId: CHAIN, address: V2, version: "v2" as const };
const ledgerTarget = { chainId: CHAIN, address: LEDGER, version: "ledger" as const };

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-563-"));
  mkdirSync(join(dir, ".data"));
  // A file as a pre-#563 server left it, plus one entry no build could read.
  writeFileSync(
    join(dir, ".data", "onchain-events.json"),
    JSON.stringify({ [LEGACY_KEY]: LEGACY_ID, [BROKEN_KEY]: BROKEN, [FUTURE_KEY]: FUTURE }),
  );
  process.chdir(dir);
  setEnv("WOCO_EVENT_CHAIN_ID", String(CHAIN));
  setEnv(`WOCO_EVENT_VERSION_${CHAIN}`, "v2");
  setEnv(`WOCO_EVENT_ADDRESS_V2_${CHAIN}`, undefined);
  setEnv(`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`, LEDGER);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("a record written before #563 still resolves, on today's env contract", () => {
  const [e, s] = LEGACY_KEY.split("|");
  assert.equal(registry.lookupOnChainEventId(e, s), LEGACY_ID);
  assert.deepEqual(registry.registrationContractFor(e, s), v2Target);
});

test("a new registration is recorded WITH its contract", () => {
  registry.recordOnChainEventId(NEW_EVENT, NEW_SERIES, NEW_ID, v2Target);
  assert.deepEqual(file()[`${NEW_EVENT}|${NEW_SERIES}`], {
    onChainEventId: NEW_ID,
    chainId: CHAIN,
    contract: V2,
    version: "v2",
  });
});

test("persisting leaves the old record byte-identical and the unreadable one untouched", () => {
  const f = file();
  assert.equal(f[LEGACY_KEY], LEGACY_ID, "a legacy record is never rewritten");
  assert.deepEqual(f[BROKEN_KEY], BROKEN, "an unreadable record is never dropped");
  assert.deepEqual(f[FUTURE_KEY], FUTURE, "nor is one of an unknown version");
});

test("an unreadable record is not served, and its id stays bound", () => {
  const [e, s] = BROKEN_KEY.split("|");
  assert.equal(registry.lookupOnChainEventId(e, s), null);
  assert.equal(registry.findKeyBoundTo(BROKEN.onChainEventId), BROKEN_KEY);
  assert.throws(
    () => registry.recordOnChainEventId(e, s, "0x" + "dd".repeat(32), v2Target),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  const [fe, fs] = FUTURE_KEY.split("|");
  assert.equal(registry.lookupOnChainEventId(fe, fs), null, "an unknown version is not served");
});

test("an unreadable record is an alarm on /api/health", () => {
  const h = registry.onchainRegistryHealth();
  assert.equal(h.unreadableRecords, 2);
  assert.equal(h.ok, false);
});

test("the contract is part of the binding — a replay naming another contract refuses", () => {
  assert.throws(
    () => registry.recordOnChainEventId(NEW_EVENT, NEW_SERIES, NEW_ID, ledgerTarget),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  assert.doesNotThrow(() => registry.recordOnChainEventId(NEW_EVENT, NEW_SERIES, NEW_ID, v2Target));
  assert.doesNotThrow(() => registry.recordOnChainEventId(NEW_EVENT, NEW_SERIES, NEW_ID));
  assert.deepEqual(registry.registrationContractFor(NEW_EVENT, NEW_SERIES), v2Target);
});

test("a replay never stamps a contract onto an old record — today's contract would be a guess", () => {
  const [e, s] = LEGACY_KEY.split("|");
  registry.recordOnChainEventId(e, s, LEGACY_ID, ledgerTarget);
  assert.equal(file()[LEGACY_KEY], LEGACY_ID);
  assert.equal(registry.lookupRegistration(e, s).contract, undefined);
});

test("THE CUTOVER: after env flips to the ledger, every existing registration stays on V2", () => {
  setEnv(`WOCO_EVENT_VERSION_${CHAIN}`, "ledger");
  try {
    // Recorded with its contract: follows the record.
    assert.deepEqual(registry.registrationContractFor(NEW_EVENT, NEW_SERIES), v2Target);
    // Recorded before the contract was: the legacy rule, never the ledger.
    const [e, s] = LEGACY_KEY.split("|");
    assert.deepEqual(registry.registrationContractFor(e, s), v2Target);
  } finally {
    setEnv(`WOCO_EVENT_VERSION_${CHAIN}`, "v2");
  }
});

test("the snapshot's resolution entries carry the contract when the record has one", () => {
  const entries = registry.getAllResolutionEntries() as Array<Record<string, unknown>>;
  const pinned = entries.find((e) => e.onChainEventId === NEW_ID)!;
  assert.equal(pinned.chainId, CHAIN);
  assert.equal(pinned.contract, V2);
  const legacy = entries.find((e) => e.onChainEventId === LEGACY_ID)!;
  assert.equal("contract" in legacy, false, "a legacy entry does not publish a guessed contract");
});

test("a pinned record round-trips through the file", async () => {
  // A fresh module instance reads the file this one wrote.
  const fresh = await import(`../src/lib/event/onchain-registry.js?reload=${Date.now()}`);
  assert.deepEqual(fresh.registrationContractFor(NEW_EVENT, NEW_SERIES), v2Target);
  assert.equal(fresh.lookupOnChainEventId(...(LEGACY_KEY.split("|") as [string, string])), LEGACY_ID);
});
