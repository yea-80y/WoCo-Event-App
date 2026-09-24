/**
 * A second profile save within minutes of the first must not revert it (#651).
 *
 * The profile feed is written through Etherna. Etherna has the new version at
 * once; our own bee only minutes later. The save is a read-modify-write: it reads
 * the current profile, overlays the edited fields, and writes the whole thing
 * back. So its base read must see what Etherna holds, and the form must not
 * re-send fields it merely displayed.
 *
 * The client read (`probeSoc`) cannot load under this runner - it imports the
 * auth store, a runes module - so the behaviour is proven against the REAL shared
 * resolver with a model of the two nodes, and the wiring that selects that
 * behaviour is pinned in source. The model is exactly what the server answers for
 * a thorough read (`soc-read.ts`): our bee always, Etherna only when the read
 * names it; any found wins, then any unanswered, else absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  contentFeedSocIdentifier,
  mergeProfileText,
  profileDataContentTopic,
  readVersionedContentFeed,
  versionedSocIdentifier,
  type SocChunkProbe,
  type SocReadOutcome,
  type UserProfile,
  type VersionedFeedRead,
} from "@woco/shared";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";
import {
  PROFILE_BASE_RELOAD,
  PROFILE_BASE_RETRY,
  changedProfileFields,
  profileSaveBase,
  type ProfileFormFields,
} from "../src/lib/api/profile-save.js";

const ADDR = `0x${"ab".repeat(20)}` as UserProfile["address"];
const TOPIC = profileDataContentTopic(ADDR);
const BASE = contentFeedSocIdentifier(TOPIC);
const key = (id: Uint8Array) => Buffer.from(id).toString("hex");
const at = (version: number) => key(versionedSocIdentifier(BASE, version));
const stored = (p: Partial<UserProfile>) => new TextEncoder().encode(JSON.stringify(p));

const BEFORE: Partial<UserProfile> = { v: 1, address: ADDR, displayName: "Nabil", bio: "old bio" };
const SAVED: Partial<UserProfile> = { v: 1, address: ADDR, displayName: "Nabil", bio: "new bio", website: "https://woco.eth.limo" };

interface Nodes {
  ourBee: Map<string, Uint8Array>;
  etherna: Map<string, Uint8Array>;
  ethernaDown?: boolean;
}

/** A thorough read as the server answers it. `routed` = the read named Etherna. */
function thoroughRead(nodes: Nodes, routed: boolean): SocChunkProbe {
  return async (id) => {
    const k = key(id);
    const answers: SocReadOutcome[] = [
      nodes.ourBee.has(k) ? { status: "found", bytes: nodes.ourBee.get(k)! } : { status: "absent" },
    ];
    if (routed) {
      answers.push(
        nodes.ethernaDown
          ? { status: "unavailable", reason: "etherna unreachable" }
          : nodes.etherna.has(k) ? { status: "found", bytes: nodes.etherna.get(k)! } : { status: "absent" },
      );
    }
    const found = answers.find((a) => a.status === "found");
    if (found) return found;
    if (answers.some((a) => a.status === "unavailable")) return { status: "unavailable", reason: "a source could not answer" };
    return { status: "absent" };
  };
}

/** The mapping `readContentFeedResult` applies to the resolver's answer. */
function asResult(r: VersionedFeedRead): ContentFeedResult<UserProfile> {
  if (r.status !== "found") return r;
  return {
    status: "found",
    value: JSON.parse(new TextDecoder().decode(r.bytes)) as UserProfile,
    version: r.version,
    scanClean: r.scanClean,
  };
}

/** Version 0 everywhere; version 1 was just saved through Etherna and has not reached our bee. */
function savedMomentsAgo(): Nodes {
  return {
    ourBee: new Map([[at(0), stored(BEFORE)]]),
    etherna: new Map([[at(0), stored(BEFORE)], [at(1), stored(SAVED)]]),
  };
}

// ---------------------------------------------------------------------------
// The behaviour
// ---------------------------------------------------------------------------

test("unrouted, a save's base read returns the version BEFORE the last save - and calls it clean", async () => {
  // Hint 1 is the device that just saved; hint 0 is any other device. Neither
  // helps: the hinted version reads absent, so the scan restarts and stops at 0.
  for (const hint of [0, 1]) {
    const res = await readVersionedContentFeed(thoroughRead(savedMomentsAgo(), false), TOPIC, hint);
    assert.equal(res.status, "found");
    assert.equal((res as { version: number }).version, 0, `hint ${hint}`);
    // CLEAN, so nothing downstream can tell it is stale. This is why the base rule
    // alone cannot fix #651 and the read must be routed.
    assert.equal((res as { scanClean: boolean }).scanClean, true, `hint ${hint}`);
    const base = profileSaveBase(asResult(res));
    assert.deepEqual(base, { ok: true, base: BEFORE }, "the stale base is accepted - the bug");
  }
});

test("routed to Etherna, the base read returns the version just saved", async () => {
  for (const hint of [0, 1]) {
    const res = await readVersionedContentFeed(thoroughRead(savedMomentsAgo(), true), TOPIC, hint);
    assert.equal(res.status, "found");
    assert.equal((res as { version: number }).version, 1, `hint ${hint}`);
    assert.deepEqual(profileSaveBase(asResult(res)), { ok: true, base: SAVED });
  }
});

test("a brand-new profile: unrouted reads 'none yet', which blanks the first save; routed finds it", async () => {
  const nodes: Nodes = { ourBee: new Map(), etherna: new Map([[at(0), stored(SAVED)]]) };

  // skipLegacy: the legacy probe is a third read of the same missing chunk and
  // changes nothing here - it is only a fallback for pre-versioning feeds.
  const unrouted = await readVersionedContentFeed(thoroughRead(nodes, false), TOPIC, 0, { skipLegacy: true });
  assert.deepEqual(unrouted, { status: "absent" });
  assert.deepEqual(profileSaveBase(asResult(unrouted)), { ok: true, base: null }, "merge starts empty - the bug");

  const routed = await readVersionedContentFeed(thoroughRead(nodes, true), TOPIC, 0, { skipLegacy: true });
  assert.deepEqual(profileSaveBase(asResult(routed)), { ok: true, base: SAVED });
});

test("routed while Etherna cannot answer: the save refuses rather than merge onto an older version", async () => {
  const existing = { ...savedMomentsAgo(), ethernaDown: true };
  const res = await readVersionedContentFeed(thoroughRead(existing, true), TOPIC, 1);
  // The best the scan could reach is version 0, and it says so.
  assert.equal(res.status, "found");
  assert.equal((res as { scanClean: boolean }).scanClean, false);
  assert.deepEqual(profileSaveBase(asResult(res)), { ok: false, error: PROFILE_BASE_RETRY });

  const brandNew: Nodes = { ourBee: new Map(), etherna: new Map([[at(0), stored(SAVED)]]), ethernaDown: true };
  const res2 = await readVersionedContentFeed(thoroughRead(brandNew, true), TOPIC, 0, { skipLegacy: true });
  assert.equal(res2.status, "unavailable");
  assert.deepEqual(profileSaveBase(asResult(res2)), { ok: false, error: PROFILE_BASE_RETRY });
});

// ---------------------------------------------------------------------------
// The base rule
// ---------------------------------------------------------------------------

test("the base rule: only 'none' or a clean found may be merged onto", () => {
  const value = SAVED as UserProfile;
  assert.deepEqual(profileSaveBase({ status: "absent" }), { ok: true, base: null });
  assert.deepEqual(profileSaveBase({ status: "found", value, version: 3, scanClean: true }), { ok: true, base: value });
  assert.deepEqual(
    profileSaveBase({ status: "found", value, version: 3, scanClean: false }),
    { ok: false, error: PROFILE_BASE_RETRY },
    "a found under a dirty scan may be stale",
  );
  assert.deepEqual(profileSaveBase({ status: "unavailable", reason: "x" }), { ok: false, error: PROFILE_BASE_RETRY });
  assert.deepEqual(
    profileSaveBase({ status: "unavailable", reason: "x", unusableAt: 3 }),
    { ok: false, error: PROFILE_BASE_RELOAD },
    "a permanent verdict is not a connection problem (#190)",
  );
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

const LOADED: ProfileFormFields = {
  displayName: "Nabil", bio: "old bio", website: "", twitterHandle: "nabil", farcasterHandle: "",
};

test("the form sends only what was changed, never the stale values it merely displayed", () => {
  assert.deepEqual(changedProfileFields({ ...LOADED }, LOADED), {}, "nothing changed");
  assert.deepEqual(changedProfileFields({ ...LOADED, displayName: "Nabs" }, LOADED), { displayName: "Nabs" });
  assert.deepEqual(changedProfileFields({ ...LOADED, website: "https://x.io" }, LOADED), { website: "https://x.io" });
  assert.deepEqual(changedProfileFields({ ...LOADED, bio: "new bio" }, LOADED), { bio: "new bio" });
  assert.deepEqual(changedProfileFields({ ...LOADED, bio: "old bio" }, LOADED), {}, "changed back = unchanged");
});

test("a field the user emptied is sent as null, and the save removes it (#652)", () => {
  const changes = changedProfileFields({ ...LOADED, twitterHandle: "" }, LOADED);
  assert.deepEqual(changes, { twitterHandle: null });
  const saved = mergeProfileText(changes, { displayName: "Nabil", bio: "old bio", twitterHandle: "nabil" });
  assert.deepEqual(saved, { displayName: "Nabil", bio: "old bio" });
});

test("an empty field the user never touched is not sent, so an empty form cannot clear anything (#171)", () => {
  // The form loads empty when its read fails. Only a field the user changed may
  // be cleared; everything else must keep what the profile holds.
  const blank: ProfileFormFields = { displayName: "", bio: "", website: "", twitterHandle: "", farcasterHandle: "" };
  assert.deepEqual(changedProfileFields({ ...blank, displayName: "Nabil" }, blank), { displayName: "Nabil" });
});

// ---------------------------------------------------------------------------
// The wiring the behaviour depends on
// ---------------------------------------------------------------------------

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments stripped: these files NAME the wrong call in order to warn about it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const probeCalls = (s: string) => [...code(s).matchAll(/probeSoc\(([^)]*)\)/g)].map((m) => m[1]);

test("every feed probe in the read and read-back paths forwards the feed's gateway", () => {
  for (const file of ["../src/lib/swarm/content-feed.ts", "../src/lib/swarm/verified-write.ts"]) {
    const calls = probeCalls(src(file));
    assert.ok(calls.length > 0, `${file}: no probeSoc call found - the check would pass vacuously`);
    // The caller's own route, not merely the word: `gatewayUrl: undefined` compiles.
    for (const args of calls) assert.match(args, /gatewayUrl:\s*(?:opts|args)\.route\.gatewayUrl\b/, `${file}: probeSoc(${args})`);
  }
});

test("the profile save reads its base from Etherna and merges only onto what the base rule accepts", () => {
  const profiles = code(src("../src/lib/api/profiles.ts"));
  const save = profiles.slice(profiles.indexOf("export async function updateProfile("), profiles.indexOf("export async function uploadAvatar("));
  const baseRead = save.slice(save.indexOf("readContentFeedResult<UserProfile>("), save.indexOf("profileSaveBase("));
  assert.match(baseRead, /thorough:\s*true/);
  assert.match(baseRead, /route:\s*FEED_ROUTES\.profile\b/);
  assert.match(save, /const base = profileSaveBase\(existingRead\);\s*if \(!base\.ok\) throw new Error\(base\.error\);\s*const existing = base\.base;/);
  // The text fields go through the shared rule, the same one the server uses (#652).
  assert.match(save, /\.\.\.mergeProfileText\(updates, existing\)/);
  assert.doesNotMatch(save, /updates\.(?:displayName|bio|website|twitterHandle|farcasterHandle) \?\?/);
});

const page = () => code(src("../src/lib/components/profile/ProfilePage.svelte"));
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `not found: ${from} .. ${to}`);
  return s.slice(a, b);
};

test("the profile page sends the changed fields, not the whole form", () => {
  const save = between(page(), "async function saveProfile()", "async function guardRename()");
  assert.match(save, /updateProfile\(changes\)/);
  assert.doesNotMatch(save, /updateProfile\(\{\s*displayName:/);
});

test("the changes are decided before any signing prompt, so a no-op save asks for nothing", () => {
  const save = between(page(), "async function saveProfile()", "async function guardRename()");
  const decided = save.indexOf("changedProfileFields(formValues(), formLoaded)");
  const prompt = save.indexOf("ensureAccountSetup(");
  assert.ok(decided >= 0 && prompt > decided, "changes must be computed before ensureAccountSetup");
  assert.match(save.slice(decided, prompt), /if \(Object\.keys\(changes\)\.length === 0 && !pendingAvatarDataUrl\) \{ formDirty = false; return; \}/);
});

test("the form's baseline is the profile it was filled from, and the text just saved", () => {
  const init = between(page(), "function initForm()", "formDirty = false;");
  assert.match(init, /const loaded: ProfileFormFields = \{[\s\S]*profile\?\.displayName[\s\S]*\};[\s\S]*formLoaded = loaded;/);
  // A failed avatar upload must not leave the next save diffing against the old profile.
  const save = between(page(), "async function saveProfile()", "async function guardRename()");
  const rebased = save.indexOf("if (merged) profile = merged;");
  assert.ok(rebased >= 0 && rebased < save.indexOf("uploadAvatar("), "saved text becomes the baseline before the avatar upload");
});

test("switching account or profile clears the form, so typed text cannot reach another account", () => {
  const reset = between(page(), "let _prevView", "loadProfile();");
  assert.match(reset, /editName = "";[\s\S]*editFarcaster = "";/);
  assert.match(reset, /formLoaded = \{ displayName: "", bio: "", website: "", twitterHandle: "", farcasterHandle: "" \};/);
  assert.match(reset, /formDirty = false;/);
});
