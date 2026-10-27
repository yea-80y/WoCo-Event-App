import type { Topic } from "@ethersphere/bee-js";
import type { Hex64 } from "@woco/shared";
import { readFeedPageStrict, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "./feeds.js";
import { uploadToBytes, downloadFromBytes } from "./bytes.js";
import type { DisplayRead } from "./display-read-memo.js";

/**
 * A creator directory too long for one 4096-byte feed update (#950): the event
 * index, the site directory and the object directory.
 *
 * Page 0 is the feed update. It holds the newest items and, when they do not all
 * fit, `overflow`: the ref of ONE immutable blob holding the rest. A write uploads
 * the blob first and page 0 last, so page 0 is the whole commit: a failed upload
 * leaves the directory untouched, and a failed page 0 leaves the old page 0
 * naming the old blob, which nothing rewrites. Before #950 the overflow pages were
 * feeds of their own, rewritten in place, and a write that failed between them
 * and page 0 left a torn directory every later write had to refuse.
 *
 * The blob is stamped on the platform batch by our bee and read back from our bee
 * only: its items carry `creatorFeedSigner`, a trusted carrier, and our bee checks
 * every chunk against its address where an Etherna answer would go unchecked.
 *
 * A page 0 with `overflow` also says `pages: 1`. That is for a build from before
 * #950 (a rollback): it reads `pages` as a count of overflow FEEDS, finds no such
 * feed, or one stamped by another write, and refuses to write rather than drop
 * every item past page 0.
 *
 * Shop keeps its own copy of the old paged writer (shops are off).
 */

const PAGE_LIMIT = 4096;
const HEX64 = /^[0-9a-f]{64}$/;
/** Sizes page 0 as if it named a blob, before the blob's ref is known. */
const REF_PLACEHOLDER = "0".repeat(64) as Hex64;

export interface PagedDirectory<T> {
  /** The feed topic of page 0, and of legacy overflow page `page` (pre-#950). */
  topic: (page: number) => Topic;
  /** Page 0's JSON for these items, without `pages` or `overflow` (added here). */
  envelope: (e: { items: T[]; updatedAt: string }) => object;
  /** The items on a decoded page 0 or legacy overflow page. */
  items: (env: unknown) => T[] | undefined;
}

export interface DirectoryContents<T> {
  items: T[];
  /** Page 0's decoded envelope, for fields kept beside the items (a directory's
   *  categories); null when the directory has never been written. */
  head: unknown;
}

type Read<T> = { status: "ok"; contents: DirectoryContents<T> } | { status: "error"; error: Error };

/**
 * Write the whole directory: the overflow blob (only when page 0 cannot hold
 * every item), then page 0. Items keep their order: page 0 takes the first ones.
 */
export async function writePagedDirectory<T>(d: PagedDirectory<T>, items: T[]): Promise<void> {
  const updatedAt = new Date().toISOString();
  const page0 = (head: T[], overflow?: Hex64) => ({
    ...d.envelope({ items: head, updatedAt }),
    ...(overflow ? { pages: 1, overflow } : { pages: 0 }),
  });
  const fits = (env: object) => Buffer.byteLength(JSON.stringify(env)) <= PAGE_LIMIT;

  let head = items;
  let overflow: Hex64 | undefined;
  if (!fits(page0(items))) {
    let n = 0;
    while (n < items.length && fits(page0(items.slice(0, n + 1), REF_PLACEHOLDER))) n++;
    head = items.slice(0, n);
    overflow = await uploadToBytes(JSON.stringify({ v: 1, items: items.slice(n) }));
  }
  await writeFeedPage(d.topic(0), encodeJsonFeed(page0(head, overflow)));
}

/**
 * Every item, for a read-modify-write: throws instead of returning anything
 * partial (an item missed here is an item the write deletes). Never written:
 * no items and a null head, safe to write the first one.
 */
export async function readPagedDirectoryForWrite<T>(d: PagedDirectory<T>): Promise<DirectoryContents<T>> {
  const res = await readPagedDirectory(d, true);
  if (res.status === "error") throw new Error(`${res.error.message} — refusing to write`);
  return res.contents;
}

/**
 * Every item, for display: an error whenever any part is unreadable, so a
 * display memo never pins a partial list. Never the base of a write.
 */
export async function readPagedDirectoryForDisplay<T>(d: PagedDirectory<T>): Promise<DisplayRead<DirectoryContents<T>>> {
  try {
    const res = await readPagedDirectory(d, false);
    return res.status === "ok" ? { status: "ok", data: res.contents } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

async function readPagedDirectory<T>(d: PagedDirectory<T>, forWrite: boolean): Promise<Read<T>> {
  const fail = (message: string): Read<T> => ({ status: "error", error: new Error(`Directory ${message}`) });
  const page0 = await readFeedPageStrict(d.topic(0), { forWrite });
  if (page0.status === "error") return fail(`read failed (page 0): ${page0.error.message}`);
  if (page0.status === "absent") return { status: "ok", contents: { items: [], head: null } };
  const head = decodeJsonFeed<{ overflow?: unknown; pages?: unknown; updatedAt?: unknown }>(page0.data);
  const first = head ? d.items(head) : undefined;
  if (!head || !Array.isArray(first)) return fail("page 0 did not decode");

  if (head.overflow !== undefined) {
    if (typeof head.overflow !== "string" || !HEX64.test(head.overflow)) return fail("page 0 names no valid overflow ref");
    const name = head.overflow.slice(0, 16);
    let text: string;
    try {
      text = await downloadFromBytes(head.overflow, { wocoBeeOnly: true });
    } catch (err) {
      return fail(`overflow ${name} unreadable: ${(err as Error)?.message}`);
    }
    const rest = parseJson(text) as { v?: unknown; items?: unknown } | null;
    if (rest?.v !== 1 || !Array.isArray(rest.items)) return fail(`overflow ${name} did not decode`);
    return { status: "ok", contents: { items: [...first, ...(rest.items as T[])], head } };
  }

  // Pre-#950 shape: `pages` overflow FEEDS, rewritten in place. Read as before -
  // stamped like page 0 or refused - and replaced by a blob on the next write.
  const pages = typeof head.pages === "number" ? head.pages : 0;
  const all = [...first];
  for (let p = 1; p <= pages; p++) {
    const pg = await readFeedPageStrict(d.topic(p), { forWrite });
    if (pg.status === "error") return fail(`read failed (overflow page ${p}): ${pg.error.message}`);
    if (pg.status === "absent") return fail(`overflow page ${p} of ${pages} missing`);
    const env = decodeJsonFeed<{ updatedAt?: unknown }>(pg.data);
    const items = env ? d.items(env) : undefined;
    if (!env || !Array.isArray(items)) return fail(`overflow page ${p} did not decode`);
    if (env.updatedAt !== head.updatedAt) {
      return fail(`overflow page ${p} is torn (stamped ${String(env.updatedAt)}, page 0 ${String(head.updatedAt)})`);
    }
    all.push(...items);
  }
  return { status: "ok", contents: { items: all, head } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
