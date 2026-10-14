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
 * The device remembers the INDEX of the newest verified update it has seen, so a
 * stale entry page is corrected on the next visit even when the walk was too slow
 * this time. Only the index: storage is writable by anything that runs on this
 * origin (and on a gateway origin, that is every site it serves), so the build to
 * load always comes from an update re-verified now, never from storage.
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

/** The highest index this device has verified for this feed - a hint, never a build. */
export function readHighWater(storage: Storage | null, feed: BuildFeed): number | null {
  try {
    const raw = storage?.getItem(highWaterKey(feed));
    if (!raw || !/^\d{1,15}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/** Records the index of a VERIFIED update; never lowers what is stored. */
export function writeHighWater(storage: Storage | null, feed: BuildFeed, index: number): void {
  try {
    const current = readHighWater(storage, feed);
    if (current !== null && current >= index) return;
    storage?.setItem(highWaterKey(feed), String(index));
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
  let best: FeedPoint | null = null;
  let firstHit!: () => void;
  const hit = new Promise<"hit">((r) => (firstHit = () => r("hit")));

  const walkFrom = (fromIndex: number) =>
    walkFeedForward({
      owner: feed.owner,
      topic: feed.topic,
      fromIndex,
      sources: opts.sources,
      probeTimeoutMs: opts.probeTimeoutMs,
      onAdvance: (p) => {
        // Never sideways or back. Unreachable while every walk starts at or above this
        // build (a mutation test shows it), and kept as the rule itself.
        if (p.index <= feed.index || (best && best.index >= p.index)) return;
        best = p;
        writeHighWater(storage, feed, p.index);
        firstHit();
      },
    }).catch(() => null);

  // From this build, and - when the device has seen newer - from just below that
  // index, so its update is re-verified in the first round. Both, because a hint
  // that cannot be verified (or was planted) must not stop the ordinary walk.
  const hint = readHighWater(storage, feed);
  const walks = [walkFrom(feed.index)];
  if (hint !== null && hint > feed.index) walks.push(walkFrom(hint - 1));
  const walk = Promise.all(walks).then(() => "walked" as const);

  const first = await Promise.race([walk, hit, sleep(opts.graceMs)]);
  if (first === "hit") await Promise.race([walk, sleep(opts.holdAfterHitMs)]);
  return best ? { kind: "newer", point: best } : { kind: "current" };
}
