/**
 * The site deploy's sub-ENS check (registry v2.2). A deploy never writes a
 * name: the name points at the site's feed manifest, the publish advances the
 * feed, and the name follows. The check says whether that still holds, and if
 * not, exactly what the holder should sign.
 *
 * Driven through the real `checkSiteSubEns` with the chain edges injected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSiteSubEns, type SitePointerDeps } from "../src/lib/sub-ens/site-pointer.js";

const ME = "0x" + "a".repeat(40);
const THEM = "0x" + "b".repeat(40);
const FEED = "c".repeat(64);
const OTHER = "d".repeat(64);
const record = (hash: string): string => `0xe40101fa011b20${hash}`;
const timeout = () => Object.assign(new Error("timeout"), { code: "TIMEOUT" });

function deps(over: Partial<SitePointerDeps> = {}): SitePointerDeps {
  return {
    readOwner: async () => ME,
    readContenthash: async () => null,
    isProfileName: () => false,
    ...over,
  };
}

test("a name already on the site's feed manifest is ok: no prompt, no write", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readContenthash: async () => record(FEED) }));
  assert.deepEqual(r, { label: "punkpub", status: "ok", target: FEED, feedOwner: "client" });
});

test("an empty name asks the holder to sign the feed manifest", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps());
  assert.deepEqual(r, { label: "punkpub", status: "awaiting_signature", target: FEED, feedOwner: "client" });
});

test("a name pointing elsewhere asks too — the organiser is told, never silently un-updated", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readContenthash: async () => record(OTHER) }));
  assert.equal(r.status, "awaiting_signature");
  assert.equal(r.status === "awaiting_signature" && r.target, FEED);
});

test("the answer says who authors the feed, so the client can say so before a signature", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "platform", deps());
  assert.equal(r.status === "awaiting_signature" && r.feedOwner, "platform");
});

test("the comparison is case-insensitive on both sides", async () => {
  const r = await checkSiteSubEns(
    "punkpub",
    ME.toUpperCase().replace("0X", "0x"),
    FEED.toUpperCase(),
    "client",
    deps({ readContenthash: async () => `0xE40101FA011B20${FEED.toUpperCase()}` }),
  );
  assert.equal(r.status, "ok");
});

test("a name held by someone else is skipped as not_owner", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readOwner: async () => THEM }));
  assert.deepEqual(r, { label: "punkpub", status: "skipped", reason: "not_owner" });
});

test("an unminted name is skipped as not_owner", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readOwner: async () => null }));
  assert.equal(r.status === "skipped" && r.reason, "not_owner");
});

test("an ownership read that FAILED is unverified — never an accusation", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readOwner: async () => { throw timeout(); } }));
  assert.equal(r.status === "skipped" && r.reason, "unverified");
});

test("the identity name is never offered a site", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ isProfileName: () => true }));
  assert.equal(r.status === "skipped" && r.reason, "profile_name");
});

test("no feed manifest this deploy: nothing stable to offer", async () => {
  const r = await checkSiteSubEns("punkpub", ME, "", "client", deps());
  assert.equal(r.status === "skipped" && r.reason, "no_feed_manifest");
});

test("a contenthash read that FAILED is unverified, not a prompt to re-sign", async () => {
  const r = await checkSiteSubEns("punkpub", ME, FEED, "client", deps({ readContenthash: async () => { throw timeout(); } }));
  assert.equal(r.status === "skipped" && r.reason, "unverified");
});

test("the deploy route writes no name and hands the feed owner through", () => {
  const src = readFileSync(new URL("../src/routes/sites.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(src, /relaySignedContenthash|updateSubEnsContenthash|setContenthash/);
  assert.match(
    src,
    /checkSiteSubEns\(site\.subEnsLabel, parentAddress, feedManifestHash, feedOwnerSigner \? "client" : "platform"\)/,
  );
});

test("the default contenthash read throws on a fault instead of answering 'unset'", () => {
  // Both callers ask the holder to sign on an "unset" answer; a swallowed fault
  // would prompt a holder to overwrite a pointer they chose.
  const chain = readFileSync(new URL("../src/lib/chain/sub-ens-contract.ts", import.meta.url), "utf-8");
  const start = chain.indexOf("export async function getLabelContenthash");
  const end = chain.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(chain.slice(start, end), /catch/);
});
