/**
 * Start one of the app's own module Workers wherever the page is served (#1087).
 *
 * On woco.eth.limo the app's chunks load from the gateway (the deploy's
 * `<base href>`, `ASSET_ORIGIN` in apps/web/vite-plugins/csp.ts), and a browser
 * starts a Worker only from the page's own origin: `new Worker(gatewayUrl)` throws
 * SecurityError there. A Worker made from a same-origin blob that imports the chunk
 * is allowed. That import is checked against worker-src (measured in Chrome,
 * 2026-11-04), which is why the app policy lists the asset origin there.
 *
 * A static import, not `import()`: the browser holds the page's messages until the
 * imported module has run, and a chunk that will not load fires `error` on the
 * Worker, so every caller's on-page fallback works unchanged.
 *
 * Anything on the page's own origin (gateway.woco-net.com, the embed's seat map
 * frame, organiser sites, the dev server) starts directly, as before.
 */

export interface ModuleWorkerEnv {
  Worker: new (url: string | URL, options?: WorkerOptions) => Worker;
  createObjectURL(blob: Blob): string;
  /** What `new Worker(relative)` resolves against: the document's base URL. */
  baseURI(): string;
  origin(): string;
}

/** A starter with its own shim cache. The page's is `startModuleWorker`. */
export function moduleWorkerStarter(env: ModuleWorkerEnv): (scriptUrl: string) => Worker {
  // One shim per chunk, kept for the page's life (a few dozen bytes each). Revoking
  // it straight after `new Worker` races the Worker's own fetch of it in some engines.
  const shims = new Map<string, string>();
  return (scriptUrl) => {
    const url = new URL(scriptUrl, env.baseURI());
    if (url.origin === env.origin() || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return new env.Worker(url, { type: "module" });
    }
    let shim = shims.get(url.href);
    if (shim === undefined) {
      shim = env.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: "text/javascript" }));
      shims.set(url.href, shim);
    }
    return new env.Worker(shim, { type: "module" });
  };
}

let page: ((scriptUrl: string) => Worker) | undefined;

/** Start a module Worker from a built chunk's URL (`import u from "./x.ts?worker&url"`). */
export function startModuleWorker(scriptUrl: string): Worker {
  page ??= moduleWorkerStarter({
    Worker,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    baseURI: () => document.baseURI,
    origin: () => location.origin,
  });
  return page(scriptUrl);
}
