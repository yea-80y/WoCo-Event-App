/**
 * A site's config is read under its owner's CURRENT signer (#186): the pointer names
 * the signer at publish time, and after a passkey is removed that one may be in the
 * removed device's hands - and the config carries the ticket-email Reply-To.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeJsonFeed } from "../src/lib/swarm/feeds.js";
import { resolveSiteConfig, type SiteConfigReaders } from "../src/lib/site/service.js";

const SITE = "site-ring-1";
const OWNER = "0x" + "aa".repeat(20);
const F0 = "0x" + "f0".repeat(20);
const F1 = "0x" + "f1".repeat(20);

function readers(ring: string | null | "unavailable", seen: string[]): SiteConfigReaders {
  return {
    readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed({ _woco_site_ptr: 1, ownerAddress: OWNER, siteFeedSigner: F0 }) }),
    readPointerTarget: async (owner) => {
      seen.push(`0x${owner}`);
      const bytes = new TextEncoder().encode(JSON.stringify({ siteId: SITE, contact: { email: `${owner.slice(0, 4)}@example.com` } }));
      return { status: "found", bytes, version: 0, scanClean: true } as never;
    },
    readPagesPage: async () => null,
    ownerRingSigner: async () => ring,
  };
}

test("no ring: the pointer's signer", async () => {
  const seen: string[] = [];
  const r = await resolveSiteConfig(SITE, readers(null, seen));
  assert.equal(r.status, "found");
  assert.deepEqual(seen, [F0]);
});

test("a ring: the config is read under the ring's signer, never the pointer's", async () => {
  const seen: string[] = [];
  const r = await resolveSiteConfig(SITE, readers(F1, seen));
  assert.equal(r.status, "found");
  assert.deepEqual(seen, [F1]);
  assert.equal(r.status === "found" && r.siteFeedSigner, F1);
});

test("keys that cannot be read: nothing is read", async () => {
  const seen: string[] = [];
  const r = await resolveSiteConfig(SITE, readers("unavailable", seen));
  assert.equal(r.status, "unavailable");
  assert.deepEqual(seen, []);
});
