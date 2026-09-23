/**
 * #44: buying a per-user Etherna batch spends the platform's credit, so the
 * route is OPT-IN. Only the exact value "true" enables it; unset, empty or
 * mistyped must refuse rather than spend.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let perUserBatchPurchaseEnabled: (value?: string) => boolean;

before(async () => {
  // The batch registry resolves .data/ against cwd at import.
  const repoServerDir = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-etherna-opt-in-")));
  ({ perUserBatchPurchaseEnabled } = await import(join(repoServerDir, "src/routes/etherna.ts")));
});

test("only the exact value \"true\" enables per-user batch purchase", () => {
  assert.equal(perUserBatchPurchaseEnabled("true"), true);
  for (const off of [undefined, "", "false", "TRUE", " true", "true ", "1", "yes", "on"]) {
    assert.equal(perUserBatchPurchaseEnabled(off), false, `${JSON.stringify(off)} must refuse`);
  }
});

test("the purchase route consults the switch before it provisions anything", () => {
  // Text check: the route sits behind requireAuth and this suite has no
  // signed-request harness (#622). What matters is the order inside the handler.
  const src = readFileSync(new URL("../src/routes/etherna.ts", import.meta.url), "utf-8");
  const handler = src.slice(src.indexOf('ethernaRoutes.post("/purchase-batch"'));
  const guard = handler.indexOf("if (!perUserBatchPurchaseEnabled())");
  const spend = handler.indexOf("provisionEthernaBatch(");
  assert.ok(guard > 0, "purchase-batch handler must check perUserBatchPurchaseEnabled()");
  assert.ok(spend > guard, "the check must come before provisionEthernaBatch()");
});
