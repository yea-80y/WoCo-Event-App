/**
 * An event page's name, pointed with no second tap (one-tap publish). The Deploy tap
 * confirms it's the holder and puts the owner key in memory; the pointer is then signed
 * SILENTLY in the background. What must hold: the silent signer can never start a passkey
 * sheet, only the event-page publish uses it, the tap's sheet opens before anything else
 * awaits, and a name is only ever pointed at this account's own feed manifest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventPageFeedTopic } from "@woco/shared";
import { HOLDER_KEY_MIN_REMAINING_MS, holderKeyReady } from "../src/lib/auth/seed-unlock-policy.ts";
import { HolderKeyLockedError } from "../src/lib/auth/holder-key-locked.ts";
import { ApiError } from "../src/lib/api/errors.ts";
import { assertOwnFeedManifest, FeedManifestMismatchError } from "../src/lib/swarm/feed-manifest-address.ts";
import { ATTEMPTS, SPACING_MS, autoPointName, type AutoPointDeps } from "../src/lib/sub-ens/auto-pointer.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const STORE = read("lib/auth/auth-store.svelte.ts");

function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

// hackathon.woco.eth: event 43becb36's page feed, signed by its organiser (feed-manifest.test.ts).
const EVENT_ID = "43becb36-2b71-4d55-bf23-6c18b6bed32f";
const SIGNER = "0xDAC2ff771c3867d6463c27dda8285a73811e8834";
const MANIFEST = "d24237682b360376b613321850e4e5e035823d68b2659392afea95162e7ca0b7";
const FEED = { owner: SIGNER, topic: eventPageFeedTopic(EVENT_ID) };

test("the tap's sheet is skipped only with the owner key in memory, an open seed and time to spare", () => {
  const now = 1_000_000;
  const ok = { ownerKeyInMemory: true, seedUnlocked: true, expiresAt: now + HOLDER_KEY_MIN_REMAINING_MS };
  assert.equal(holderKeyReady(ok, now), true);
  assert.equal(holderKeyReady({ ...ok, expiresAt: null }, now), true, "a window that closes with the tab");
  assert.equal(holderKeyReady({ ...ok, ownerKeyInMemory: false }, now), false, "a reload reopens the seed, not the key");
  assert.equal(holderKeyReady({ ...ok, seedUnlocked: false }, now), false);
  assert.equal(holderKeyReady({ ...ok, expiresAt: now + HOLDER_KEY_MIN_REMAINING_MS - 1 }, now), false, "the window could close under the work");
  assert.ok(HOLDER_KEY_MIN_REMAINING_MS >= 5 * 60_000, "far longer than a deploy, a mint and a relay");
});

test("a name is pointed only at this account's own feed manifest, worked out here", () => {
  assert.doesNotThrow(() => assertOwnFeedManifest(MANIFEST, FEED));
  assert.doesNotThrow(() => assertOwnFeedManifest(`0x${MANIFEST.toUpperCase()}`, FEED));
  assert.throws(() => assertOwnFeedManifest("ab".repeat(32), FEED), FeedManifestMismatchError);
  assert.throws(() => assertOwnFeedManifest(MANIFEST, { ...FEED, topic: eventPageFeedTopic("another-event") }), FeedManifestMismatchError);
  assert.throws(() => assertOwnFeedManifest(MANIFEST, { ...FEED, owner: "0x" + "11".repeat(20) }), FeedManifestMismatchError);
});

function fakeDeps(results: Array<unknown>): AutoPointDeps & { calls: number; waits: number[] } {
  const deps = {
    calls: 0,
    waits: [] as number[],
    point: async () => {
      const r = results[Math.min(deps.calls++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    wait: async (ms: number) => {
      deps.waits.push(ms);
    },
  };
  return deps;
}

const sign = async () => "0xsig";
const apiError = (code: string) => new ApiError(code, { ok: false, error: code });

test("background pointer: done on the first try, and nothing waits", async () => {
  const deps = fakeDeps(["0xtx"]);
  assert.deepEqual(await autoPointName("yourname", MANIFEST, FEED, sign, deps), { kind: "done" });
  assert.equal(deps.calls, 1);
  assert.deepEqual(deps.waits, []);
});

test("background pointer: a target that is not this account's is refused at once, with no button", async () => {
  const deps = fakeDeps([new FeedManifestMismatchError()]);
  const out = await autoPointName("yourname", MANIFEST, FEED, sign, deps);
  assert.equal(out.kind, "refused");
  assert.equal(deps.calls, 1);
});

test("background pointer: a lapsed key hands back to the button at once - it never retries into a sheet", async () => {
  const deps = fakeDeps([new HolderKeyLockedError()]);
  assert.deepEqual(await autoPointName("yourname", MANIFEST, FEED, sign, deps), { kind: "ask" });
  assert.equal(deps.calls, 1);
});

test("background pointer: a relay refusal goes to the button with its reason; only an expired signature is signed again", async () => {
  const limited = fakeDeps([apiError("rate_limited")]);
  const out = await autoPointName("yourname", MANIFEST, FEED, sign, limited);
  assert.equal(out.kind, "ask");
  assert.equal((out as { error?: ApiError }).error?.code, "rate_limited");
  assert.equal(limited.calls, 1);

  const expired = fakeDeps([apiError("signature_expired"), "0xtx"]);
  assert.deepEqual(await autoPointName("yourname", MANIFEST, FEED, sign, expired), { kind: "done" });
  assert.equal(expired.calls, 2);
});

test("background pointer: a name the RPC cannot see yet is tried again, spaced, then handed to the button", async () => {
  const lag = new Error("execution reverted");
  const late = fakeDeps([lag, lag, "0xtx"]);
  assert.deepEqual(await autoPointName("yourname", MANIFEST, FEED, sign, late), { kind: "done" });
  assert.deepEqual(late.waits, [SPACING_MS, SPACING_MS]);

  const never = fakeDeps([lag]);
  assert.deepEqual(await autoPointName("yourname", MANIFEST, FEED, sign, never), { kind: "ask", error: lag });
  assert.equal(never.calls, ATTEMPTS);
});

test("the silent signer refuses before any ceremony could start, after the awaits that a closing window can outlast", () => {
  const kernel = body(STORE, "async function _ensureKernel(");
  const deviceGate = kernel.indexOf("await _boundKernelFor(");
  const guard = kernel.indexOf("if (opts.silent && !(_passkeyPrivateKey && _passkeyPrfSecret && _seedAddress)) throw new HolderKeyLockedError();");
  const ceremony = kernel.indexOf("await _ensurePasskeyKey();");
  assert.ok(deviceGate >= 0 && guard > deviceGate && ceremony > guard, "device gate -> silent guard -> ceremony");
  assert.match(kernel.slice(deviceGate, guard), /_expireUnlockIfDue\(\);/, "a window that closed meanwhile relocks first");
  const holder = body(STORE, "async function signTypedDataAsHolder(");
  assert.match(holder, /if \(opts\.silent && _kind === "web3"\) throw new HolderKeyLockedError\(\);/, "a wallet always asks");
  assert.match(holder, /await _ensureKernelForKind\(opts\);/);
  assert.match(body(STORE, "async function _ensureKernelForKind("), /return _ensureKernel\(opts\);/);
});

test("only the event-page publish signs as the holder silently; a name release never can", () => {
  const silent: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel === "lib/auth/auth-store.svelte.ts") continue; // the definition; its own wrapper is pinned below
    if (/signTypedDataAsHolder\([^)]*silent/.test(readFileSync(file, "utf8"))) silent.push(rel);
  }
  assert.deepEqual(silent.sort(), ["lib/creator/SiteBuilder.svelte", "lib/creator/builder/MultiSiteBuilder.svelte"].sort());
  assert.match(STORE, /signTypedDataAsHolder: \(typed\) => signTypedDataAsHolder\(typed as Parameters<typeof signTypedDataAsHolder>\[0\]\),/);
  assert.match(read("lib/creator/builder/DiscardNameDialog.svelte"), /signTypedData: \(typed: ReleaseTypedData\) => auth\.signTypedDataAsHolder\(typed\)/);
  const builder = read("lib/creator/SiteBuilder.svelte");
  const point = body(builder, "async function pointName(");
  assert.equal(builder.match(/signTypedDataAsHolder\(/g)?.length, 1, "the publish screen signs in one place");
  assert.match(point, /auth\.signTypedDataAsHolder\(typed, \{ silent: true \}\)/);
  assert.match(point, /!auth\.isAccountOwner/, "an added device never tries");
});

test("the Deploy tap asks for the key before anything else awaits, so its sheet may open", () => {
  const builder = read("lib/creator/SiteBuilder.svelte");
  const deploy = body(builder, "async function handleDeploy(");
  const confirm = deploy.indexOf("await auth.ensureOrganiserUnlock({ holderKey: !!nameToPoint && auth.isAccountOwner });");
  assert.ok(confirm > 0);
  assert.doesNotMatch(deploy.slice(0, confirm), /await /, "nothing may await before the tap's passkey sheet");
  // The work it signs for runs after step 3 appears, never before.
  assert.ok(deploy.indexOf("step = 3;") < deploy.indexOf("void runSubEnsTask();"));
  const unlock = body(STORE, "async function ensureOrganiserUnlock(");
  assert.match(unlock, /if \(opts\.holderKey && !_deviceRole\) \{\s*if \(holderKeyReady\(/);
  assert.match(unlock, /await _freshMainPasskey\(\);/, "the fresh confirm, which re-stamps the window");
});

test("the background path reaches the manifest check: no other pointer function is wired in", () => {
  assert.match(
    body(read("lib/sub-ens/pointer.ts"), "export async function pointNameAtFeed("),
    /assertOwnFeedManifest\(manifest, feed\);\s*return pointNameAt\(label, manifest, signTypedData\);/,
  );
  assert.match(read("lib/sub-ens/auto-pointer.ts"), /point: async \(\.\.\.args\) => \(await import\("\.\/pointer\.js"\)\)\.pointNameAtFeed\(\.\.\.args\),/);
  const point = body(read("lib/creator/SiteBuilder.svelte"), "async function pointName(");
  assert.match(point, /const kernelKind = auth\.kind === "passkey" \|\| auth\.kind === "web3auth";/, "a wallet goes straight to the button");
  assert.match(point, /\|\| !kernelKind\) \{\s*subEnsPhase = "sign";/);
  assert.match(point, /if \(outcome\.error instanceof ApiError\) \{/, "only a relay refusal is shown under the button");
});

test("a site's Publish tap asks first, and its name is pointed the same way as an event page's", () => {
  const msb = read("lib/creator/builder/MultiSiteBuilder.svelte");
  const publish = body(msb, "async function handlePublish(");
  const confirm = publish.indexOf("await auth.ensureOrganiserUnlock({ holderKey: !!siteNameToPoint });");
  assert.ok(confirm > 0);
  assert.doesNotMatch(publish.slice(0, confirm), /await /, "nothing may await before the tap's passkey sheet");
  assert.ok(confirm < publish.indexOf("noticeLetsPublish()"), "before the notice check reads the network");
  assert.match(publish, /signedWith = deployRes\.data\.multisiteFeed && feedSigner \? feedSigner\.address : null;/);
  assert.match(publish, /subEnsPointerFeed = signedWith \? \{ owner: signedWith, topic: multisiteFeedTopic\(site\.siteId\) \} : null;/);
  const point = body(msb, "async function pointSiteName(");
  assert.match(point, /if \(!feed \|\| p\.feedOwner !== 'client' \|\| !auth\.isAccountOwner \|\| !kernelKind\) return;/);
  assert.match(point, /autoPointName\(p\.label, p\.target, feed, \(typed\) => auth\.signTypedDataAsHolder\(typed, \{ silent: true \}\)\)/);
  assert.match(point, /outcome\.error instanceof ApiError/);
  assert.equal(msb.match(/signTypedDataAsHolder\(/g)?.length, 1, "the site builder signs in one place");
  assert.match(msb, /feed=\{subEnsPointerFeed \?\? undefined\}/, "the button checks the same feed");
  assert.match(msb, /disabled=\{publishState === 'publishing' \|\| subEnsPointing\}/);
  assert.match(publish, /if \(publishState === 'publishing' \|\| subEnsPointing \|\| publishArming\) return;/, "the Domain tab's Publish too");
  assert.match(publish, /publishArming = true;\s*try \{\s*await auth\.ensureOrganiserUnlock/, "a second tap behind the sheet starts nothing");
  assert.match(publish, /\} finally \{\s*publishArming = false;/);
  // A site opened while the name was being pointed keeps its own state.
  assert.match(point, /const siteId = site\.siteId;/);
  assert.match(point, /if \(outcome\.kind === 'done'\) setFollowingName\(p\.label, siteId\);\s*if \(site\.siteId !== siteId\) return;/);
  assert.match(msb, /ondone=\{\(\) => setFollowingName\(pointer\.label\)\}/);
  assert.match(msb, /auth\.isAccountOwner &&\s*\(auth\.kind === 'passkey' \|\| auth\.kind === 'web3auth'\)/, "a wallet is not told its name follows");
});

test("the button checks a feed target too, and a refused one offers no retry", () => {
  const prompt = read("lib/components/sub-ens/NamePointerPrompt.svelte");
  assert.match(prompt, /if \(targetIsFeed && feed\) await pointNameAtFeed\(label, target, feed, sign\);/);
  assert.match(prompt, /\{#if !refused\}/);
  const builder = read("lib/creator/SiteBuilder.svelte");
  assert.match(builder, /feed=\{pointerFollowsFeed && pageFeedOwner && createdEventId/);
  assert.match(body(builder, "async function pointName("), /subEnsNoRetry = true;/);
});
