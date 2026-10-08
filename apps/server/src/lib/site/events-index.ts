/**
 * The site events index (`woco/site/{siteId}/events`): one platform-signed feed
 * per site, written ONLY by this server (publish, event add, event remove) and
 * read on the payment path for each event's creatorFeedSigner. So this process
 * knows the latest version better than any read can for a while after a write.
 *
 * Why that matters (#186 follow-up, owner report 2026-10-08): the index is
 * written through the site's batch dest (Etherna for most sites) but read from
 * our bee, which sees a new update seconds late. A read in that window returns
 * the PREVIOUS index, so:
 *  - an add/remove built on it overwrote the edit just made (lost update), and
 *    the read also rewound the feed's cached next write index, so the write
 *    could land on a slot already taken;
 *  - the events-full memo cached the old list for its full TTL;
 *  - a checkout right after an add could not find the new event's signer.
 * And the add/remove read was the lenient one: any fault read as "no index" and
 * the route wrote an EMPTY index, wiping every other event on the site.
 *
 * So: every writer records what it wrote here; for FRESH_MS afterwards readers
 * use that instead of asking bee, and edits are serialised per site.
 */
import { Topic } from "@ethersphere/bee-js";
import { SITE_SCHEMA_VERSION, siteEventsIndexTopic, type SiteEventsIndex } from "@woco/shared";
import { decodeJsonFeed, readFeedPageStrict } from "../swarm/feeds.js";

/** Comfortably longer than bee's lag behind an Etherna write (seconds, measured). */
const FRESH_MS = 120_000;

const written = new Map<string, { index: SiteEventsIndex; at: number }>();
const locks = new Map<string, Promise<unknown>>();

/** Call after a successful write of the index. */
export function rememberWrittenEventsIndex(siteId: string, index: SiteEventsIndex): void {
  written.set(siteId, { index: structuredClone(index), at: Date.now() });
}

/** What this server wrote within FRESH_MS, or null. A copy: callers may mutate it. */
export function freshWrittenEventsIndex(siteId: string): SiteEventsIndex | null {
  const w = written.get(siteId);
  if (!w) return null;
  if (Date.now() - w.at >= FRESH_MS) {
    written.delete(siteId);
    return null;
  }
  return structuredClone(w.index);
}

export type EventsIndexRead =
  | { status: "ok"; index: SiteEventsIndex }
  | { status: "unavailable"; reason: string };

/**
 * The base an edit builds on. Never "empty because a read failed": a fault or a
 * page that will not decode is unavailable, and the caller refuses (503). Only a
 * feed bee reports as never written is a fresh empty index.
 */
export async function readEventsIndexForWrite(siteId: string): Promise<EventsIndexRead> {
  const mine = freshWrittenEventsIndex(siteId);
  if (mine) return { status: "ok", index: mine };
  const page = await readFeedPageStrict(Topic.fromString(siteEventsIndexTopic(siteId)));
  if (page.status === "error") return { status: "unavailable", reason: page.error.message };
  if (page.status === "absent") {
    return { status: "ok", index: { siteId, schemaVersion: SITE_SCHEMA_VERSION, events: [], updatedAt: 0 } };
  }
  const index = decodeJsonFeed<SiteEventsIndex>(page.data);
  if (!index || !Array.isArray(index.events)) return { status: "unavailable", reason: "events index did not decode" };
  return { status: "ok", index };
}

/** Run one read-modify-write of a site's index at a time, so two quick toggles both land. */
export function withEventsIndexLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(siteId) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(fn);
  const tail = task.catch(() => undefined);
  locks.set(siteId, tail);
  void tail.then(() => {
    if (locks.get(siteId) === tail) locks.delete(siteId);
  });
  return task;
}
