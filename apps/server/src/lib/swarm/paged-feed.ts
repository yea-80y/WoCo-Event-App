import { Topic } from "@ethersphere/bee-js";
import {
  readFeedPage,
  readFeedPageStrict,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "./feeds.js";

/**
 * Generic paged JSON-array feed I/O.
 *
 * A directory/index feed whose item list can exceed one 4096-byte feed page:
 * page 0 holds the head + a `pages` overflow count, pages 1..N hold the rest.
 * Extracted from the shop/site directory pattern so the POD directory (and
 * future directories) don't add a fourth copy. Shop/site still carry their own
 * inline copies — they can adopt this later; this module is additive and
 * doesn't touch them.
 *
 * IMPORTANT: the WRITE path uses a STRICT read (throws on transient error)
 * because a swallowed `[]` would overwrite the feed with a partial view. GET
 * paths use the lenient read.
 */

const PAGE_LIMIT = 4096;

export interface PagedEnvelope<T> {
  items: T[];
  /** Overflow page count beyond page 0 (page 0 only). */
  pages: number;
  updatedAt: string;
}

/** Split `items` into <4096-byte pages and write page 0 (+ overflow). */
export async function writePagedFeed<T>(
  items: T[],
  topicFn: (p: number) => string,
  makeEnvelope: (e: PagedEnvelope<T>) => unknown,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const pages: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    current.push(item);
    const probe = makeEnvelope({ items: current, pages: 0, updatedAt });
    if (JSON.stringify(probe).length > PAGE_LIMIT) {
      current.pop();
      if (current.length > 0) pages.push(current);
      current = [item];
    }
  }
  if (current.length > 0) pages.push(current);
  if (pages.length === 0) pages.push([]); // always (re)write page 0, even when emptied

  await writeFeedPage(
    Topic.fromString(topicFn(0)),
    encodeJsonFeed(makeEnvelope({ items: pages[0], pages: pages.length - 1, updatedAt })),
  );
  for (let p = 1; p < pages.length; p++) {
    await writeFeedPage(
      Topic.fromString(topicFn(p)),
      encodeJsonFeed(makeEnvelope({ items: pages[p], pages: 0, updatedAt })),
    );
  }
}

/**
 * Strict read for the WRITE path — returns full prior contents or throws on any
 * transient read error. Bootstrap (page 0 absent) returns [].
 */
export async function readPagedFeedStrict<T>(
  topicFn: (p: number) => string,
  extract: (env: unknown) => T[] | undefined,
  pagesOf: (env: unknown) => number,
): Promise<T[]> {
  const page0 = await readFeedPageStrict(Topic.fromString(topicFn(0)));
  if (page0.status === "error") {
    throw new Error(`Feed read failed (page 0) — refusing to write: ${page0.error.message}`);
  }
  if (page0.status === "absent") return [];
  const env0 = decodeJsonFeed<unknown>(page0.data);
  if (!env0) throw new Error("Feed page 0 decoded to null — refusing to write");

  const all = [...(extract(env0) ?? [])];
  const totalPages = pagesOf(env0);
  for (let p = 1; p <= totalPages; p++) {
    const pg = await readFeedPageStrict(Topic.fromString(topicFn(p)));
    if (pg.status === "error") {
      throw new Error(`Feed read failed (overflow page ${p}) — refusing to write: ${pg.error.message}`);
    }
    if (pg.status === "absent") break;
    const env = decodeJsonFeed<unknown>(pg.data);
    if (!env) continue;
    const items = extract(env);
    if (items) all.push(...items);
  }
  return all;
}

/** Lenient read for GET paths — swallows transient errors into []. */
export async function readPagedFeedLenient<T>(
  topicFn: (p: number) => string,
  extract: (env: unknown) => T[] | undefined,
  pagesOf: (env: unknown) => number,
): Promise<T[]> {
  const page0 = await readFeedPage(Topic.fromString(topicFn(0)));
  if (!page0) return [];
  const env0 = decodeJsonFeed<unknown>(page0);
  if (!env0) return [];
  const all = [...(extract(env0) ?? [])];
  const totalPages = pagesOf(env0);
  for (let p = 1; p <= totalPages; p++) {
    const pg = await readFeedPage(Topic.fromString(topicFn(p)));
    if (!pg) break;
    const env = decodeJsonFeed<unknown>(pg);
    if (!env) break;
    const items = extract(env);
    if (items) all.push(...items);
  }
  return all;
}
