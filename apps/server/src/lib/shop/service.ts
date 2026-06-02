import { Topic } from "@ethersphere/bee-js";
import { randomBytes } from "node:crypto";
import {
  shopConfigTopic,
  shopProductsTopic,
  shopOrdersTopic,
  shopCreatorDirectoryTopic,
} from "@woco/shared";
import type {
  Shop,
  Product,
  Order,
  ProductsIndex,
  OrdersLog,
  ShopDirectory,
  ShopDirectoryEntry,
} from "@woco/shared";
import {
  readFeedPage,
  readFeedPageStrict,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";

const PAGE_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Per-shop serialization — writeFeedPage guards feed-index races, but
// read-modify-write of the catalog / order log still needs app-level
// serialization or concurrent orders silently clobber each other.
// ---------------------------------------------------------------------------

const shopLocks = new Map<string, Promise<unknown>>();

function withShopLock<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
  const prev = shopLocks.get(shopId) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(fn);
  shopLocks.set(shopId, task.catch(() => undefined));
  return task as Promise<T>;
}

// ---------------------------------------------------------------------------
// Generic paged JSON-array feed I/O
// ---------------------------------------------------------------------------

type Envelope<T> = { items: T[]; pages: number; updatedAt: string };

/** Split items into <4096-byte pages and write page 0 (+ overflow) for a feed. */
async function writePagedFeed<T>(
  items: T[],
  topicFn: (p: number) => string,
  makeEnvelope: (e: Envelope<T>) => unknown,
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
 * transient read error. A swallowed [] from a transient failure would let the
 * next write overwrite the feed with a partial view (same hazard the site
 * directory guards against). Bootstrap (page 0 absent) returns [].
 */
async function readPagedFeedStrict<T>(
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
async function readPagedFeedLenient<T>(
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

// ---------------------------------------------------------------------------
// Shop config
// ---------------------------------------------------------------------------

export async function getShop(shopId: string): Promise<Shop | null> {
  const page = await readFeedPage(Topic.fromString(shopConfigTopic(shopId)));
  if (!page) return null;
  return decodeJsonFeed<Shop>(page);
}

export type ShopReadResult =
  | { status: "present"; shop: Shop }
  | { status: "absent" }
  | { status: "error"; error: Error };

/**
 * Strict read for the WRITE path. A swallowed null from a transient Swarm
 * failure must NOT be treated as "no such shop" on the create-or-update path —
 * doing so would skip the ownership check and let a caller overwrite an
 * existing shop's owner. "error" → refuse to write; "absent" → genuinely new.
 */
export async function getShopStrict(shopId: string): Promise<ShopReadResult> {
  const page = await readFeedPageStrict(Topic.fromString(shopConfigTopic(shopId)));
  if (page.status === "error") return { status: "error", error: page.error };
  if (page.status === "absent") return { status: "absent" };
  const shop = decodeJsonFeed<Shop>(page.data);
  if (!shop) return { status: "error", error: new Error("Shop config decoded to null") };
  return { status: "present", shop };
}

export async function writeShop(shop: Shop): Promise<void> {
  await writeFeedPage(Topic.fromString(shopConfigTopic(shop.shopId)), encodeJsonFeed(shop));
}

// ---------------------------------------------------------------------------
// Products (catalog)
// ---------------------------------------------------------------------------

const productExtract = (e: unknown) => (e as ProductsIndex).products;
const pagesExtract = (e: unknown) => (e as { pages?: number }).pages ?? 0;

export async function getProducts(shopId: string): Promise<Product[]> {
  return readPagedFeedLenient<Product>(
    (p) => shopProductsTopic(shopId, p),
    productExtract,
    pagesExtract,
  );
}

function makeProductsEnvelope(shopId: string) {
  return ({ items, pages, updatedAt }: Envelope<Product>): ProductsIndex => ({
    v: 1,
    shopId,
    products: items,
    updatedAt,
    pages,
  });
}

/** Replace the entire catalog (used after building a new product list). */
export async function writeProducts(shopId: string, products: Product[]): Promise<void> {
  await writePagedFeed(products, (p) => shopProductsTopic(shopId, p), makeProductsEnvelope(shopId));
}

export async function upsertProduct(shopId: string, product: Product): Promise<Product[]> {
  return withShopLock(shopId, async () => {
    const existing = await readPagedFeedStrict<Product>(
      (p) => shopProductsTopic(shopId, p),
      productExtract,
      pagesExtract,
    );
    const filtered = existing.filter((p) => p.productId !== product.productId);
    const updated = [...filtered, product].sort((a, b) => a.sortIndex - b.sortIndex);
    await writeProducts(shopId, updated);
    return updated;
  });
}

export async function deleteProduct(shopId: string, productId: string): Promise<Product[]> {
  return withShopLock(shopId, async () => {
    const existing = await readPagedFeedStrict<Product>(
      (p) => shopProductsTopic(shopId, p),
      productExtract,
      pagesExtract,
    );
    const updated = existing.filter((p) => p.productId !== productId);
    await writeProducts(shopId, updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const orderExtract = (e: unknown) => (e as OrdersLog).orders;

export async function getOrders(shopId: string): Promise<Order[]> {
  return readPagedFeedLenient<Order>(
    (p) => shopOrdersTopic(shopId, p),
    orderExtract,
    pagesExtract,
  );
}

function makeOrdersEnvelope(shopId: string) {
  return ({ items, pages, updatedAt }: Envelope<Order>): OrdersLog => ({
    v: 1,
    shopId,
    orders: items,
    updatedAt,
    pages,
  });
}

/** Append a new order (newest first) under the per-shop lock. */
export async function appendOrder(shopId: string, order: Order): Promise<void> {
  await withShopLock(shopId, async () => {
    const existing = await readPagedFeedStrict<Order>(
      (p) => shopOrdersTopic(shopId, p),
      orderExtract,
      pagesExtract,
    );
    const updated = [order, ...existing];
    await writePagedFeed(updated, (p) => shopOrdersTopic(shopId, p), makeOrdersEnvelope(shopId));
  });
}

/** Patch an existing order in place (status transitions, payment attach). */
export async function updateOrder(
  shopId: string,
  orderId: string,
  patch: Partial<Order>,
): Promise<Order | null> {
  return withShopLock(shopId, async () => {
    const existing = await readPagedFeedStrict<Order>(
      (p) => shopOrdersTopic(shopId, p),
      orderExtract,
      pagesExtract,
    );
    const idx = existing.findIndex((o) => o.orderId === orderId);
    if (idx === -1) return null;
    const updated = { ...existing[idx], ...patch, orderId, shopId };
    existing[idx] = updated;
    await writePagedFeed(existing, (p) => shopOrdersTopic(shopId, p), makeOrdersEnvelope(shopId));
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Pickup code — short, human-readable, ambiguous glyphs removed (no O/0/I/1/etc).
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY3479";

export function genOrderCode(): string {
  const b = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

// ---------------------------------------------------------------------------
// Merchant shop directory (mirrors site creator directory)
// ---------------------------------------------------------------------------

const CREATOR_SHOPS_MEMO_TTL_MS = 5 * 60_000;
const _creatorShopsMemo = new Map<string, { at: number; data: ShopDirectoryEntry[] }>();

export function invalidateCreatorShopsCache(ethAddress: string): void {
  _creatorShopsMemo.delete(ethAddress.toLowerCase());
}

const shopDirExtract = (e: unknown) => (e as ShopDirectory).shops;

export async function getCreatorShops(
  ethAddress: string,
  opts: { fresh?: boolean } = {},
): Promise<ShopDirectoryEntry[]> {
  const key = ethAddress.toLowerCase();
  if (!opts.fresh) {
    const memo = _creatorShopsMemo.get(key);
    if (memo && Date.now() - memo.at < CREATOR_SHOPS_MEMO_TTL_MS) return memo.data;
  }
  const data = await readPagedFeedLenient<ShopDirectoryEntry>(
    (p) => shopCreatorDirectoryTopic(ethAddress, p),
    shopDirExtract,
    pagesExtract,
  );
  if (data.length > 0) _creatorShopsMemo.set(key, { at: Date.now(), data });
  return data;
}

export async function upsertCreatorShop(
  ethAddress: string,
  entry: ShopDirectoryEntry,
): Promise<void> {
  const existing = await readPagedFeedStrict<ShopDirectoryEntry>(
    (p) => shopCreatorDirectoryTopic(ethAddress, p),
    shopDirExtract,
    pagesExtract,
  );
  const filtered = existing.filter((e) => e.shopId !== entry.shopId);
  const updated = [entry, ...filtered]; // most-recently-updated first
  const updatedAt = new Date().toISOString();
  await writePagedFeed(
    updated,
    (p) => shopCreatorDirectoryTopic(ethAddress, p),
    ({ items, pages }): ShopDirectory => ({
      v: 1,
      owner: ethAddress.toLowerCase() as ShopDirectory["owner"],
      shops: items,
      updatedAt,
      pages,
    }),
  );
  invalidateCreatorShopsCache(ethAddress);
  console.log(`[shop] Creator directory updated for ${ethAddress}: ${updated.length} shop(s)`);
}
