/**
 * A bound PROFILE name is pointed at the WoCo app (step 9, PR E).
 *
 * Two properties are pinned here, and they pull in opposite directions:
 *   - an EMPTY name gets the apex written to it, or typing the name into a
 *     browser resolves to nothing;
 *   - a name that already carries SOMEONE ELSE'S contenthash is never
 *     overwritten. A foreign hash means the holder pointed the name somewhere
 *     on purpose, and silently repointing it would be the platform taking a
 *     site off the air at the moment its owner adopted the name as identity.
 * Between them sits the third case: already the apex → write nothing, and do
 * not warn `points_at_site` about the app itself.
 *
 * Driven through the real `verifyAndBindProfileName` with the three chain edges
 * injected (the default-parameter shape `refuseUnlessOwner` already uses —
 * `mock.module` is unavailable under the tsx loader). The ledger is NOT stubbed:
 * it writes to a temp cwd, so the bind under test is the real bind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "woco-profile-apex-")));

const { verifyAndBindProfileName } = await import("../src/routes/profiles.js");
const { parseApexContenthash, subEnsApexHealth } = await import(
  "../src/lib/chain/sub-ens-apex.js"
);

const APEX = "d66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc";
const OTHER = "1111111111111111111111111111111111111111111111111111111111111111";

/** How the registry stores a Swarm reference (EIP-1577 / ENSIP-7). */
const record = (hash: string): string => `0xe40101fa011b20${hash}`;

let n = 0;
const acct = (): string => `0x${(++n).toString(16).padStart(40, "b")}`;

interface Written {
  calls: Array<[string, string]>;
}

async function bind(opts: {
  contenthash: string | null;
  apex: string | null;
  account?: string;
  label?: string;
}): Promise<{ outcome: Awaited<ReturnType<typeof verifyAndBindProfileName>>; written: Written }> {
  const account = opts.account ?? acct();
  const written: Written = { calls: [] };
  const outcome = await verifyAndBindProfileName(account, opts.label ?? "punkpub", {
    readOwner: async () => account.toLowerCase(),
    readContenthash: async () => opts.contenthash,
    writeContenthash: async (label, hash) => {
      written.calls.push([label, hash]);
      return "0xtx";
    },
    apexContenthash: () => opts.apex,
  });
  return { outcome, written };
}

// ---------------------------------------------------------------------------
// (1) Apex unconfigured — exactly today's behaviour, and no writes at all
// ---------------------------------------------------------------------------

test("unconfigured apex + a name that points at a site: warns, writes nothing", async () => {
  const { outcome, written } = await bind({ contenthash: record(OTHER), apex: null });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.warning, "points_at_site");
  assert.deepEqual(written.calls, [], "nothing may be written when there is no apex to write");
});

test("unconfigured apex + an empty name: no warning, and still no write", async () => {
  const { outcome, written } = await bind({ contenthash: null, apex: null });
  assert.equal(outcome.ok && outcome.warning, undefined);
  assert.deepEqual(written.calls, []);
});

// ---------------------------------------------------------------------------
// (2) Empty contenthash — the write that makes the name open the app
// ---------------------------------------------------------------------------

test("an EMPTY name gets the apex written to it, with no warning", async () => {
  const { outcome, written } = await bind({ contenthash: null, apex: APEX, label: "punkpub" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.warning, undefined, "the app is not a site to warn about");
  assert.deepEqual(
    written.calls,
    [["punkpub", APEX]],
    "the bound label must be pointed at the apex exactly once",
  );
});

test("the label written is the NORMALISED one, not what the caller typed", async () => {
  const { written } = await bind({ contenthash: null, apex: APEX, label: "  PunkPub  " });
  assert.deepEqual(written.calls, [["punkpub", APEX]]);
});

// ---------------------------------------------------------------------------
// (3) Already the apex — nothing written, and NOT a `points_at_site` warning
// ---------------------------------------------------------------------------

test("a name already pointing at the app is left alone and does not warn", async () => {
  const { outcome, written } = await bind({ contenthash: record(APEX), apex: APEX });
  assert.equal(outcome.ok && outcome.warning, undefined, "the app is not `points_at_site`");
  assert.deepEqual(written.calls, [], "re-writing the same hash spends sponsor gas for nothing");
});

test("the comparison is case-insensitive — the registry's casing is not ours to assume", async () => {
  const { outcome, written } = await bind({
    // Only the payload is upper-cased: `0x` itself is not, because that is what
    // an RPC would ever hand back and stripping it is prefix-sensitive.
    contenthash: `0xE40101FA011B20${APEX.toUpperCase()}`,
    apex: APEX,
  });
  assert.equal(outcome.ok && outcome.warning, undefined);
  assert.deepEqual(written.calls, []);
});

// ---------------------------------------------------------------------------
// (4) A foreign contenthash — warn, and never overwrite
// ---------------------------------------------------------------------------

test("a name pointing at ANOTHER site warns and is NOT overwritten with the apex", async () => {
  const { outcome, written } = await bind({ contenthash: record(OTHER), apex: APEX });
  assert.equal(outcome.ok && outcome.warning, "points_at_site");
  assert.deepEqual(
    written.calls,
    [],
    "a foreign hash is where the holder pointed the name — repointing it takes their site off the air",
  );
});

test("a NON-Swarm contenthash is still someone's pointer: warn, do not overwrite", async () => {
  // Decodes to null, which must read as "set to something we don't recognise",
  // never as "empty, safe to fill".
  const { outcome, written } = await bind({ contenthash: "0xe30101701220ff", apex: APEX });
  assert.equal(outcome.ok && outcome.warning, "points_at_site");
  assert.deepEqual(written.calls, []);
});

// ---------------------------------------------------------------------------
// A refused bind writes nothing — the courtesy must not outlive the bind
// ---------------------------------------------------------------------------

test("a name the caller does not own is refused, and no contenthash is written", async () => {
  const written: Written = { calls: [] };
  const outcome = await verifyAndBindProfileName(acct(), "punkpub", {
    readOwner: async () => "0x" + "9".repeat(40),
    readContenthash: async () => null,
    writeContenthash: async (label, hash) => {
      written.calls.push([label, hash]);
      return "0xtx";
    },
    apexContenthash: () => APEX,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(written.calls, []);
});

// ---------------------------------------------------------------------------
// The env surface — /api/health -> subEns
// ---------------------------------------------------------------------------

test("a valid apex reference is configured", () => {
  assert.deepEqual(subEnsApexHealth(parseApexContenthash(APEX)), { apexConfigured: true });
});

test("a MALFORMED value is not configured, and says so on health", () => {
  const h = subEnsApexHealth(parseApexContenthash("not-a-swarm-reference"));
  assert.equal(h.apexConfigured, false);
  assert.match(h.apexError ?? "", /SUB_ENS_APEX_CONTENTHASH/);
});

test("a 0x-prefixed value is refused rather than silently stripped", () => {
  // The var is documented as the bare reference setContenthash takes. Accepting
  // a second shape hides the mistake worth catching: a hash pasted from a place
  // where it is not the same hash.
  const h = subEnsApexHealth(parseApexContenthash(`0x${APEX}`));
  assert.equal(h.apexConfigured, false);
  assert.ok(h.apexError);
});

test("a truncated reference is refused", () => {
  assert.equal(subEnsApexHealth(parseApexContenthash(APEX.slice(0, 63))).apexConfigured, false);
});

test("UNSET is not an error — the write is a courtesy, not the bind's truth", () => {
  for (const raw of [undefined, "", "   "]) {
    assert.deepEqual(subEnsApexHealth(parseApexContenthash(raw)), { apexConfigured: false });
  }
});

test("the parsed reference is lowercased, so the equality check has one casing", () => {
  assert.equal(parseApexContenthash(APEX.toUpperCase()).hash, APEX);
});
