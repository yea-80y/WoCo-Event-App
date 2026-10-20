import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beginDeploy, CLIENT_POINTER_HOLD_MS } from "../src/lib/site/deploy-guard.ts";

test("a deploy claims its key once; a plain release frees it straight away", () => {
  const end = beginDeploy("site:a");
  assert.ok(end);
  assert.equal(beginDeploy("site:a"), null, "an overlapping deploy is refused");
  end();
  const again = beginDeploy("site:a");
  assert.ok(again, "free after release");
  again();
});

test("a release that handed the pointer to the client keeps the key for the hold", async () => {
  const end = beginDeploy("site:b");
  assert.ok(end);
  end(40);
  assert.equal(beginDeploy("site:b"), null, "still held while the client signs its index");
  await new Promise((r) => setTimeout(r, 60));
  const again = beginDeploy("site:b");
  assert.ok(again, "free once the hold lapses");
  again();
  assert.ok(CLIENT_POINTER_HOLD_MS >= 5_000, "the hold covers the client's sign-and-post");
});

test("both deploy routes hold the key when the pointer index went to the client", () => {
  for (const [file, assign] of [
    ["../src/routes/sites.ts", "multisiteFeed = {"],
    ["../src/routes/site.ts", "pageFeed = {"],
  ] as const) {
    const s = readFileSync(new URL(file, import.meta.url), "utf-8");
    const handOffs = s.split(assign).length - 1;
    const holds = s.split("holdAfterMs = CLIENT_POINTER_HOLD_MS;").length - 1;
    assert.ok(handOffs > 0 && holds === handOffs, `${file}: every client pointer hand-off sets the hold`);
    assert.match(s, /endDeploy\?\.\(holdAfterMs\);/, `${file}: release passes the hold`);
  }
  const sites = readFileSync(new URL("../src/routes/sites.ts", import.meta.url), "utf-8");
  assert.match(sites, /failed\.find\(\(r\) => !isStorageBusy\(r\.reason\)\) \?\? failed\[0\]/, "a real fault outranks busy");
});
