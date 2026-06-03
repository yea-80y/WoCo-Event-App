import type { PodDirectory, PodCategory, PodHolding } from "@woco/shared";
import { authGet, authPut, get } from "./client.js";

/**
 * POD layer API client (Step 4). Reads/writes the creator POD directory + the
 * public holdings read. Mirrors `api/sites.ts`. Server owner-stamps writes from
 * the verified session, so no address is sent.
 */

/** The signed-in creator's POD directory (types + categories). Throws on error. */
export async function getMyPods(): Promise<PodDirectory> {
  const r = await authGet<PodDirectory>("/api/pod/mine");
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to load PODs");
  return r.data;
}

/** Replace the creator's POD category list. Throws on error. */
export async function setPodCategories(categories: PodCategory[]): Promise<PodCategory[]> {
  const r = await authPut<{ categories: PodCategory[] }>("/api/pod/categories", { categories });
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to save categories");
  return r.data.categories;
}

/**
 * Public trustless holdings read — does `holder` hold this POD type on-chain?
 * Used for "you hold N" previews and client-side gate hints (the server
 * re-checks authoritatively at claim/order time).
 */
export async function getPodHolding(params: {
  holder: string;
  onChainEventId: string;
  manifestRef: string;
  chainId: number;
  apiUrl?: string;
}) {
  const q = new URLSearchParams({
    holder: params.holder,
    onChainEventId: params.onChainEventId,
    manifestRef: params.manifestRef,
    chainId: String(params.chainId),
  });
  return get<PodHolding>(`/api/pod/holdings?${q.toString()}`, params.apiUrl);
}
