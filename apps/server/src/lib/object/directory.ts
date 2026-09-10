// ---------------------------------------------------------------------------
// Creator POD directory — every POD *type* (manifest) a creator has issued.
//
// Backs the `#/creator/pods` manager and the `<PodPicker>`. Mirrors the shop /
// site creator directories: a paged on-feed envelope at
// `woco/pod/creator/{ethAddress}`, most-recently-updated first, deduped by the
// immutable `manifestRef`. Categories + display metadata live HERE (mutable),
// never in the signed manifest — re-categorising/renaming never re-signs.
//
// Owner is always the verified parentAddress (stamped by the route), same trust
// model as events/sites/shops.
// ---------------------------------------------------------------------------

import { Topic } from "@ethersphere/bee-js";
import { podCreatorDirectoryTopic } from "@woco/shared";
import type { PodDirectory, PodDirectoryEntry, PodCategory, Hex0x } from "@woco/shared";
import { readFeedPage, decodeJsonFeed } from "../swarm/feeds.js";
import {
  writePagedFeed,
  readPagedFeedStrict,
  readPagedFeedLenient,
} from "../swarm/paged-feed.js";

const podsExtract = (env: unknown) => (env as Partial<PodDirectory> | null)?.pods;
const pagesExtract = (env: unknown) => (env as Partial<PodDirectory> | null)?.pages ?? 0;

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

/** All POD types a creator has issued (lenient — transient errors → []). */
export async function getCreatorPods(ethAddress: string): Promise<PodDirectoryEntry[]> {
  return readPagedFeedLenient<PodDirectoryEntry>(
    (p) => podCreatorDirectoryTopic(ethAddress, p),
    podsExtract,
    pagesExtract,
  );
}

/** A creator's POD categories (page 0 only). */
export async function getCreatorPodCategories(ethAddress: string): Promise<PodCategory[]> {
  const page0 = await readFeedPage(Topic.fromString(podCreatorDirectoryTopic(ethAddress, 0)));
  if (!page0) return [];
  return decodeJsonFeed<PodDirectory>(page0)?.categories ?? [];
}

/** Full directory (pods + categories) for the manager. */
export async function getCreatorPodDirectory(ethAddress: string): Promise<PodDirectory> {
  const [pods, categories] = await Promise.all([
    getCreatorPods(ethAddress),
    getCreatorPodCategories(ethAddress),
  ]);
  return {
    v: 1,
    owner: ethAddress.toLowerCase() as Hex0x,
    pods,
    categories,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Writes (strict read-modify-write under the per-address lock)
// ---------------------------------------------------------------------------

/** Strict read of pods + categories for the write path (throws on transient error). */
async function readStrict(
  ethAddress: string,
): Promise<{ pods: PodDirectoryEntry[]; categories: PodCategory[] }> {
  const pods = await readPagedFeedStrict<PodDirectoryEntry>(
    (p) => podCreatorDirectoryTopic(ethAddress, p),
    podsExtract,
    pagesExtract,
  );
  // readPagedFeedStrict already threw on a page-0 read error, so a plain read
  // here is safe for the (small) category list.
  const categories = await getCreatorPodCategories(ethAddress);
  return { pods, categories };
}

async function writeDirectory(
  ethAddress: string,
  pods: PodDirectoryEntry[],
  categories: PodCategory[],
): Promise<void> {
  const owner = ethAddress.toLowerCase() as Hex0x;
  await writePagedFeed<PodDirectoryEntry>(
    pods,
    (p) => podCreatorDirectoryTopic(ethAddress, p),
    ({ items, pages, updatedAt }): PodDirectory => ({
      v: 1,
      owner,
      pods: items,
      // Replicated on every page (tiny); readers only consult page 0.
      categories,
      updatedAt,
      pages,
    }),
  );
}

/**
 * Insert/replace a POD type, keyed by `manifestRef`. Most-recently-updated
 * first. Fire-and-forget safe: callers (event creation) should not fail the
 * primary action if this throws — log and move on.
 */
export async function upsertCreatorPod(
  ethAddress: string,
  entry: PodDirectoryEntry,
): Promise<void> {
  return withDirLock(ethAddress, async () => {
    const { pods, categories } = await readStrict(ethAddress);
    const filtered = pods.filter(
      (e) => e.manifestRef.toLowerCase() !== entry.manifestRef.toLowerCase(),
    );
    const updated = [entry, ...filtered];
    await writeDirectory(ethAddress, updated, categories);
    console.log(
      `[pod] Creator directory updated for ${ethAddress}: ${updated.length} POD type(s)`,
    );
  });
}

/** Replace the creator's category list (manager edits). Preserves pods. */
export async function setCreatorPodCategories(
  ethAddress: string,
  categories: PodCategory[],
): Promise<void> {
  return withDirLock(ethAddress, async () => {
    const { pods } = await readStrict(ethAddress);
    await writeDirectory(ethAddress, pods, categories);
  });
}
