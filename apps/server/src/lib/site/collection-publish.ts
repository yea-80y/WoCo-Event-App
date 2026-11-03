/**
 * Publishing a site the browser built (#1032 slice 3).
 *
 * The client renders its site and lays out a collection that LINKS the shared
 * runtime release (`@woco/shared/site/collection`), then sends the six objects it
 * built. This server builds the same collection from the same inputs and the
 * release it holds, and stores the client's objects only when they are identical,
 * byte for byte: nothing reaches the site origin that the server did not render
 * itself. Admission is a rebuild, not a parse, so there is no manifest parser
 * here for a client to argue with. Since slice 4 it is the only way a site is
 * published: the server holds no copy of the runtime.
 */

import {
  buildEventPageCollection,
  buildSiteCollection,
  sameSiteObjects,
  SITE_HTML_MAX_BYTES,
  type SiteCollection,
  type SiteRenderUrls,
} from "@woco/shared/site/collection";
import { mantarayNodeAddress, resolveMantarayPath } from "@woco/shared/swarm/mantaray";
import { bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import { SITE_RUNTIME_INDEX_DOCUMENT } from "@woco/shared";
import type { EventPageConfig, EventPageHead, Site, SiteRuntimeLine, SiteRuntimeRelease, SiteRuntimeRoot, SiteRuntimeStore } from "@woco/shared";
import type { Context } from "hono";
import { BEE_URL } from "../../config/swarm.js";
import { siteRuntimeReleases } from "./runtime-release.js";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { CONTROL_JSON_MAX_BYTES, errorSnippet, readCapped, readCappedJson } from "../http/read-capped.js";

/** Everything a build needs from one store's copy of a release. */
export interface SiteRuntimeKit {
  version: number;
  /** Which runtime: websites ("site") or single-event pages ("eventPage"). */
  line: SiteRuntimeLine;
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

export function storeForTarget(target: "etherna" | "wocoBee"): SiteRuntimeStore {
  return target === "etherna" ? "etherna" : "woco";
}

async function ethernaAuth(): Promise<Record<string, string>> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");
  return { Authorization: `Bearer ${token}` };
}

/** The live readers: manifest nodes from the store itself, the template bytes from our bee. */
export const liveKitReads = {
  async node(store: SiteRuntimeStore, address: string): Promise<Uint8Array> {
    const url = store === "etherna" ? `${ETHERNA_FETCH_BASE}/bytes/${address}` : `${BEE_URL}/bytes/${address}`;
    const headers = store === "etherna" ? await ethernaAuth() : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`release node ${store} ${r.status}`);
    return readCapped(r, NODE_MAX_BYTES, "release manifest node");
  },
  async template(wocoRoot: string, indexDocument: string): Promise<Uint8Array> {
    const r = await fetch(`${BEE_URL}/bzz/${wocoRoot}/${indexDocument}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`release template ${r.status}`);
    return readCapped(r, TEMPLATE_MAX_BYTES, "release template");
  },
};

/**
 * One kit per store and release root, loaded once. The root node must hash to the
 * root the verified descriptor names, and the template must hash to the entry
 * `multi-site.html` resolves to under THAT store's root (each node on the way
 * checked against its address), so every byte of a kit is the signed release's.
 * The bytes come from our bee's copy for both stores: the same build. A template
 * a store erasure-coded would not match a plain `/bytes` hash and fails closed
 * (single-chunk today, ~400 B, so it does not arise).
 */
export function createSiteRuntimeKits(reads: typeof liveKitReads = liveKitReads) {
  const cache = new Map<string, Promise<SiteRuntimeKit>>();
  return {
    kit(release: SiteRuntimeRelease, line: SiteRuntimeLine, store: SiteRuntimeStore): Promise<SiteRuntimeKit> {
      const lineRelease = release.runtimes[line];
      const root = lineRelease.roots[store];
      if (!root) return Promise.reject(new Error(`release v${release.version} has no ${line} ${store} root`));
      const index = SITE_RUNTIME_INDEX_DOCUMENT[line];
      const key = `${line}:${store}:${root.root}`;
      let p = cache.get(key);
      if (!p) {
        p = (async () => {
          const [rootNode, templateBytes] = await Promise.all([reads.node(store, root.root), reads.template(lineRelease.roots.woco.root, index)]);
          if (mantarayNodeAddress(rootNode) !== root.root) throw new Error(`release ${line} ${store} root node does not match its address`);
          const entry = await resolveMantarayPath(rootNode, index, (a) => reads.node(store, a));
          if (bytesTreeRoot(templateBytes) !== entry) throw new Error(`release ${line} ${store} template does not match its root`);
          const template = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(templateBytes);
          return { version: release.version, line, store, release: root, rootNode, template };
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

/**
 * GET .../runtime/kit/:store - what a browser needs to build a page of `line` on
 * the current release: the store's release root node and the template. Nothing
 * here is trusted by a deploy, which rebuilds from its own copy; the browser
 * checks the node against the descriptor's root itself. Public, a minute's cache.
 */
export async function serveRuntimeKit(c: Context, line: SiteRuntimeLine): Promise<Response> {
  const store = c.req.param("store");
  if (store !== "woco" && store !== "etherna") return c.json({ ok: false, error: "unknown store" }, 400);
  const release = siteRuntimeReleases.peek() ?? (await siteRuntimeReleases.get());
  if (!release) return c.json({ ok: false, error: "No site runtime release is available", code: "RUNTIME_RELEASE_UNAVAILABLE" }, 503);
  try {
    const kit = await siteRuntimeKits.kit(release, line, store);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      ok: true,
      data: {
        version: kit.version,
        line,
        store,
        release: kit.release,
        rootNode: Buffer.from(kit.rootNode).toString("base64"),
        template: kit.template,
      },
    });
  } catch (e) {
    console.warn(`[runtime/kit] ${line} ${store}: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ ok: false, error: "The site runtime is unavailable right now", code: "RUNTIME_RELEASE_UNAVAILABLE" }, 503);
  }
}

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

/**
 * The one admission rule for every page kind: the server's own `build` (from its
 * own inputs and kit) must equal the client's objects byte for byte, and only the
 * server's build is returned for storing.
 */
export function admitBuild(input: {
  kit: SiteRuntimeKit;
  received: { runtimeVersion: number; objects: Uint8Array[] };
  build: () => SiteCollection;
}): CollectionVerdict {
  if (input.received.runtimeVersion !== input.kit.version) {
    return { ok: false, code: "RUNTIME_RELEASE_CHANGED", error: `the site runtime is now v${input.kit.version}` };
  }
  let expected: SiteCollection;
  try {
    expected = input.build();
  } catch (e) {
    return { ok: false, code: "COLLECTION_MISMATCH", error: e instanceof Error ? e.message : "page could not be built" };
  }
  if (!sameSiteObjects(expected, input.received.objects)) {
    return { ok: false, code: "COLLECTION_MISMATCH", error: "the uploaded page differs from the server's build" };
  }
  return { ok: true, collection: expected };
}

/** Rebuild the site from the server's own inputs; admit the client's objects only if identical. */
export function admitClientCollection(input: {
  kit: SiteRuntimeKit;
  site: Site;
  urls: SiteRenderUrls;
  received: { runtimeVersion: number; objects: Uint8Array[] };
}): CollectionVerdict {
  return admitBuild({
    kit: input.kit,
    received: input.received,
    build: () => buildSiteCollection({ site: input.site, urls: input.urls, template: input.kit.template, release: input.kit.release, releaseRootNode: input.kit.rootNode }),
  });
}

/**
 * Rebuild a single-event page from the server's own config, the browser's checked
 * head and the deploy's checked name (#1032 slice 5, canonical #70).
 */
export function admitClientEventPage(input: {
  kit: SiteRuntimeKit;
  config: EventPageConfig;
  head: EventPageHead;
  name?: string;
  received: { runtimeVersion: number; objects: Uint8Array[] };
}): CollectionVerdict {
  if (input.kit.line !== "eventPage") throw new Error("an event page is built on the eventPage line");
  return admitBuild({
    kit: input.kit,
    received: input.received,
    build: () =>
      buildEventPageCollection({
        config: input.config,
        head: input.head,
        name: input.name,
        template: input.kit.template,
        release: input.kit.release,
        releaseRootNode: input.kit.rootNode,
      }),
  });
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
        // Bee defaults an upload to DEFERRED: it returns once the node holds the
        // chunks and pushes them in the background, so every other reader waits.
        // Measured 2026-09-21 on 5 MB collections: 326 s deferred vs 171 s
        // without until the page opened from our bee (#613).
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
