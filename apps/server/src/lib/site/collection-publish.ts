/**
 * Publishing a site the browser built (#1032 slice 3).
 *
 * The client renders its site and lays out a collection that LINKS the shared
 * runtime release (`@woco/shared/site/collection`), then sends the six objects it
 * built. This server builds the same collection from the same inputs and the
 * release it holds, and stores the client's objects only when they are identical,
 * byte for byte: nothing reaches the site origin that the server did not render
 * itself. Admission is a rebuild, not a parse, so there is no manifest parser
 * here for a client to argue with.
 *
 * Behind `SITE_CLIENT_PUBLISH` (unset = off; `all`; or a comma list of account
 * addresses). Off for an account, the deploy ignores the collection and builds
 * the old way.
 */

import {
  buildSiteCollection,
  sameSiteObjects,
  SITE_HTML_MAX_BYTES,
  type SiteCollection,
  type SiteRenderUrls,
} from "@woco/shared/site/collection";
import { mantarayNodeAddress } from "@woco/shared/swarm/mantaray";
import type { Site, SiteRuntimeRelease, SiteRuntimeRoot, SiteRuntimeStore } from "@woco/shared";
import { BEE_URL } from "../../config/swarm.js";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { CONTROL_JSON_MAX_BYTES, errorSnippet, readCapped, readCappedJson } from "../http/read-capped.js";

/** Everything a build needs from one store's copy of a release. */
export interface SiteRuntimeKit {
  version: number;
  store: SiteRuntimeStore;
  release: SiteRuntimeRoot;
  rootNode: Uint8Array;
  template: string;
}

const NODE_MAX_BYTES = 4096;
const TEMPLATE_MAX_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 20_000;
/** Six objects, the largest the HTML tree: bounds what a deploy body can make us decode. */
export const CLIENT_COLLECTION_MAX_OBJECTS = 8;
export const CLIENT_COLLECTION_MAX_BYTES = SITE_HTML_MAX_BYTES + 64 * 1024;

export function clientPublishAllowed(parentAddress: string, setting = process.env.SITE_CLIENT_PUBLISH): boolean {
  const s = (setting ?? "").trim().toLowerCase();
  if (!s) return false;
  if (s === "all") return true;
  return s.split(",").map((a) => a.trim()).includes(parentAddress.toLowerCase());
}

export function storeForTarget(target: "etherna" | "wocoBee"): SiteRuntimeStore {
  return target === "etherna" ? "etherna" : "woco";
}

async function ethernaAuth(): Promise<Record<string, string>> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");
  return { Authorization: `Bearer ${token}` };
}

/** The live readers: our bee for its root and the template, Etherna for its root. */
export const liveKitReads = {
  async rootNode(store: SiteRuntimeStore, root: string): Promise<Uint8Array> {
    const url = store === "etherna" ? `${ETHERNA_FETCH_BASE}/bytes/${root}` : `${BEE_URL}/bytes/${root}`;
    const headers = store === "etherna" ? await ethernaAuth() : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`release root ${store} ${r.status}`);
    return readCapped(r, NODE_MAX_BYTES, "release root node");
  },
  async template(wocoRoot: string): Promise<string> {
    const r = await fetch(`${BEE_URL}/bzz/${wocoRoot}/multi-site.html`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`release template ${r.status}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(await readCapped(r, TEMPLATE_MAX_BYTES, "release template"));
  },
};

/**
 * One kit per store and release root, loaded once. The root node must hash to the
 * root the verified descriptor names; the template is the same build on both
 * stores, read from our bee's copy.
 */
export function createSiteRuntimeKits(reads: typeof liveKitReads = liveKitReads) {
  const cache = new Map<string, Promise<SiteRuntimeKit>>();
  return {
    kit(release: SiteRuntimeRelease, store: SiteRuntimeStore): Promise<SiteRuntimeKit> {
      const root = release.roots[store];
      if (!root) return Promise.reject(new Error(`release v${release.version} has no ${store} root`));
      const key = `${store}:${root.root}`;
      let p = cache.get(key);
      if (!p) {
        p = (async () => {
          const [rootNode, template] = await Promise.all([reads.rootNode(store, root.root), reads.template(release.roots.woco.root)]);
          if (mantarayNodeAddress(rootNode) !== root.root) throw new Error(`release ${store} root node does not match its address`);
          return { version: release.version, store, release: root, rootNode, template };
        })();
        // A failed load is retried on the next publish, never cached.
        p.catch(() => cache.delete(key));
        cache.set(key, p);
      }
      return p;
    },
  };
}

export const siteRuntimeKits = createSiteRuntimeKits();

/** The deploy body's `collection`, decoded and bounded. Null when malformed. */
export function decodeClientCollection(raw: unknown): { runtimeVersion: number; objects: Uint8Array[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { runtimeVersion?: unknown; objects?: unknown };
  if (!Number.isSafeInteger(c.runtimeVersion) || (c.runtimeVersion as number) < 1) return null;
  if (!Array.isArray(c.objects) || c.objects.length === 0 || c.objects.length > CLIENT_COLLECTION_MAX_OBJECTS) return null;
  let total = 0;
  const objects: Uint8Array[] = [];
  for (const o of c.objects) {
    if (typeof o !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(o)) return null;
    total += Math.floor((o.length * 3) / 4);
    if (total > CLIENT_COLLECTION_MAX_BYTES) return null;
    objects.push(new Uint8Array(Buffer.from(o, "base64")));
  }
  return { runtimeVersion: c.runtimeVersion as number, objects };
}

export type CollectionVerdict =
  | { ok: true; collection: SiteCollection }
  | { ok: false; code: "RUNTIME_RELEASE_CHANGED" | "COLLECTION_MISMATCH"; error: string };

/** Rebuild the site from the server's own inputs; admit the client's objects only if identical. */
export function admitClientCollection(input: {
  kit: SiteRuntimeKit;
  site: Site;
  urls: SiteRenderUrls;
  received: { runtimeVersion: number; objects: Uint8Array[] };
}): CollectionVerdict {
  if (input.received.runtimeVersion !== input.kit.version) {
    return { ok: false, code: "RUNTIME_RELEASE_CHANGED", error: `the site runtime is now v${input.kit.version}` };
  }
  let expected: SiteCollection;
  try {
    expected = buildSiteCollection({ site: input.site, urls: input.urls, template: input.kit.template, release: input.kit.release, releaseRootNode: input.kit.rootNode });
  } catch (e) {
    return { ok: false, code: "COLLECTION_MISMATCH", error: e instanceof Error ? e.message : "site could not be built" };
  }
  if (!sameSiteObjects(expected, input.received.objects)) {
    return { ok: false, code: "COLLECTION_MISMATCH", error: "the uploaded site differs from the server's build" };
  }
  return { ok: true, collection: expected };
}

/**
 * Store each object with `/bytes` at redundancy 0 (bee 2.8.1 would erasure-code
 * by default and change every address) and insist the store returns the address
 * we computed. Root last, so the root never exists before what it points at.
 */
export async function uploadSiteObjects(
  target: "etherna" | "wocoBee",
  batchId: string,
  collection: SiteCollection,
): Promise<number> {
  const base = target === "etherna" ? ETHERNA_FETCH_BASE : BEE_URL;
  const auth = target === "etherna" ? await ethernaAuth() : {};
  let bytes = 0;
  for (const o of collection.objects) {
    const r = await fetch(`${base}/bytes`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/octet-stream",
        "Swarm-Postage-Batch-Id": batchId,
        "Swarm-Redundancy-Level": "0",
        "Swarm-Deferred-Upload": "false",
      },
      body: o.data as unknown as BodyInit,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS * 3),
    });
    if (!r.ok) throw new Error(`site object upload failed ${r.status}: ${await errorSnippet(r, 200)}`);
    const { reference } = await readCappedJson<{ reference?: string }>(r, CONTROL_JSON_MAX_BYTES, "site object upload");
    if (String(reference).toLowerCase() !== o.address) {
      throw new Error(`site object stored at ${String(reference).slice(0, 12)}, expected ${o.address.slice(0, 12)}`);
    }
    bytes += o.data.length;
  }
  return bytes;
}
