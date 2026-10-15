// A browser that cached a failed load keeps failing after the file is back. During a
// postage outage the gateway answered 404 and Cloudflare told browsers to keep that
// for 4 h, so the dashboard stayed broken on a phone long after the batch was renewed
// (#859; 65 files on 2026-10-15). The gateway now marks errors no-store; this repairs
// entries cached before that, and any that slip through. When a lazy module fails,
// re-fetch this build's failed files past the cache, then reload once if any came back
// and nothing typed on the page could be lost - otherwise the app's own "refresh"
// message now works.

export const SELF_HEAL_KEY = "woco:boot:self-heal";
export const HEAL_WINDOW_MS = 5 * 60_000;
export const MAX_HEAL_RELOADS = 2;
// Sibling imports of one route fail together; wait for them to land before reading.
export const SETTLE_MS = 300;

/** The URL a failed lazy load names: Chrome, Firefox and Vite's CSS preload say it,
 *  Safari ("Importing a module script failed.") does not. */
export function failedUrl(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /(?:dynamically imported module|preload CSS for):?\s+(\S+)/i.exec(msg);
  return m ? m[1] : null;
}

/** The files to repair: the one named plus every resource this page saw fail, limited
 *  to this build's own .js/.css - never an API call, never another origin's file. */
export function healTargets(base: string, named: string | null, failedResources: readonly string[]): string[] {
  let dir: string;
  try {
    dir = new URL(".", base).href;
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const raw of named ? [named, ...failedResources] : failedResources) {
    try {
      const u = new URL(raw, base);
      if (u.href.startsWith(dir) && /\.(?:js|css)$/.test(u.pathname)) out.add(u.href);
    } catch {
      // not a URL
    }
  }
  return [...out];
}

/** Spend one reload from this tab's budget. No storage means no reload: without a
 *  record, a file that is really gone would reload forever. */
export function takeReload(storage: Storage | null, now: number): boolean {
  if (!storage) return false;
  try {
    let since = now;
    let reloads = 0;
    const prior = JSON.parse(storage.getItem(SELF_HEAL_KEY) ?? "null") as { since?: unknown; reloads?: unknown } | null;
    if (prior && typeof prior.since === "number" && typeof prior.reloads === "number" && now - prior.since < HEAL_WINDOW_MS && now >= prior.since) {
      since = prior.since;
      reloads = prior.reloads;
    }
    if (reloads >= MAX_HEAL_RELOADS) return false;
    storage.setItem(SELF_HEAL_KEY, JSON.stringify({ since, reloads: reloads + 1 }));
    return true;
  } catch {
    return false;
  }
}

export interface HealEnv {
  base(): string;
  failedResources(): string[];
  /** Fetch past the HTTP cache, replacing its entry; true when the file came back. */
  refetch(url: string): Promise<boolean>;
  storage(): Storage | null;
  /** A reload could lose something: the user typed, or a sign-in/payment return is in flight. */
  holdReload(): boolean;
  reload(): void;
  now(): number;
}

export type HealOutcome = "not-ours" | "still-missing" | "repaired" | "limit" | "reloaded";

export async function heal(err: unknown, env: HealEnv): Promise<HealOutcome> {
  const targets = healTargets(env.base(), failedUrl(err), env.failedResources());
  if (targets.length === 0) return "not-ours";
  const back = await Promise.all(targets.map((u) => env.refetch(u).catch(() => false)));
  if (!back.some(Boolean)) return "still-missing";
  if (env.holdReload()) return "repaired";
  if (!takeReload(env.storage(), env.now())) return "limit";
  env.reload();
  return "reloaded";
}

type HealWindow = Window & typeof globalThis & { __wocoSelfHeal?: true };

/** Once per page: a newer build handed over to runs this again, and must not double up. */
export function installSelfHeal(): void {
  const w = window as HealWindow;
  if (w.__wocoSelfHeal) return;
  w.__wocoSelfHeal = true;

  let typed = false;
  w.addEventListener("input", () => (typed = true), { capture: true });
  // This runs before the app, so the URL is still as navigated. A Web3Auth or Stripe
  // result is stripped from it at capture and held in memory until consumed; a reload
  // in between would drop the sign-in. Repair only - the app's refresh prompt then works.
  const returned = /[#?&](?:b64Params|sessionId|stripe|session_id)=/.test(w.location.href);

  // An observer, not getEntriesByType: the resource buffer stops at 250 entries (API
  // calls count), and a dashboard opened late in a session is exactly when it is full.
  const failed = new Set<string>();
  try {
    new w.PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if ((e.responseStatus ?? 0) >= 400) failed.add(e.name);
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    // no observer: the error's own URL is all there is
  }

  const env: HealEnv = {
    base: () => w.document.baseURI,
    failedResources: () => [...failed],
    refetch: async (url) => (await w.fetch(url, { cache: "reload" })).ok,
    storage: () => {
      try {
        return w.sessionStorage;
      } catch {
        return null;
      }
    },
    holdReload: () => typed || returned,
    reload: () => w.location.reload(),
    now: () => Date.now(),
  };

  let pending = false;
  w.addEventListener("vite:preloadError", (event) => {
    if (pending) return;
    pending = true;
    const err = (event as Event & { payload?: unknown }).payload;
    // Now, not after the settle: a failed handover restores the old build's <base>
    // meanwhile, and the file to repair belongs to the new one.
    const base = w.document.baseURI;
    w.setTimeout(() => {
      void heal(err, { ...env, base: () => base })
        .then((outcome) => console.warn(`[boot] a module failed to load; self-heal: ${outcome}`))
        .catch(() => {})
        .finally(() => (pending = false));
    }, SETTLE_MS);
  });
}
