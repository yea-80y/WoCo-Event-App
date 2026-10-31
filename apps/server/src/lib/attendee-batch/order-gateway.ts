/**
 * Stored attendee orders are readable through our gateway; erased ones are not (#965).
 *
 * The organiser's browser is to fetch sealed orders itself (`/bytes/{root}`), so
 * the server stops reading every order on every dashboard load. The proxy serves
 * only listed hashes, so each stored order's ROOT is listed (bee resolves the
 * rest of its chunks), and an erasure takes it off before the burn starts. The
 * ciphertext is already public on Swarm and the root is on chain (SlotClaimed),
 * so listing widens nothing; delisting is a second erasure signal that also
 * covers our own bee's cache, which a burn cannot reach.
 *
 * Both hooks are best effort and never fail a store or an erasure. The reconcile
 * is the guarantee: from the attendee ledger it lists every order not erased and
 * delists every erased one, delisting first. It reads only the ledger's own
 * records, so a ledger that reads empty delists nothing. The caller runs it only
 * on a server that owns an attendee batch: a dev server (stamper key blanked)
 * never edits the production proxy.
 */
import { getOrderRecord, isOrderErased, listOrders, type OrderRecord } from "./ledger.js";
import { listWhitelist, unwhitelistHash, whitelistHashes } from "../swarm/whitelist.js";

export interface OrderGatewayDeps {
  /** Every listed hash; null = no proxy configured. */
  list(): Promise<Set<string> | null>;
  add(hashes: string[]): Promise<void>;
  remove(hash: string): Promise<void>;
}

const liveDeps: OrderGatewayDeps = { list: listWhitelist, add: whitelistHashes, remove: unwhitelistHash };

/** The proxy's JSON body limit is 100 KB; a hash is ~67 bytes of it. */
const ADD_BATCH = 1000;

/**
 * Never to be listed: erased, or an erasure has started. `erasedBy` is written
 * before the burn delists and plans its first chunk, so a listing racing the
 * start of an erasure still sees it.
 */
function erasureStarted(root: string, record: OrderRecord | null = getOrderRecord(root)): boolean {
  return isOrderErased(root) || !!record?.erasedBy;
}

/**
 * List a freshly stored order. Never throws: the reconcile retries. An erasure
 * that ran while the listing was in flight wins: the root is delisted again.
 */
export async function listOrderRoot(root: string, deps: OrderGatewayDeps = liveDeps): Promise<void> {
  const r = root.toLowerCase();
  try {
    await deps.add([r]);
  } catch (err) {
    console.warn(`[order-gateway] could not list ${r}; the reconcile will:`, (err as Error).message);
    return;
  }
  if (erasureStarted(r)) await delistOrderRoot(r, deps);
}

/** Delist an order an erasure is starting on. Never throws: the reconcile retries. */
export async function delistOrderRoot(root: string, deps: OrderGatewayDeps = liveDeps): Promise<void> {
  try {
    await deps.remove(root.toLowerCase());
  } catch (err) {
    console.warn(`[order-gateway] could not delist ${root}; the reconcile will:`, (err as Error).message);
  }
}

export interface OrderGatewayStatus {
  lastRunAt: string | null;
  lastError: string | null;
  listed: number;
  delisted: number;
}

let status: OrderGatewayStatus = { lastRunAt: null, lastError: null, listed: 0, delisted: 0 };

export function orderGatewayStatus(): OrderGatewayStatus {
  return { ...status };
}

/**
 * Make the proxy's list agree with the ledger for every recorded order. Returns
 * what it changed, or null when no proxy is configured. Throws on a failed call,
 * after recording it for `/api/health`.
 */
export async function reconcileOrderGateway(
  deps: OrderGatewayDeps = liveDeps,
  nowMs: number = Date.now(),
): Promise<{ listed: number; delisted: number } | null> {
  const at = new Date(nowMs).toISOString();
  try {
    const present = await deps.list();
    if (present === null) return null;
    const toList: string[] = [];
    const toDelist: string[] = [];
    for (const { root, record } of listOrders()) {
      if (erasureStarted(root, record)) {
        if (present.has(root)) toDelist.push(root);
      } else if (record.chunks.length > 0 && !present.has(root)) {
        toList.push(root);
      }
    }
    for (const root of toDelist) await deps.remove(root);
    // The awaits above and below let an erasure start: filter each batch again,
    // then take back any root whose erasure started while it was being listed.
    const listed: string[] = [];
    for (let i = 0; i < toList.length; i += ADD_BATCH) {
      const batch = toList.slice(i, i + ADD_BATCH).filter((root) => !erasureStarted(root));
      if (batch.length === 0) continue;
      await deps.add(batch);
      listed.push(...batch);
    }
    const retaken = listed.filter((root) => erasureStarted(root));
    for (const root of retaken) await deps.remove(root);
    const counts = { listed: listed.length - retaken.length, delisted: toDelist.length + retaken.length };
    status = { lastRunAt: at, lastError: null, ...counts };
    if (counts.listed || counts.delisted) {
      console.log(`[order-gateway] listed ${counts.listed}, delisted ${counts.delisted}`);
    }
    return counts;
  } catch (err) {
    status = { ...status, lastRunAt: at, lastError: (err as Error).message };
    throw err;
  }
}

const RECONCILE_EVERY_MS = 60 * 60 * 1000;
let lastSuccessMs: number | null = null;
let inFlight = false;

/**
 * Called every few minutes: reconciles an hour after the last success, so a
 * failure is retried on the next call. A slow run is never overlapped by the next.
 */
export async function tickOrderGateway(nowMs: number = Date.now(), deps: OrderGatewayDeps = liveDeps): Promise<void> {
  if (inFlight) return;
  if (lastSuccessMs !== null && nowMs - lastSuccessMs < RECONCILE_EVERY_MS) return;
  inFlight = true;
  try {
    await reconcileOrderGateway(deps, nowMs);
    lastSuccessMs = nowMs;
  } finally {
    inFlight = false;
  }
}

/** Test seam only. */
export function _resetOrderGatewayForTests(): void {
  status = { lastRunAt: null, lastError: null, listed: 0, delisted: 0 };
  lastSuccessMs = null;
  inFlight = false;
}
