/**
 * A published site as a Swarm collection that LINKS the shared runtime release
 * instead of carrying a copy (#1032 slice 3). The site's root is the release's
 * root with two files of its own: the rendered `multi-site.html` and its
 * `manifest.json`. Everything else (`assets/`, `icons/`, `logo.png`, the index
 * document metadata) is the release's own fork record, copied byte for byte, so a
 * site stores six small objects instead of ~9 MB.
 *
 * The browser builds this to publish, and the server builds it again from the
 * same inputs and admits the upload only when the two are identical: a client
 * can never put bytes on the site origin that the server did not render itself.
 * Imported by path (`@woco/shared/site/collection`), so the app loads it only
 * when an organiser publishes.
 */

import { bytesTreeChunks } from "../swarm/bytes-tree.js";
import {
  encodeMantarayFork,
  encodeMantarayNode,
  mantarayNodeAddress,
  parseMantarayNode,
  MANTARAY_TYPE_EDGE,
  MANTARAY_TYPE_METADATA,
  MANTARAY_TYPE_PATH_SEPARATOR,
  MANTARAY_TYPE_VALUE,
} from "../swarm/mantaray.js";
import { isEthernaGatewayUrl, isWocoGatewayUrl, WOCO_GATEWAY_URL } from "../swarm/feed-routes.js";
import { isSiteRuntimeFileType, type SiteRuntimeRoot, type SiteRuntimeStore } from "./runtime-release.js";
import { renderSiteHtml, sitePwaManifest } from "./render.js";
import type { Site } from "./types.js";

export const SITE_INDEX_DOCUMENT = "multi-site.html";
/** Both per-site files start with "m", so they hang off one "m" edge, as bee lays them out. */
const SITE_FILES_EDGE = "m";
const HTML_TYPE = "text/html; charset=utf-8";
const MANIFEST_TYPE = "application/json";
/** One intermediate chunk: the most a `/bytes` tree here may span (bytes-tree.ts). */
export const SITE_HTML_MAX_BYTES = 128 * 4096;

/** One stored object, written with `/bytes` (redundancy 0) and addressed by its tree root. */
export interface SiteCollectionObject {
  address: string;
  data: Uint8Array;
}

export interface SiteCollection {
  /** The site's manifest root, 64 hex. */
  root: string;
  /** Root node bytes (≤ 4096): what a client-owned pointer feed update carries. */
  rootNode: Uint8Array;
  /** Every new object, the root node last. The rest is linked from the release. */
  objects: SiteCollectionObject[];
}

/** The URLs a site is rendered with: origins only, exactly as the server forwards them. */
export interface SiteRenderUrls {
  apiUrl: string;
  gatewayUrl: string;
  wocoAppUrl: string;
  /** Set for sites stored on Etherna: event images still load from WoCo's bee. */
  contentGatewayUrl?: string;
}

/**
 * Which store a deploy to `gatewayUrl` lands on: the server's batch router sends
 * Etherna's gateway to Etherna and everything else to our bee (batch-router.ts).
 */
export function siteStoreForGateway(gatewayUrl: string): SiteRuntimeStore {
  return isEthernaGatewayUrl(gatewayUrl) && !isWocoGatewayUrl(gatewayUrl) ? "etherna" : "woco";
}

/**
 * The URLs a client renders with: each as its origin (the server forwards parsed
 * origins, deploy-config.ts), and Etherna-stored sites still load event images
 * from WoCo's bee.
 */
export function siteRenderUrls(input: { apiUrl: string; gatewayUrl: string; wocoAppUrl: string }): SiteRenderUrls {
  const gatewayUrl = new URL(input.gatewayUrl).origin;
  return {
    apiUrl: new URL(input.apiUrl).origin,
    gatewayUrl,
    wocoAppUrl: new URL(input.wocoAppUrl).origin,
    ...(siteStoreForGateway(gatewayUrl) === "etherna" ? { contentGatewayUrl: WOCO_GATEWAY_URL } : {}),
  };
}

/** The `window.SITE_CONFIG` object a deploy injects. Key order is part of the bytes. */
export function siteDeployConfig(site: Site, urls: SiteRenderUrls): Record<string, unknown> {
  const config: Record<string, unknown> = { site, gatewayUrl: urls.gatewayUrl, apiUrl: urls.apiUrl, wocoAppUrl: urls.wocoAppUrl };
  if (urls.contentGatewayUrl) config.contentGatewayUrl = urls.contentGatewayUrl;
  return config;
}

/**
 * The release forks a site keeps, checked against the descriptor: every listed
 * edge and file must be in the root exactly as described, plus the root's "/"
 * (index document) record. Anything else in the release root is dropped.
 */
function releaseForks(release: SiteRuntimeRoot, rootNode: Uint8Array): Uint8Array[] {
  if (mantarayNodeAddress(rootNode) !== release.root) throw new Error("site runtime: root node does not match its address");
  if (release.indexDocument !== SITE_INDEX_DOCUMENT) throw new Error("site runtime: unexpected index document");
  const forks = new Map(parseMantarayNode(rootNode).forks.map((f) => [f.prefix, f]));
  const kept: Uint8Array[] = [];

  const slash = forks.get("/");
  if (
    !slash ||
    slash.type !== (MANTARAY_TYPE_VALUE | MANTARAY_TYPE_METADATA) ||
    slash.metadata?.["website-index-document"] !== SITE_INDEX_DOCUMENT ||
    slash.metadata?.["website-error-document"] !== SITE_INDEX_DOCUMENT ||
    Object.keys(slash.metadata).length !== 2
  ) {
    throw new Error("site runtime: root has no index document record");
  }
  kept.push(slash.record);

  for (const [prefix, address] of Object.entries(release.edges)) {
    const f = forks.get(prefix);
    if (!f || f.ref !== address || f.type !== (MANTARAY_TYPE_EDGE | MANTARAY_TYPE_PATH_SEPARATOR)) {
      throw new Error(`site runtime: edge ${prefix} is not in the root as described`);
    }
    kept.push(f.record);
  }
  for (const [name, file] of Object.entries(release.files)) {
    const f = forks.get(name);
    const type = f?.metadata?.["Content-Type"];
    if (
      !f ||
      f.type !== (MANTARAY_TYPE_VALUE | MANTARAY_TYPE_METADATA) ||
      type !== file.contentType ||
      !isSiteRuntimeFileType(type) ||
      f.metadata?.Filename !== name ||
      Object.keys(f.metadata!).length !== 2
    ) {
      throw new Error(`site runtime: file ${name} is not in the root as described`);
    }
    kept.push(f.record);
  }
  for (const rec of kept) {
    if (rec[2] === SITE_FILES_EDGE.charCodeAt(0)) throw new Error("site runtime: a shared path collides with the site's own files");
  }
  return kept;
}

function storedObject(data: Uint8Array): SiteCollectionObject {
  return { address: bytesTreeChunks(data).at(-1)!.address, data };
}

/**
 * Build a site's collection. `release` and `releaseRootNode` are the store's
 * release root (our bee and Etherna encode the same build differently);
 * `template` is the release's `multi-site.html`. Throws on any mismatch rather
 * than building something the server would refuse.
 */
export function buildSiteCollection(input: {
  site: Site;
  urls: SiteRenderUrls;
  template: string;
  release: SiteRuntimeRoot;
  releaseRootNode: Uint8Array;
}): SiteCollection {
  const kept = releaseForks(input.release, input.releaseRootNode);
  const enc = new TextEncoder();
  const html = enc.encode(
    renderSiteHtml({ template: input.template, config: siteDeployConfig(input.site, input.urls), site: input.site, gatewayUrl: input.urls.gatewayUrl }),
  );
  if (html.length > SITE_HTML_MAX_BYTES) throw new Error("site is too large to publish");
  const manifest = enc.encode(JSON.stringify(sitePwaManifest(input.site)));

  const htmlObj = storedObject(html);
  const manifestObj = storedObject(manifest);
  const htmlLeaf = storedObject(encodeMantarayNode(htmlObj.address, []));
  const manifestLeaf = storedObject(encodeMantarayNode(manifestObj.address, []));
  const valueType = MANTARAY_TYPE_VALUE | MANTARAY_TYPE_METADATA;
  const filesNode = storedObject(
    encodeMantarayNode(null, [
      encodeMantarayFork({ type: valueType, prefix: "anifest.json", ref: manifestLeaf.address, metadata: { "Content-Type": MANIFEST_TYPE, Filename: "manifest.json" } }),
      encodeMantarayFork({ type: valueType, prefix: "ulti-site.html", ref: htmlLeaf.address, metadata: { "Content-Type": HTML_TYPE, Filename: SITE_INDEX_DOCUMENT } }),
    ]),
  );
  const rootNode = encodeMantarayNode(null, [...kept, encodeMantarayFork({ type: MANTARAY_TYPE_EDGE, prefix: SITE_FILES_EDGE, ref: filesNode.address })]);
  if (rootNode.length > 4096) throw new Error("site runtime: root node does not fit one chunk");
  const root = storedObject(rootNode);
  return { root: root.address, rootNode, objects: [htmlObj, manifestObj, htmlLeaf, manifestLeaf, filesNode, root] };
}

/** True when `received` is exactly `expected.objects`: same count, order and bytes. */
export function sameSiteObjects(expected: SiteCollection, received: Uint8Array[]): boolean {
  if (received.length !== expected.objects.length) return false;
  return expected.objects.every((o, i) => {
    const r = received[i]!;
    return r.length === o.data.length && r.every((b, j) => b === o.data[j]);
  });
}
