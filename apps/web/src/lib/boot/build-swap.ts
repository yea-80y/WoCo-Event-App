/**
 * Hand the page over to a newer build, in place, before anything has mounted.
 *
 * In place, not a reload: a reload asks for the entry page again by the same route
 * that just served an old one, and the URL - with any Stripe or Web3Auth return state
 * in it - must reach the new build untouched. Only our own builds are accepted
 * (`<meta name="woco-feed">` for the same feed), and only when they declare the SAME
 * Content-Security-Policy as this page: meta policies only ever add up, so a build
 * with a different policy would run under this one's and is reloaded instead.
 */

import type { FeedPoint } from "@woco/shared";
import { formatBuildFeed, parseBuildFeed, type BuildFeed } from "./build-check";

export interface BuildPage {
  feed: BuildFeed;
  /** Absolute; every relative URL below resolves against it. */
  base: string;
  csp: string | null;
  /** The page's module entry, absolute. */
  entry: string;
  /** stylesheet / modulepreload / preload links, absolute, in document order. */
  links: Array<{ rel: string; href: string; as?: string }>;
}

const TAG = /<(meta|base|link|script)\b([^>]*)>/gi;
const ATTR = /([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;
const ENTITIES: Record<string, string> = { "&#39;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const decode = (s: string) => s.replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, (e) => ENTITIES[e]!);

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]!.toLowerCase()] = decode(m[2]!);
  return out;
}

/**
 * The parts of a deployed entry page a handover needs, or null if it is not one of
 * our builds. A string scan, not a DOM parse: the input is our own generated
 * index.html, and the same code then runs under the unit tests.
 */
export function parseBuildPage(html: string, fetchedFrom: string): BuildPage | null {
  let feed: BuildFeed | null = null;
  let baseHref: string | null = null;
  let csp: string | null = null;
  let entry: string | null = null;
  const links: Array<{ rel: string; href: string; as?: string }> = [];
  for (const m of html.matchAll(TAG)) {
    const tag = m[1]!.toLowerCase();
    const a = attrs(m[2]!);
    if (tag === "meta" && a.name === "woco-feed") feed = parseBuildFeed(a.content);
    else if (tag === "meta" && a["http-equiv"]?.toLowerCase() === "content-security-policy") csp = a.content ?? null;
    else if (tag === "base" && a.href && baseHref === null) baseHref = a.href;
    else if (tag === "script" && a.type === "module" && a.src && entry === null) entry = a.src;
    else if (tag === "link" && a.href && /^(stylesheet|modulepreload|preload)$/.test(a.rel ?? "")) {
      links.push({ rel: a.rel!, href: a.href, ...(a.as ? { as: a.as } : {}) });
    }
  }
  if (!feed || !entry) return null;
  try {
    const base = new URL(baseHref ?? "./", fetchedFrom).href;
    return {
      feed,
      base,
      csp,
      entry: new URL(entry, base).href,
      links: links.map((l) => ({ ...l, href: new URL(l.href, base).href })),
    };
  } catch {
    return null;
  }
}

export type SwapResult = "swapped" | "reload" | "failed";

interface BootWindow {
  __wocoBoot?: { handedOver: true; index: number };
}

async function fetchPage(bases: string[], ref: string): Promise<BuildPage | null> {
  for (const b of bases) {
    const url = `${b.replace(/\/+$/, "")}/bzz/${ref}/`;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5_000);
      const res = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) continue;
      const page = parseBuildPage(await res.text(), url);
      if (page) return page;
    } catch {
      // next base
    }
  }
  return null;
}

/**
 * Moves this document onto the build at `point`. "reload" means the build is ours
 * but declares a different security policy; "failed" leaves the page as it was so
 * the caller can mount the current build.
 */
export async function swapToBuild(point: FeedPoint, current: BuildFeed, pageBases: string[]): Promise<SwapResult> {
  const page = await fetchPage(pageBases, point.ref);
  if (!page || page.feed.owner !== current.owner || page.feed.topic !== current.topic) return "failed";

  const ownCsp = document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute("content") ?? null;
  if (page.csp !== ownCsp) return "reload";

  const head = document.head;
  const oldBase = document.baseURI;
  let baseEl = document.querySelector("base");
  const createdBase = !baseEl;
  const priorBaseHref = baseEl?.getAttribute("href") ?? null;
  const feedMeta = document.querySelector('meta[name="woco-feed"]');
  const priorFeed = feedMeta?.getAttribute("content") ?? null;

  // This build's own asset links go; anything else (fonts) stays.
  const removed = [...head.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet],link[rel=modulepreload],link[rel=preload]")].filter(
    (l) => l.href.startsWith(oldBase),
  );
  const added: HTMLLinkElement[] = [];
  const present = new Set([...head.querySelectorAll<HTMLLinkElement>("link[href]")].map((l) => l.href));

  try {
    for (const l of removed) l.remove();
    if (!baseEl) {
      baseEl = document.createElement("base");
      head.prepend(baseEl);
    }
    baseEl.setAttribute("href", page.base);
    feedMeta?.setAttribute("content", formatBuildFeed({ ...page.feed, index: point.index }));
    for (const l of page.links) {
      if (present.has(l.href)) continue;
      const el = document.createElement("link");
      el.rel = l.rel;
      if (l.as) el.as = l.as;
      // Match how the entry will fetch: module scripts are CORS, stylesheets are not.
      if (l.rel === "modulepreload") el.crossOrigin = "";
      el.href = l.href;
      head.appendChild(el);
      added.push(el);
    }
    (window as BootWindow).__wocoBoot = { handedOver: true, index: point.index };
    await import(/* @vite-ignore */ page.entry);
    console.info(`[boot] handed over to build ${point.index} (this page was ${current.index})`);
    return "swapped";
  } catch (e) {
    console.warn("[boot] handover failed, staying on this build", e);
    delete (window as BootWindow).__wocoBoot;
    for (const el of added) el.remove();
    for (const l of removed) head.appendChild(l);
    if (createdBase) baseEl?.remove();
    else if (priorBaseHref !== null) baseEl?.setAttribute("href", priorBaseHref);
    if (priorFeed !== null) feedMeta?.setAttribute("content", priorFeed);
    document.getElementById("app")?.replaceChildren();
    return "failed";
  }
}
