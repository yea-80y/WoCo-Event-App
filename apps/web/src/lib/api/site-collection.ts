/**
 * Build a site in the browser on the shared runtime release (#1032 slice 3).
 * Loaded only when an organiser publishes (`await import` in api/sites.ts), so
 * the encoder never weighs on the app's first load.
 *
 * The result is a proposal: the server rebuilds the same collection from its own
 * copy of the release and stores ours only when the two are identical. A null
 * here just means "deploy the old way".
 */

import type { Site, SiteRuntimeRoot, SiteRuntimeStore } from "@woco/shared";
import { buildSiteCollection, siteRenderUrls, siteStoreForGateway } from "@woco/shared/site/collection";
import { get } from "./http.js";

interface RuntimeKit {
  version: number;
  store: SiteRuntimeStore;
  release: SiteRuntimeRoot;
  rootNode: string;
  template: string;
}

export interface ClientSiteCollection {
  /** The site object exactly as rendered: send this one as the deploy's `site`. */
  site: Site;
  root: string;
  body: { runtimeVersion: number; objects: string[] };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function buildClientSiteCollection(input: {
  site: Site;
  parentAddress: string;
  apiUrl: string;
  gatewayUrl: string;
  wocoAppUrl: string;
}): Promise<ClientSiteCollection | null> {
  try {
    const store = siteStoreForGateway(input.gatewayUrl);
    const res = await get<RuntimeKit>(`/api/sites/runtime/kit/${store}`, new URL(input.apiUrl).origin);
    if (!res.ok || !res.data || res.data.store !== store) return null;
    const kit = res.data;
    // The server stamps the owner the same way: `{ ...body.site, ownerAddress }`.
    const site = { ...input.site, ownerAddress: input.parentAddress.toLowerCase() };
    const built = buildSiteCollection({
      site,
      urls: siteRenderUrls(input),
      template: kit.template,
      release: kit.release,
      releaseRootNode: fromBase64(kit.rootNode),
    });
    return { site, root: built.root, body: { runtimeVersion: kit.version, objects: built.objects.map((o) => toBase64(o.data)) } };
  } catch (e) {
    console.warn("[site publish] building in the browser failed, the server will build:", e);
    return null;
  }
}
