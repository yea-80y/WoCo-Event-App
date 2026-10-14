/**
 * A door pass that fails to set up keeps the phone on the provision screen with
 * a reason the door staff can act on. Before this, the scanner scrubbed the pass
 * from the address bar even on failure, told staff to reload, and the reload
 * reopened whatever event the phone held before - an expired test event, in the
 * case that found it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootFromFragment, describePackFailure, isPassExpired, PASS_EXPIRED_MESSAGE } from "../src/lib/scanner/pass-gate.js";

test("a revoked, expired, other-event or other-phone pass is dead: only a new pass helps", () => {
  for (const status of [401, 403, 409]) {
    const f = describePackFailure(status, { error: "Door pass expired" });
    assert.equal(f.kind, "dead", `status ${status}`);
    assert.equal(f.message, "Door pass expired");
  }
});

test("anything else can be retried with the same pass", () => {
  for (const status of [400, 404, 500, 503]) {
    assert.equal(describePackFailure(status, { error: "Failed to build check-in pack" }).kind, "error", `status ${status}`);
  }
});

test("a refusal with no readable reason still says what to do, and never to reload", () => {
  const f = describePackFailure(502, null);
  assert.equal(f.kind, "error");
  assert.match(f.message, /try again/);
  assert.doesNotMatch(f.message, /reload/i);
  assert.equal(describePackFailure(500, { error: 42 }).message, f.message.replace("502", "500"));
});

test("a stored pass at or past its exp is expired; one before it is not", () => {
  const exp = 1_800_000_000;
  assert.equal(isPassExpired(exp, exp * 1000 - 1), false);
  assert.equal(isPassExpired(exp, exp * 1000), true);
  assert.equal(isPassExpired(exp, exp * 1000 + 86_400_000), true);
});

test("a stored pass with no usable exp is expired, never opened", () => {
  for (const exp of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
    assert.equal(isPassExpired(exp, Date.now()), true, String(exp));
  }
});

test("the expired message sends staff to the dashboard for a new pass", () => {
  assert.match(PASS_EXPIRED_MESSAGE, /expired/);
  assert.match(PASS_EXPIRED_MESSAGE, /organiser's dashboard/);
  assert.doesNotMatch(PASS_EXPIRED_MESSAGE, /reload/i);
});

// ---------------------------------------------------------------------------
// The pass in the address bar
// ---------------------------------------------------------------------------

const TOKEN = "v1.ZXZ0.0123456789abcdef.1800000000." + "ab".repeat(32);
const KEY = "c2VjcmV0LXJvc3Rlci1rZXk";

function fakePage(hash: string) {
  const page = {
    location: { hash, pathname: "/bzz/abc/", search: "", href: `https://gw.example/bzz/abc/${hash}` },
    urls: [] as string[],
    history: {
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        page.urls.push(String(url));
        page.location.hash = new URL(String(url)).hash;
      },
    },
  };
  return page;
}

test("a failed provision leaves no pass in the address bar or history", async () => {
  const page = fakePage(`#/p/${TOKEN}/${KEY}`);
  let seenHashDuringProvision = "unset";
  const result = await bootFromFragment({
    location: page.location,
    history: page.history,
    provision: async (token, key) => {
      assert.equal(token, TOKEN);
      assert.equal(key, KEY);
      seenHashDuringProvision = page.location.hash;
      return false;
    },
  });
  assert.equal(result, "failed");
  assert.equal(page.location.hash, "");
  assert.equal(seenHashDuringProvision, "", "scrubbed BEFORE the pack request, not after it");
  assert.deepEqual(page.urls, ["https://gw.example/bzz/abc/"]);
});

test("a successful provision leaves no pass in the address bar either", async () => {
  const page = fakePage(`#/p/${TOKEN}/${KEY}`);
  assert.equal(await bootFromFragment({ location: page.location, history: page.history, provision: async () => true }), "provisioned");
  assert.equal(page.location.hash, "");
});

test("no pass in the URL: nothing is touched and nothing is provisioned", async () => {
  const page = fakePage("#/roster");
  let provisioned = false;
  const result = await bootFromFragment({
    location: page.location,
    history: page.history,
    provision: async () => (provisioned = true),
  });
  assert.equal(result, "none");
  assert.equal(provisioned, false);
  assert.deepEqual(page.urls, []);
});
