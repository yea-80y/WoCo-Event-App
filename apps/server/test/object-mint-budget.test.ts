/**
 * #263: minting a badge/collectible spends a sponsor-paid on-chain registration,
 * so POST /api/objects is bounded per account and per IP, and open only to a
 * Stripe-verified organiser (the same gate as marketing sending).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlidingWindowLimiter } from "../src/lib/http/rate-limit.js";

let MINT_BUDGET: (typeof import("../src/routes/objects.js"))["MINT_BUDGET"];

before(async () => {
  // Stores the route imports resolve .data/ against cwd.
  const serverDir = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-object-mint-budget-")));
  ({ MINT_BUDGET } = await import(join(serverDir, "src/routes/objects.ts")));
});

const DAY = 24 * 60 * 60_000;

test("the budget is 5 mints per account and 10 per IP, per day (owner, 2026-09-22)", () => {
  assert.deepEqual(MINT_BUDGET.perAccount, { limit: 5, windowMs: DAY });
  assert.deepEqual(MINT_BUDGET.perIp, { limit: 10, windowMs: DAY });
});

test("a sixth mint in a day is refused, and allowed again a day later", () => {
  const limiter = new SlidingWindowLimiter([MINT_BUDGET.perAccount]);
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.peek("0xorg", t0 + i), true);
    limiter.record("0xorg", t0 + i);
  }
  assert.equal(limiter.peek("0xorg", t0 + 10), false);
  assert.equal(limiter.peek("0xorg", t0 + DAY + 10), true);
});

test("the handler checks budget and verification before it pins or spends anything", () => {
  // Text check: the route sits behind requireAuth and this suite has no
  // signed-request harness (#622). What matters is the order in the handler.
  const src = readFileSync(new URL("../src/routes/objects.ts", import.meta.url), "utf-8");
  const handler = src.slice(src.indexOf('objectsRouter.post("/", requireAuth'));
  const at = (needle: string) => {
    const i = handler.indexOf(needle);
    assert.ok(i > 0, `handler is missing ${needle}`);
    return i;
  };
  const peek = at("mintByAccount.peek(parentAddress)");
  const ipPeek = at("mintByIp.peek(ip)");
  const verified = at("await refuseUnlessVerifiedOrganiser(");
  const pin = at("verifyAndPinIssuerBinding(");
  const validate = at("validateObjectIssuance({");
  const record = at("mintByAccount.record(parentAddress)");
  const ipRecord = at("mintByIp.record(ip)");
  const spend = at("await issueObjectType(");
  assert.ok(peek < verified && ipPeek < verified, "budget is checked first");
  assert.ok(verified < pin, "an unverified account pins nothing");
  assert.ok(validate < record, "a mismatched manifest is refused before the budget is charged");
  assert.ok(pin < record && record < spend && ipRecord < spend, "the budget is charged just before the spend");
});

test("the client-input checks are one function, used by the route and by issuance", async () => {
  const { validateObjectIssuance } = await import("../src/lib/object/issuance.js");
  const bodies = (n: number) => Array.from({ length: n }, (_, i) => ({ edition: i + 1 }));
  const manifest = { body: { metadataRoot: `0x${"00".repeat(32)}`, totalSupply: 3 } };

  const wrongCount = validateObjectIssuance({
    supply: 3,
    editionBodies: bodies(2) as never,
    signedManifest: manifest as never,
    certSourced: false,
  });
  assert.equal(wrongCount.ok, false);
  assert.match((wrongCount as { error: string }).error, /Expected 3 edition bodies, got 2/);

  const certWantsOne = validateObjectIssuance({
    supply: 500,
    editionBodies: bodies(500) as never,
    signedManifest: manifest as never,
    certSourced: true,
  });
  assert.equal(certWantsOne.ok, false);
  assert.match((certWantsOne as { error: string }).error, /exactly 1 template edition body/);

  const src = readFileSync(new URL("../src/lib/object/issuance.ts", import.meta.url), "utf-8");
  const fn = src.slice(src.indexOf("export async function issueObjectType"));
  assert.match(fn, /validateObjectIssuance\(\{/, "issueObjectType must run the same checks");
});
