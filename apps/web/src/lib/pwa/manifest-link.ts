/**
 * The web app manifest link, added at boot so the app can be installed to a home
 * screen. Imported FIRST by main.ts and imports nothing, so the link is in the
 * document even if later boot code throws.
 *
 * NOT a static `<link rel="manifest" href="./manifest.json">` in index.html: the
 * deploy injects `<base href="https://gateway.woco-net.com/bzz/{assetsRef}/">`
 * (scripts/upload-to-swarm-feed.cjs), so a relative href resolves to THAT deploy's
 * immutable collection. On the gateway it would be same-origin, its `start_url`
 * would be `/bzz/{assetsRef}/`, and every installed icon would open that one build
 * forever. On woco.eth.limo it would be cross-origin and refused by the meta CSP.
 *
 * So the href is built from the page's own URL, never the base: the app root on
 * the host that served it - `/bzz/{feedManifest}/` on a gateway, `/` on eth.limo.
 * The manifest's relative `start_url`, `scope` and icons then resolve to the
 * STABLE feed address, which every deploy updates. There is deliberately no
 * service worker: nothing caches the app shell, so an installed app loads the
 * current deploy exactly as a browser tab does.
 */

export const MANIFEST_FILE = "manifest.json";

/**
 * The app root for a page URL: `{origin}/bzz/{ref}/` when served through a gateway
 * path, else `{origin}/`. The manifest scope is that root WITH its slash, so a page
 * at `/bzz/{ref}` (no slash) is out of scope and Chrome will not install it - bee
 * 301s that path to the slashed one today; keep that redirect at the proxy.
 */
export function appRoot(pageUrl: string): string {
  const url = new URL(pageUrl);
  const bzz = /^\/bzz\/[^/]+(?:\/|$)/.exec(url.pathname);
  const path = bzz ? bzz[0].replace(/\/?$/, "/") : "/";
  return `${url.origin}${path}`;
}

/** Absolute manifest URL for a page URL. Never resolved against `<base href>`. */
export function manifestHref(pageUrl: string): string {
  return new URL(MANIFEST_FILE, appRoot(pageUrl)).href;
}

if (typeof document !== "undefined" && !document.querySelector('link[rel="manifest"]')) {
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = manifestHref(window.location.href);
  document.head.appendChild(link);
}
