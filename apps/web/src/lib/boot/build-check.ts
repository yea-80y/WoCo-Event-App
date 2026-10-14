/**
 * Is this page the newest app build? Asked once, before anything mounts.
 *
 * The entry page reaches the browser through whichever Bee resolved the app feed
 * (eth.limo's, someone's own node, or ours), and Bee's feed lookup can land on an
 * older update (`@woco/shared` feed-walk.ts; 2026-10-14 a phone got build 224 while
 * 241 was current). Every deployed build carries its own feed index in
 * `<meta name="woco-feed">` (baked by scripts/upload-to-swarm-feed.cjs), so the page
 * walks forward from there instead of trusting the lookup that served it.
 *
 * The device remembers the newest verified update it has seen, so a stale entry
 * page is corrected on the next visit even when the walk was too slow this time.
 */

import { httpChunkSource, walkFeedForward, WOCO_GATEWAY_URL, type ChunkSource, type FeedPoint } from "@woco/shared";

export interface BuildFeed {
  owner: string;
  topic: string;
  index: number;
}

const FEED_META = /^v1 ([0-9a-f]{40}) ([0-9a-f]{64}) (\d{1,15})$/;

export function parseBuildFeed(content: string | null | undefined): BuildFeed | null {
  const m = FEED_META.exec((content ?? "").trim());
  return m ? { owner: m[1]!, topic: m[2]!, index: Number(m[3]) } : null;
}

export function formatBuildFeed(feed: BuildFeed): string {
  return `v1 ${feed.owner} ${feed.topic} ${feed.index}`;
}

const highWaterKey = (feed: BuildFeed) => `woco:feed-hw:${feed.owner}:${feed.topic}`;

/** The newest update this device has verified for this feed, if any. */
export function readHighWater(storage: Storage | null, feed: BuildFeed): FeedPoint | null {
  try {
    const raw = storage?.getItem(highWaterKey(feed));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<FeedPoint>;
    if (!Number.isSafeInteger(p.index) || typeof p.ref !== "string" || !/^[0-9a-f]{64}$/.test(p.ref)) return null;
    return { index: p.index!, ref: p.ref, timestamp: Number(p.timestamp) || 0 };
  } catch {
    return null;
  }
}

/** Records a VERIFIED update; never lowers what is stored. */
export function writeHighWater(storage: Storage | null, feed: BuildFeed, point: FeedPoint): void {
  try {
    const current = readHighWater(storage, feed);
    if (current && current.index >= point.index) return;
    storage?.setItem(highWaterKey(feed), JSON.stringify(point));
  } catch {
    // Private mode or full storage: the walk still ran, only the memory is lost.
  }
}

export interface PageSources {
  /** Where `/chunks` reads go, in parallel. */
  sources: ChunkSource[];
  /** Where to fetch a newer build's entry page from, in order. */
  pageBases: string[];
  /** Served by a Bee node that is not ours: its misses are network searches, slower. */
  ownNode: boolean;
}

/**
 * A page under `/bzz/` was served by a Bee-shaped API (our gateway or someone's own
 * node), which can answer `/chunks` too. eth.limo serves the page at `/`, so there
 * only our gateway is asked.
 */
export function pageSources(location: Pick<Location, "origin" | "pathname">, gateway = WOCO_GATEWAY_URL): PageSources {
  const bases: string[] = [];
  if (location.pathname.startsWith("/bzz/") && location.origin !== "null") bases.push(location.origin);
  if (!bases.includes(gateway)) bases.push(gateway);
  return {
    sources: bases.map((b) => httpChunkSource(b)),
    pageBases: bases,
    ownNode: bases[0] !== gateway,
  };
}

export interface CheckOptions {
  feed: BuildFeed;
  sources: ChunkSource[];
  storage: Storage | null;
  /** How long to hold the mount for a first sign of a newer build. */
  graceMs: number;
  /** Once a newer build is seen, how much longer to wait for the walk to finish. */
  holdAfterHitMs: number;
  probeTimeoutMs: number;
}

export type BuildDecision = { kind: "current" } | { kind: "newer"; point: FeedPoint };

const sleep = (ms: number) => new Promise<"timer">((r) => setTimeout(() => r("timer"), ms));

/**
 * Resolves as soon as the answer is known or the wait stops being worth it. The walk
 * keeps running after that and only updates the device's memory, for next time.
 */
export async function checkBuild(opts: CheckOptions): Promise<BuildDecision> {
  const { feed, storage } = opts;
  const remembered = readHighWater(storage, feed);
  let best: FeedPoint | null = remembered && remembered.index > feed.index ? remembered : null;

  let firstHit!: () => void;
  const hit = new Promise<"hit">((r) => (firstHit = () => r("hit")));
  if (best) firstHit();

  const walk = walkFeedForward({
    owner: feed.owner,
    topic: feed.topic,
    fromIndex: best?.index ?? feed.index,
    sources: opts.sources,
    probeTimeoutMs: opts.probeTimeoutMs,
    onAdvance: (p) => {
      best = p;
      writeHighWater(storage, feed, p);
      firstHit();
    },
  })
    .catch(() => null)
    .then(() => "walked" as const);

  const first = await Promise.race([walk, hit, sleep(opts.graceMs)]);
  if (first === "hit") await Promise.race([walk, sleep(opts.holdAfterHitMs)]);
  return best ? { kind: "newer", point: best } : { kind: "current" };
}
