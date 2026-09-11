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

const objectsExtract = (env: unknown) => (env as Partial<ObjectDirectory> | null)?.objects;
const pagesExtract = (env: unknown) => (env as Partial<ObjectDirectory> | null)?.pages ?? 0;

// ---------------------------------------------------------------------------
// Per-address serialization for read-modify-write of the directory feed.
// ---------------------------------------------------------------------------

const dirLocks = new Map<string, Promise<unknown>>();

function withDirLock<T>(ethAddress: string, fn: () => Promise<T>): Promise<T> {
  const key = ethAddress.toLowerCase();
  const prev = dirLocks.get(key) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(fn);
  dirLocks.set(key, task.catch(() => undefined));
  return task as Promise<T>;
}

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
// Writes (strict read-modify-write under the per-address lock)
// ---------------------------------------------------------------------------

/** Strict read of objects + categories for the write path (throws on transient error). */
async function readStrict(
  ethAddress: string,
): Promise<{ objects: ObjectDirectoryEntry[]; categories: ObjectCategory[] }> {
  const objects = await readPagedFeedStrict<ObjectDirectoryEntry>(
    (p) => objectCreatorDirectoryTopic(ethAddress, p),
    objectsExtract,
    pagesExtract,
  );
  // readPagedFeedStrict already threw on a page-0 read error, so a plain read
  // here is safe for the (small) category list.
  const categories = await getCreatorObjectCategories(ethAddress);
  return { objects, categories };
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
 * Insert/replace an object type, keyed by `manifestRef`. Most-recently-updated
 * first. Fire-and-forget safe: callers (event creation) should not fail the
 * primary action if this throws — log and move on.
 */
export async function upsertCreatorObject(
  ethAddress: string,
  entry: ObjectDirectoryEntry,
): Promise<void> {
  return withDirLock(ethAddress, async () => {
    const { objects, categories } = await readStrict(ethAddress);
    const filtered = objects.filter(
      (e) => e.manifestRef.toLowerCase() !== entry.manifestRef.toLowerCase(),
    );
    const updated = [entry, ...filtered];
    await writeDirectory(ethAddress, updated, categories);
    console.log(
      `[objectEntry] Creator directory updated for ${ethAddress}: ${updated.length} object type(s)`,
    );
  });
}

/** Replace the creator's category list (manager edits). Preserves objects. */
export async function setCreatorObjectCategories(
  ethAddress: string,
  categories: ObjectCategory[],
): Promise<void> {
  return withDirLock(ethAddress, async () => {
    const { objects } = await readStrict(ethAddress);
    await writeDirectory(ethAddress, objects, categories);
  });
}
