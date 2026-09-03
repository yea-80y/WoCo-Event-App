/**
 * The three points where a sub-ENS name gets pointed at content, and the two
 * mint rails' rate-cap handling.
 *
 * The rule these enforce: an account's PROFILE name is its identity and must
 * never become a site or event URL. Nothing on-chain can express that — a
 * registry says who HOLDS a name, never what it is FOR — so the refusal is a
 * server decision, and this is where it is pinned.
 *
 * Routes here sit behind `requireAuth` and a chain read, and this suite has no
 * harness for either (`mock.module` is unavailable under the tsx loader). So
 * the DECISIONS are extracted as pure functions and tested exhaustively below,
 * and a source guard asserts each route still consults them — which is the
 * regression that actually happens: not a wrong comparison, a forgotten call.
 * The source guard is stated as what it is; it does not prove the routes behave.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "woco-binding-points-")));

const { bindProfileName, isProfileName, unbindProfileName } = await import(
  "../src/lib/profile/name-ledger.js"
);
const { mintRateCapVerdict } = await import("../src/lib/chain/sub-ens-contract.js");

let n = 0;
const acct = (): string => `0x${(++n).toString(16).padStart(40, "b")}`;

// ---------------------------------------------------------------------------
// The profile-name refusal (points A, B, C)
// ---------------------------------------------------------------------------

test("a name nobody has bound is not a profile name", () => {
  assert.equal(isProfileName(acct(), "punkpub"), false);
});

test("the bound name IS the profile name", () => {
  const A = acct();
  bindProfileName(A, "punkpub");
  assert.equal(isProfileName(A, "punkpub"), true);
});

test("the account's OTHER names are not its profile name", () => {
  const A = acct();
  bindProfileName(A, "punkpub");
  assert.equal(isProfileName(A, "punkpub-gigs"), false);
});

test("one account's profile name does not block another account's use of it", () => {
  // Only the HOLDER can reach these routes at all (ownership is checked first),
  // so this asserts the refusal is scoped to the account, not the label —
  // otherwise a released-then-re-minted name would be permanently unusable.
  const A = acct();
  const B = acct();
  bindProfileName(A, "punkpub");
  assert.equal(isProfileName(B, "punkpub"), false);
});

test("the refusal is case-insensitive on both the account and the label", () => {
  const A = acct();
  bindProfileName(A, "punkpub");
  assert.equal(isProfileName(A.toUpperCase(), "PunkPub"), true);
});

test("an unbound name stops being the profile name, so it can be used as a URL", () => {
  const A = acct();
  bindProfileName(A, "punkpub");
  unbindProfileName(A);
  assert.equal(isProfileName(A, "punkpub"), false);
});

// ---------------------------------------------------------------------------
// #471 — the mint rate cap
// ---------------------------------------------------------------------------

test("allowance remaining means proceed", () => {
  assert.equal(mintRateCapVerdict({ remaining: 1, windowResetsAt: 999 }), null);
});

test("no allowance left is refused, and reports when the window resets", () => {
  const v = mintRateCapVerdict({ remaining: 0, windowResetsAt: 1234 });
  assert.deepEqual(v, { error: "mint_rate_cap", windowResetsAt: 1234 });
});

test("an UNREADABLE allowance proceeds — the cap is an abuse brake, not a gate", () => {
  // Failing closed here would turn any RPC blip into "nobody can mint a name",
  // which is a worse outage than the one the cap prevents. The contract still
  // enforces the cap regardless of what we managed to read.
  assert.equal(mintRateCapVerdict(null), null);
});

// ---------------------------------------------------------------------------
// Source guard — the forgotten call, not the wrong comparison
// ---------------------------------------------------------------------------

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

test("every route that points a name at content consults isProfileName", () => {
  const subEns = sourceOf("../src/routes/sub-ens.ts");
  // Point A (stamp-event) and point C (set-contenthash) are the two writers in
  // this file; both must refuse the caller's own profile name.
  assert.equal(
    (subEns.match(/isProfileName\(/g) ?? []).length,
    2,
    "stamp-event and set-contenthash must each check isProfileName",
  );
  assert.match(subEns, /"profile_name"/);

  // Point B — the site deploy hook.
  const sites = sourceOf("../src/routes/sites.ts");
  assert.match(sites, /isProfileName\(/);
  assert.match(sites, /profile_name/);
});

test("both mint rails pre-flight the rate cap", () => {
  const subEns = sourceOf("../src/routes/sub-ens.ts");
  assert.equal(
    (subEns.match(/mintRateCapVerdict\(/g) ?? []).length,
    2,
    "/claim and /permit must each pre-flight the mint rate cap (#471)",
  );
  // …and the sponsor rail also maps the revert, because the pre-flight read can
  // race a concurrent mint and is skipped when the RPC is down.
  assert.match(subEns, /MintRateCapExceeded/);
});

test("the deploy response reports what happened to the name instead of skipping silently", () => {
  const sites = sourceOf("../src/routes/sites.ts");
  assert.match(sites, /not_owner/);
  assert.match(sites, /subEns \? \{ subEns \} : \{\}/);
});
