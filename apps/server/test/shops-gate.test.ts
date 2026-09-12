/**
 * The shop rail is OFF for launch (#124).
 *
 * Hiding the client routes is not the same as closing the feature: a cached
 * client still calls, and a deployed organiser site bakes the flag value into
 * its bundle at publish time, so a site published before the flip keeps its
 * order screen and keeps calling /api/shops/*. This router is therefore the
 * AUTHORITATIVE gate, and it is asserted here at the HTTP layer.
 *
 * The gate must sit ahead of requireAuth: an unauthenticated probe should learn
 * "off", not "unauthorised" — otherwise the 401 reads as "get a session and try
 * again", which is the opposite of the truth.
 *
 * The flag is read at REQUEST time and not mocked on purpose. The claim under
 * test is "what this build actually serves", and a mocked flag would assert the
 * gate's shape while saying nothing about the shipped constant.
 *
 * MUTATION: delete `shopsRouter.use("*", shopGate)` and every case below goes
 * red; flip shopAllowed to true and they go red too (which is what proves they
 * test the gate rather than the router's 404 behaviour).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-shops-gate";

let app: import("hono").Hono;
let FEATURES: typeof import("@woco/shared").FEATURES;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-shops-gate-test-")));
  const { Hono } = await import("hono");
  const { shopsRouter } = await import("../src/routes/shops.js");
  ({ FEATURES } = await import("@woco/shared"));
  app = new Hono();
  app.route("/api/shops", shopsRouter);
});

test("the flag is off for launch", () => {
  assert.equal(FEATURES.shopAllowed, false);
});

/** One read, one write, one authenticated read — the three shapes on the router. */
const ROUTES: Array<[string, string, string]> = [
  ["GET", "/api/shops/shop-abc", "public read: the storefront a site section fetches"],
  ["POST", "/api/shops/shop-abc/orders", "public write: order creation, which spends postage"],
  ["GET", "/api/shops/mine", "authenticated read: must answer 'off', not 'unauthorised'"],
  ["POST", "/api/shops/shop-abc/orders/ord-1/checkout", "money: Stripe checkout session"],
  [
    "POST",
    "/api/shops/shop-abc/orders/ord-1/pay-spend-permission",
    "money: the USDC draw the server makes as the spender",
  ],
];

for (const [method, path, why] of ROUTES) {
  test(`${method} ${path} is closed while the flag is off (${why})`, async () => {
    const res = await app.request(path, {
      method,
      ...(method === "POST"
        ? { body: JSON.stringify({}), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    assert.equal(res.status, 403, "a closed rail answers 403, never 401/404/500");
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "Shops are not available");
  });
}

/**
 * A route added below the gate in future must inherit it. `use("*")` is what
 * makes that true, and this is the assertion that notices if someone swaps it
 * for a hand-maintained per-route list.
 */
test("an unknown path under the router is gated too, not 404'd", async () => {
  const res = await app.request("/api/shops/whatever/a/route/that/does/not/exist");
  assert.equal(res.status, 403, "the gate is wildcard-mounted, so it runs before routing resolves");
});
