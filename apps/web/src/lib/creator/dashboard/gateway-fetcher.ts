/**
 * The background queue's reads from one gateway (#965): bundles of up to
 * BUNDLE_MAX_ROOTS through POST /bytes-bundle where it has it, one GET /bytes each
 * (`fetchOne`) where it does not. Kept free of browser globals so its fallback
 * rules are tested directly; browser-orders-live.ts wires it to `fetch`.
 *
 * There is no probe - the first bundle is the probe. A 404/405, or a body that is
 * not an answer to what was asked, means "no bundles here" for the rest of this
 * page (nothing remembered across loads, so a gateway that gains the endpoint is
 * used on the next one). A gateway whose bundles keep failing before any has
 * worked is read one at a time too, so it can never stall the page.
 */
import type { BatchResult, DetailQueueDeps, FetchResult, GatewayBudget } from "./detail-queue.js";
import { BUNDLE_MAX_ROOTS, bundleBodyLimit, parseBundle } from "./order-box.js";

/** Bundles that failed outright, with none ever answered on this page, before reading one at a time. */
export const BUNDLE_GIVE_UP = 3;

/** Whole seconds, or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * The draft RateLimit headers (`RateLimit-Limit/-Remaining/-Reset`, reset in
 * seconds). Readable cross-origin only where the gateway lists them in
 * Access-Control-Expose-Headers (ours does since the bundle change).
 */
export function readBudget(headers: Headers): GatewayBudget | undefined {
  const limit = Number(headers.get("ratelimit-limit") ?? NaN);
  const remaining = Number(headers.get("ratelimit-remaining") ?? NaN);
  const reset = Number(headers.get("ratelimit-reset") ?? NaN);
  if (![limit, remaining, reset].every((n) => Number.isFinite(n) && n >= 0) || limit === 0) return undefined;
  return { limit, remaining, resetMs: reset * 1000 };
}

export interface GatewayFetcherDeps {
  gateway: string;
  fetchImpl: typeof fetch;
  /** One order by GET /bytes (browser-orders-live.ts `fetchOrderBox`). */
  fetchOne(root: string): Promise<FetchResult>;
  /**
   * `parseBundle`, possibly off the page (bundle-verifier.ts). Must answer exactly what
   * `parseBundle` would, and never reject. Defaults to `parseBundle` here.
   */
  parse?(roots: readonly string[], body: Uint8Array): Promise<Map<string, FetchResult> | null>;
  now?(): number;
}

export function gatewayOrderFetcher(deps: GatewayFetcherDeps): Pick<DetailQueueDeps, "fetchBatch" | "maxBatch"> {
  const now = deps.now ?? Date.now;
  const parse = deps.parse ?? (async (roots: readonly string[], body: Uint8Array) => parseBundle(roots, body));
  let bundles = true;
  let failures = 0;
  let answered = false;
  const failed = (budget?: GatewayBudget): BatchResult => {
    failures++;
    if (!answered && failures >= BUNDLE_GIVE_UP) bundles = false;
    return budget ? { kind: "unavailable", budget } : { kind: "unavailable" };
  };
  const unsupported = (): BatchResult => {
    bundles = false;
    return { kind: "unsupported" };
  };
  return {
    maxBatch: () => (bundles ? BUNDLE_MAX_ROOTS : 1),
    async fetchBatch(roots) {
      if (!bundles) {
        // A bundle sent before the switch comes back to be read one at a time.
        if (roots.length !== 1) return { kind: "unsupported" };
        const r = await deps.fetchOne(roots[0]);
        if (r.kind === "limited") return { kind: "limited", ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}), budget: r.budget };
        return { kind: "items", items: new Map([[roots[0], r]]), budget: r.budget };
      }
      let resp: Response;
      try {
        // Never stored by the browser: what the list allows changes, and an erased order must not linger on disk.
        resp = await deps.fetchImpl(`${deps.gateway}/bytes-bundle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ v: 1, roots }),
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return failed();
      }
      const budget = readBudget(resp.headers);
      if (resp.status === 429) {
        const wait = retryAfterMs(resp.headers, now()) ?? budget?.resetMs;
        return { kind: "limited", ...(wait !== undefined ? { retryAfterMs: wait } : {}), budget };
      }
      if (resp.status === 404 || resp.status === 405) return unsupported();
      if (!resp.ok) return failed(budget);
      const limit = bundleBodyLimit(roots.length);
      if (Number(resp.headers.get("content-length")) > limit) return unsupported();
      let body: Uint8Array;
      try {
        body = new Uint8Array(await resp.arrayBuffer());
      } catch {
        return failed(budget);
      }
      // The verdict holds the queue's slot until it is in (Fable consult 2026-11-03 Q5): a
      // device slow to hash downloads no faster than it can check.
      const items = body.length <= limit ? await parse(roots, body) : null;
      if (!items) return unsupported();
      answered = true;
      failures = 0;
      return { kind: "items", items, budget };
    },
  };
}
