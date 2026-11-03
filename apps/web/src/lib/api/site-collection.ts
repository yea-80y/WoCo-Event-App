/**
 * Build a site in the browser on the shared runtime release (#1032).
 * Loaded only when an organiser publishes (`await import` in api/sites.ts), so
 * the encoder never weighs on the app's first load.
 *
 * The result is a proposal: the server rebuilds the same collection from its own
 * copy of the release and stores its build only when the two are identical.
 * Every website is published this way; a failure here is the publish's answer.
 */

import type { EventPageConfig, EventPageHead, Site, SiteRuntimeLine, SiteRuntimeRoot, SiteRuntimeStore } from "@woco/shared";
import { buildEventPageCollection, buildSiteCollection, siteRenderUrls, siteStoreForGateway } from "@woco/shared/site/collection";

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

export type ClientSiteBuild =
  | { ok: true; built: ClientSiteCollection }
  | { ok: false; error: string; code?: string };

const OFFLINE = "Could not prepare your website for publishing - check your connection and try again.";

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

/** Each runtime line's kit route: websites under /api/sites, single-event pages under /api/site. */
const KIT_ROUTE: Record<SiteRuntimeLine, string> = { site: "/api/sites/runtime/kit", eventPage: "/api/site/runtime/kit" };

/**
 * The kit for one store, never from the HTTP cache: the route allows a minute's
 * caching, and the one rebuild after RUNTIME_RELEASE_CHANGED must see the new release.
 */
async function readKit(apiUrl: string, store: SiteRuntimeStore, line: SiteRuntimeLine = "site"): Promise<{ ok: true; kit: RuntimeKit } | { ok: false; error: string; code?: string }> {
  let res: Response;
  try {
    res = await fetch(`${new URL(apiUrl).origin}${KIT_ROUTE[line]}/${store}`, { cache: "no-store" });
  } catch {
    return { ok: false, error: OFFLINE };
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: RuntimeKit; error?: string; code?: string } | null;
  if (!res.ok || !json?.ok || !json.data) {
    // The server's own reason (e.g. no release it can build on), not a guess about the network.
    return json?.error ? { ok: false, error: json.error, ...(json.code ? { code: json.code } : {}) } : { ok: false, error: OFFLINE };
  }
  if (json.data.store !== store) return { ok: false, error: OFFLINE };
  return { ok: true, kit: json.data };
}

export async function buildClientSiteCollection(input: {
  site: Site;
  parentAddress: string;
  apiUrl: string;
  gatewayUrl: string;
  wocoAppUrl: string;
}): Promise<ClientSiteBuild> {
  const store = siteStoreForGateway(input.gatewayUrl);
  const read = await readKit(input.apiUrl, store);
  if (!read.ok) return read;
  const kit = read.kit;
  try {
    // The server stamps the owner the same way: `{ ...body.site, ownerAddress }`.
    const site = { ...input.site, ownerAddress: input.parentAddress.toLowerCase() };
    const built = buildSiteCollection({
      site,
      urls: siteRenderUrls(input),
      template: kit.template,
      release: kit.release,
      releaseRootNode: fromBase64(kit.rootNode),
    });
    return { ok: true, built: { site, root: built.root, body: { runtimeVersion: kit.version, objects: built.objects.map((o) => toBase64(o.data)) } } };
  } catch (e) {
    // A kit that does not match its own release, or a site too large to publish.
    console.warn("[site publish] building in the browser failed:", e);
    return { ok: false, error: e instanceof Error && /too large/.test(e.message) ? "This website is too large to publish." : OFFLINE };
  }
}

export interface ClientEventPageCollection {
  root: string;
  /** The root node the page feed's update carries: signed here, never taken from the server. */
  rootNode: Uint8Array;
  body: { runtimeVersion: number; objects: string[] };
}

export type ClientEventPageBuild =
  | { ok: true; built: ClientEventPageCollection }
  | { ok: false; error: string; code?: string };

/**
 * Build a single-event page (#1032 slice 5) on the release's `eventPage` line,
 * on Etherna where event pages live, with the config the server said it bakes
 * (`GET /api/site/:eventId/page-config`), the head this browser chose and the
 * name the deploy sends (the page's canonical, #70).
 */
export async function buildClientEventPageCollection(input: {
  apiUrl: string;
  config: EventPageConfig;
  head: EventPageHead;
  name?: string;
}): Promise<ClientEventPageBuild> {
  const read = await readKit(input.apiUrl, "etherna", "eventPage");
  if (!read.ok) return read;
  const kit = read.kit;
  try {
    const built = buildEventPageCollection({
      config: input.config,
      head: input.head,
      name: input.name,
      template: kit.template,
      release: kit.release,
      releaseRootNode: fromBase64(kit.rootNode),
    });
    return {
      ok: true,
      built: { root: built.root, rootNode: built.rootNode, body: { runtimeVersion: kit.version, objects: built.objects.map((o) => toBase64(o.data)) } },
    };
  } catch (e) {
    console.warn("[event page publish] building in the browser failed:", e);
    return { ok: false, error: e instanceof Error && /too large/.test(e.message) ? "This event page is too large to publish." : OFFLINE };
  }
}
