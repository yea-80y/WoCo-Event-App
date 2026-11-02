/**
 * The organiser key's wiring (ledger2). The helper and the publish screen declare
 * `$state` or import the auth store, which Node cannot load, so the wiring is checked by
 * SOURCE SCAN: the binding is made from the CURRENT account secret, the key is zeroed and
 * never stored, and every on-chain registration carries the binding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url).pathname;
const code = (p: string) =>
  readFileSync(SRC + p, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/.*$/gm, "");

test("the key comes from the current account secret, after the organiser unlock, and is zeroed", () => {
  const helper = code("lib/auth/organiser-key.ts");
  assert.match(helper, /await auth\.ensureOrganiserUnlock\(\)/);
  assert.match(helper, /auth\.getAccountSecrets\(\{ toSeal: true \}\)/, "not the CONFIRMED current generation");
  assert.match(helper, /deriveOrganiserKey\(secrets\.current\)/);
  assert.match(helper, /signOrganiserKeyBinding\(key, parent, secrets\.gen\)/);
  assert.match(helper, /key\.privateKey\.fill\(0\)/, "the key outlives the binding");
  // Never another signer, never stored.
  assert.doesNotMatch(helper, /getContentFeedSigner|ensureIssuingKey|getIdentitySeed|localStorage|indexedDB|sessionStorage/);
  // Lazy: the derivation code loads on use, not with the page.
  assert.match(helper, /await import\("@woco\/shared\/crypto\/organiser-key"\)/);
});

test("the registration request carries the binding to register-on-chain", () => {
  const api = code("lib/api/events.ts");
  const fn = api.slice(api.indexOf("export async function registerSeriesOnChain"));
  assert.match(fn.slice(0, 1200), /organiserKeyBinding\?: OrganiserKeyBindingV1/);
  assert.match(fn.slice(0, 1200), /\{ seriesId, \.\.\.\(organiserKeyBinding \? \{ organiserKeyBinding \} : \{\}\) \}/);
});

test("publish makes the binding once and passes it to every series it registers", () => {
  const publish = code("lib/creator/events/PublishButton.svelte");
  assert.match(publish, /import \{ organiserKeyBinding \} from "\.\.\/\.\.\/auth\/organiser-key\.js"/);
  const reg = publish.slice(publish.indexOf("async function registerAndFinalise"));
  assert.match(reg, /const keyBinding = await organiserKeyBinding\(\)/);
  const calls = [...publish.matchAll(/registerSeriesOnChain\(([^)]*)\)/g)].map((m) => m[1]!);
  assert.ok(calls.length > 0, "no registration call found");
  for (const args of calls) assert.match(args, /keyBinding/, `a registration without the binding: ${args}`);
});
