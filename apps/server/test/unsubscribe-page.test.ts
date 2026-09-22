/**
 * The unsubscribe confirm page's "block all" checkbox.
 *
 * The label is a flex row, and every direct child of a flex container is its
 * own item. Bare text plus a `<strong>` inside it became three gapped items that
 * could not wrap, so the sentence rendered broken on the live page. The text
 * must sit in ONE element beside the checkbox.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-unsubscribe-page";

let unsubscribe: (typeof import("../src/routes/unsubscribe.js"))["unsubscribe"];
let mintUnsubToken: (typeof import("../src/lib/marketing/unsub-token.js"))["mintUnsubToken"];

before(async () => {
  // The route imports the suppression store, which resolves .data/ against cwd.
  process.chdir(mkdtempSync(join(tmpdir(), "woco-unsub-page-test-")));
  ({ unsubscribe } = await import("../src/routes/unsubscribe.js"));
  ({ mintUnsubToken } = await import("../src/lib/marketing/unsub-token.js"));
});

test("the block-all label holds the checkbox and ONE text element", async () => {
  const token = mintUnsubToken({
    emailHash: "a".repeat(64),
    organiserAddress: "0xabcd000000000000000000000000000000000011",
  });
  const res = await unsubscribe.request(`/${token}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const label = html.match(/<label>([\s\S]*?)<\/label>/);
  assert.ok(label, "confirm page has no label");
  assert.match(
    label[1],
    /^<input type="checkbox" name="all" value="1" \/><span>[^<]*<strong>all<\/strong>[^<]*<\/span>$/,
    "label children must be exactly the checkbox and one wrapping <span>",
  );
});
