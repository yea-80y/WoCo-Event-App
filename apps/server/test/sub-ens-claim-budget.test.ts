/**
 * The claim route's two budgets (Fable sign-off F11): a per-account limiter,
 * and a reserve of every registrar-wide window that this server never spends
 * itself - read from the LIVE cap, so the Safe's retune moves it too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GLOBAL_MINT_RESERVE_FRACTION, globalMintSoftVerdict } from "../src/lib/chain/sub-ens-contract.js";

const at = 1_800_003_600;
const h = (remaining: number, max: number) => ({ remaining, max, windowResetsAt: at });

test("a fifth of the live cap is held back", () => {
  assert.equal(GLOBAL_MINT_RESERVE_FRACTION, 0.2);
  assert.equal(globalMintSoftVerdict(h(61, 300)), null, "above the reserve proceeds");
  assert.deepEqual(globalMintSoftVerdict(h(60, 300)), { error: "mint_global_cap", data: { windowResetsAt: at } });
  assert.deepEqual(globalMintSoftVerdict(h(0, 300)), { error: "mint_global_cap", data: { windowResetsAt: at } });
});

test("the reserve follows the Safe's retune, in both directions", () => {
  assert.equal(globalMintSoftVerdict(h(201, 1000)), null);
  assert.ok(globalMintSoftVerdict(h(200, 1000)), "launch-day cap 1,000/h holds back 200");
  assert.equal(globalMintSoftVerdict(h(21, 100)), null);
  assert.ok(globalMintSoftVerdict(h(20, 100)));
});

test("a tiny cap is not swallowed by the reserve", () => {
  // floor, not ceil: a cap of 1-4 reserves nothing, so the product can still mint.
  assert.equal(globalMintSoftVerdict(h(1, 1)), null);
  assert.ok(globalMintSoftVerdict(h(0, 1)));
  assert.equal(globalMintSoftVerdict(h(1, 4)), null);
});

test("a read that failed proceeds - the contract's own cap still binds", () => {
  assert.equal(globalMintSoftVerdict(null), null);
});

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}
const ROUTE = sourceOf("../src/routes/sub-ens.ts");
const CLAIM = ROUTE.slice(ROUTE.indexOf('subEnsRoutes.post("/claim"'), ROUTE.indexOf("\n});", ROUTE.indexOf('subEnsRoutes.post("/claim"')));

test("the per-account budget is 5 an hour and 10 a day", () => {
  assert.match(
    ROUTE,
    /const claimLimiter = new SlidingWindowLimiter\(\[\s*\{ limit: 5, windowMs: 60 \* 60_000 \},\s*\{ limit: 10, windowMs: 24 \* 60 \* 60_000 \},\s*\]\);/,
  );
});

test("the budget is peeked before any chain read, and charged only for a mint about to be sent", () => {
  const peek = CLAIM.indexOf("claimLimiter.peek(account)");
  const firstRead = CLAIM.indexOf("isLabelAvailable(label)");
  const capped = CLAIM.indexOf("if (capped) return");
  const busy = CLAIM.indexOf("if (busy) return");
  const record = CLAIM.indexOf("claimLimiter.record(account)");
  const mint = CLAIM.indexOf("mintSubEnsName(label, parentAddress)");
  assert.ok(peek > 0 && peek < firstRead, "peek before the first chain read");
  assert.ok(capped < record && busy < record, "a refused claim is not charged");
  assert.ok(record < mint, "charged before the mint is sent");
  assert.match(CLAIM, /if \(!claimLimiter\.peek\(account\)\) return c\.json\(\{ ok: false, error: "rate_limited" \}, 429\);/);
});

test("the reserve refuses as the chain's own cap does: 503 mint_global_cap", () => {
  assert.match(CLAIM, /const busy = globalMintSoftVerdict\(headroom\);\s*if \(busy\) return c\.json\(\{ ok: false, \.\.\.busy \}, 503\);/);
});

test("the live cap is read from the registrar", () => {
  const chain = sourceOf("../src/lib/chain/sub-ens-contract.ts");
  assert.match(chain, /"function maxGlobalMintsPerWindow\(\) view returns \(uint32\)"/);
  assert.match(chain, /registrar\.maxGlobalMintsPerWindow\(\)/);
});
