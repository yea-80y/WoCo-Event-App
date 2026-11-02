/**
 * The live reads behind `browser-orders.ts` (#965): the ticket ledger through a
 * public RPC, in multicall batches, and sealed orders from our gateway.
 *
 * Sealed orders are fetched with `cache: "no-store"`: the gateway sends them with
 * no Cache-Control and an ETag, so a browser would otherwise keep a copy on disk
 * that outlives an erasure (#546). Any RPC origin added here must also be in the
 * CSP `connect-src` list (apps/web/vite-plugins/csp.ts).
 */
import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { authPost } from "../../api/client.js";
import { buildEnv } from "../../build-env.js";
import { WOCO_GATEWAY_URL } from "../../swarm/gateways.js";
import type { BrowserOrdersDeps, SlotRead } from "./browser-orders.js";
import type { FetchResult, GatewayBudget } from "./detail-queue.js";

const LEDGER_CHAINS: Record<number, { chain: Chain; rpc: string }> = {
  42161: { chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  421614: { chain: arbitrumSepolia, rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
};

/** The ticket ledger (both versions share these reads), on a chain we have an RPC for. */
export function canReadLedger(ledger: OrdersSeriesLedger): boolean {
  return (ledger.version === "ledger" || ledger.version === "ledger2") && ledger.chainId in LEDGER_CHAINS;
}

const LEDGER_ABI = [
  {
    type: "function",
    name: "getEvent",
    stateMutability: "view",
    inputs: [{ name: "eventId", type: "bytes32" }],
    outputs: [
      { name: "totalSupply", type: "uint64" },
      { name: "nextSlot", type: "uint64" },
      { name: "organiser", type: "address" },
      { name: "manifestRef", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "getSlotData",
    stateMutability: "view",
    inputs: [
      { name: "eventId", type: "bytes32" },
      { name: "slot", type: "uint256" },
    ],
    outputs: [
      { name: "holder", type: "address" },
      { name: "claimer", type: "address" },
      { name: "orderRef", type: "bytes32" },
    ],
  },
] as const;

/**
 * Slot reads per eth_call: ~4 calls for 1,000 tickets. Every multicall passes
 * `batchSize: 0`: viem otherwise splits at 1,024 bytes (~6 slot reads), which
 * would be ~160 calls against a rate-limited public RPC.
 */
const MULTICALL_CHUNK = 250;
/** A sealed order is at most 16 KB of JSON (MAX_ORDER_BOX_JSON). */
const MAX_BOX_TEXT = 64 * 1024;

const clients = new Map<number, Promise<import("viem").PublicClient>>();
function clientFor(chainId: number): Promise<import("viem").PublicClient> {
  let c = clients.get(chainId);
  if (!c) {
    const conf = LEDGER_CHAINS[chainId];
    if (!conf) throw new Error(`no RPC for chain ${chainId}`);
    c = import("viem").then(({ createPublicClient, http }) =>
      createPublicClient({ chain: conf.chain, transport: http(conf.rpc, { timeout: 20_000 }) }) as import("viem").PublicClient,
    );
    clients.set(chainId, c);
  }
  return c;
}

async function nextSlots(ledgers: OrdersSeriesLedger[]): Promise<number[]> {
  const out = new Array<number>(ledgers.length);
  for (const chainId of new Set(ledgers.map((l) => l.chainId))) {
    const idx = ledgers.flatMap((l, i) => (l.chainId === chainId ? [i] : []));
    const client = await clientFor(chainId);
    // allowFailure false: a count we cannot read throws, never reads as zero sales.
    const results = await client.multicall({
      batchSize: 0,
      allowFailure: false,
      contracts: idx.map((i) => ({
        address: ledgers[i].contract as `0x${string}`,
        abi: LEDGER_ABI,
        functionName: "getEvent" as const,
        args: [ledgers[i].onChainEventId as `0x${string}`],
      })),
    });
    idx.forEach((i, k) => (out[i] = Number((results[k] as readonly [bigint, bigint, string, string])[1])));
  }
  return out;
}

/** Multicalls in flight at once: 20,000 slots = 80 calls, ~17 s one after another (measured ~217 ms each). */
const MULTICALL_PARALLEL = 3;

async function slots(ledger: OrdersSeriesLedger, from: number, to: number): Promise<Array<SlotRead | null>> {
  const client = await clientFor(ledger.chainId);
  const starts: number[] = [];
  for (let start = from; start < to; start += MULTICALL_CHUNK) starts.push(start);
  const chunks = new Array<Array<SlotRead | null>>(starts.length);
  let next = 0;
  const readChunk = async (start: number): Promise<Array<SlotRead | null>> => {
    const end = Math.min(to, start + MULTICALL_CHUNK);
    // A failed call is null (read again next time); a failed batch throws.
    const results = await client.multicall({
      batchSize: 0,
      allowFailure: true,
      contracts: Array.from({ length: end - start }, (_, k) => ({
        address: ledger.contract as `0x${string}`,
        abi: LEDGER_ABI,
        functionName: "getSlotData" as const,
        args: [ledger.onChainEventId as `0x${string}`, BigInt(start + k)] as const,
      })),
    });
    return results.map((r) => {
      if (r.status !== "success") return null;
      const [holder, , orderRef] = r.result as readonly [string, string, string];
      return { owner: holder.toLowerCase(), orderRef };
    });
  };
  await Promise.all(
    Array.from({ length: Math.min(MULTICALL_PARALLEL, starts.length) }, async () => {
      while (next < starts.length) {
        const i = next++;
        chunks[i] = await readChunk(starts[i]);
      }
    }),
  );
  return chunks.flat();
}

/** Whole seconds, or an HTTP date; null when absent or unreadable. */
function retryAfterMs(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * The draft RateLimit headers (`RateLimit-Limit/-Remaining/-Reset`, reset in
 * seconds). Readable on the gateway's own origin only: cross-origin, a header the
 * gateway does not list in Access-Control-Expose-Headers reads as absent.
 */
export function readBudget(headers: Headers): GatewayBudget | undefined {
  const limit = Number(headers.get("ratelimit-limit") ?? NaN);
  const remaining = Number(headers.get("ratelimit-remaining") ?? NaN);
  const reset = Number(headers.get("ratelimit-reset") ?? NaN);
  if (![limit, remaining, reset].every((n) => Number.isFinite(n) && n >= 0) || limit === 0) return undefined;
  return { limit, remaining, resetMs: reset * 1000 };
}

/**
 * One sealed order from our gateway, and why not when it is not there. A 403 is
 * retried, never final: the erasure answer already said this root is not erased,
 * so a refusal is the gateway's list lagging the store, which the server's
 * reconcile repairs (order-gateway.ts).
 */
export async function fetchOrderBox(root: string): Promise<FetchResult> {
  const gateway = buildEnv(() => import.meta.env.VITE_GATEWAY_URL as string | undefined) || WOCO_GATEWAY_URL;
  let resp: Response;
  try {
    resp = await fetch(`${gateway}/bytes/${root}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch {
    return { kind: "unavailable" };
  }
  const budget = readBudget(resp.headers);
  if (resp.status === 429) {
    const wait = retryAfterMs(resp.headers, Date.now()) ?? budget?.resetMs;
    return { kind: "limited", ...(wait !== undefined ? { retryAfterMs: wait } : {}), budget };
  }
  if (resp.status === 404) return { kind: "missing", budget };
  if (!resp.ok) return { kind: "unavailable", budget };
  if (Number(resp.headers.get("content-length")) > MAX_BOX_TEXT) return { kind: "unreadable", budget };
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return { kind: "unavailable", budget };
  }
  try {
    if (text.length > MAX_BOX_TEXT) return { kind: "unreadable", budget };
    const box = JSON.parse(text) as { enc?: unknown; ct?: unknown };
    return typeof box.enc === "string" && typeof box.ct === "string"
      ? { kind: "ok", box: box as unknown as SealedBoxV2, budget }
      : { kind: "unreadable", budget };
  } catch {
    return { kind: "unreadable", budget };
  }
}

export function liveBrowserOrdersDeps(eventId: string): BrowserOrdersDeps {
  return {
    async status(roots, opts) {
      const resp = await authPost<OrdersStatus>(`/api/events/${eventId}/orders/status`, { roots }, undefined, opts);
      if (!resp.ok || !resp.data) throw new Error(resp.error || "Could not read the orders' status");
      return resp.data;
    },
    nextSlots,
    slots,
  };
}
