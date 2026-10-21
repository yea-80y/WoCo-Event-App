// ---------------------------------------------------------------------------
// Creator object directory — every object *type* (manifest) a creator has issued.
//
// Backs the `#/creator/objects` manager and the `<ObjectPicker>`. Mirrors the shop /
// site creator directories: a paged on-feed envelope at
// `woco/object/creator/{ethAddress}`, most-recently-updated first, deduped by the
// immutable `manifestRef`. Categories + display metadata live HERE (mutable),
// never in the signed manifest — re-categorising/renaming never re-signs.
//
// Owner is always the verified parentAddress (stamped by the route), same trust
// model as events/sites/shops.
// ---------------------------------------------------------------------------

import { Topic } from "@ethersphere/bee-js";
import { objectCreatorDirectoryTopic } from "@woco/shared";
import type { ObjectDirectory, ObjectDirectoryEntry, ObjectCategory, Hex0x } from "@woco/shared";
import { readFeedPage, decodeJsonFeed } from "../swarm/feeds.js";
import {
  writePagedFeed,
  readPagedFeedStrict,
  readPagedFeedLenient,
} from "../swarm/paged-feed.js";
import { createFirstWriteRetryQueue, type QueuedChange } from "../swarm/first-write-retry.js";

const objectsExtract = (env: unknown) => (env as Partial<ObjectDirectory> | null)?.objects;
const pagesExtract = (env: unknown) => (env as Partial<ObjectDirectory> | null)?.pages ?? 0;

// ---------------------------------------------------------------------------
// Reads (GET paths — lenient)
// ---------------------------------------------------------------------------

/** All object types a creator has issued (lenient — transient errors → []). */
export async function getCreatorObjects(ethAddress: string): Promise<ObjectDirectoryEntry[]> {
  return readPagedFeedLenient<ObjectDirectoryEntry>(
    (p) => objectCreatorDirectoryTopic(ethAddress, p),
    objectsExtract,
    pagesExtract,
  );
}

/** A creator's object categories (page 0 only). */
export async function getCreatorObjectCategories(ethAddress: string): Promise<ObjectCategory[]> {
  const page0 = await readFeedPage(Topic.fromString(objectCreatorDirectoryTopic(ethAddress, 0)));
  if (!page0) return [];
  return decodeJsonFeed<ObjectDirectory>(page0)?.categories ?? [];
}

/** Full directory (objects + categories) for the manager. */
export async function getCreatorObjectDirectory(ethAddress: string): Promise<ObjectDirectory> {
  const [objects, categories] = await Promise.all([
    getCreatorObjects(ethAddress),
    getCreatorObjectCategories(ethAddress),
  ]);
  return {
    v: 1,
    owner: ethAddress.toLowerCase() as Hex0x,
    objects,
    categories,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Writes: strict read-modify-write through the creator's first-write-retry queue
// ---------------------------------------------------------------------------

interface DirectoryState {
  objects: ObjectDirectoryEntry[];
  categories: ObjectCategory[];
}

/**
 * Strict read of objects + categories for the write path (throws on transient
 * error). Categories come from the same strict page-0 envelope: a second, lenient
 * read here was one more index-0 miss on a never-written directory - three in
 * about a second with the write's own probe, enough for bee's skip list (#942) -
 * and a lenient failure read as "no categories" and wrote that.
 */
async function readStrict(ethAddress: string): Promise<DirectoryState> {
  const { items, head } = await readPagedFeedStrict<ObjectDirectoryEntry>(
    (p) => objectCreatorDirectoryTopic(ethAddress, p),
    objectsExtract,
    pagesExtract,
  );
  return { objects: items, categories: (head as Partial<ObjectDirectory> | null)?.categories ?? [] };
}

async function writeDirectory(
  ethAddress: string,
  objects: ObjectDirectoryEntry[],
  categories: ObjectCategory[],
): Promise<void> {
  const owner = ethAddress.toLowerCase() as Hex0x;
  await writePagedFeed<ObjectDirectoryEntry>(
    objects,
    (p) => objectCreatorDirectoryTopic(ethAddress, p),
    ({ items, pages, updatedAt }): ObjectDirectory => ({
      v: 1,
      owner,
      objects: items,
      // Replicated on every page (tiny); readers only consult page 0.
      categories,
      updatedAt,
      pages,
    }),
  );
}

/**
 * The two kinds of change a creator's directory takes, through one queue so they
 * share its order: an object type upserted (keyed by `manifestRef`, replaced
 * whole and moved to the front), or the category list replaced. Merged while
 * queued by "the later wins" per id - sound here, as an upsert's position is
 * decided by its last upsert alone and categories never touch the objects.
 */
type ObjectDirectoryChange =
  | { kind: "upsert"; entry: ObjectDirectoryEntry }
  | { kind: "categories"; categories: ObjectCategory[] };

function applyObjectDirectoryChange(state: DirectoryState, change: ObjectDirectoryChange): DirectoryState {
  if (change.kind === "categories") return { ...state, categories: change.categories };
  const ref = change.entry.manifestRef.toLowerCase();
  return { ...state, objects: [change.entry, ...state.objects.filter((e) => e.manifestRef.toLowerCase() !== ref)] };
}

const objectDirectoryQueue = createFirstWriteRetryQueue<DirectoryState, ObjectDirectoryChange>({
  label: "[objectEntry] Creator directory",
  healthKey: "objectDirectory",
  read: readStrict,
  write: async (creator, base, changes) => {
    const { objects, categories } = changes.reduce(applyObjectDirectoryChange, base);
    await writeDirectory(creator, objects, categories);
    console.log(`[objectEntry] Creator directory updated for ${creator}: ${objects.length} object type(s)`);
  },
  idOf: (change) => (change.kind === "categories" ? "categories" : `entry:${change.entry.manifestRef.toLowerCase()}`),
  merge: (_earlier, later) => later,
  replayPayload: (creator, change) => ({ creator, ...change }),
});

/**
 * Insert/replace an object type, keyed by `manifestRef`. Most-recently-updated
 * first. A directory that cannot be read is never written (that would wipe every
 * other object type): the change is retried past bee's skip list, the usual cause
 * on a creator's first series (#942). A request awaits `firstAttempt` - one
 * attempt, then the retry carries on without it; event creation ignores both.
 */
export function upsertCreatorObject(ethAddress: string, entry: ObjectDirectoryEntry): QueuedChange {
  return objectDirectoryQueue.enqueue(ethAddress.toLowerCase(), { kind: "upsert", entry });
}

/** Replace the creator's category list (manager edits). Preserves objects. Same queue and contract. */
export function setCreatorObjectCategories(ethAddress: string, categories: ObjectCategory[]): QueuedChange {
  return objectDirectoryQueue.enqueue(ethAddress.toLowerCase(), { kind: "categories", categories });
}
