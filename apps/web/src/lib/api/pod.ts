import type {
  PodDirectory, PodCategory, PodHolding, PodDirectoryEntry,
  SignedManifestV1, PodV2Body,
} from "@woco/shared";
import { authGet, authPut, authPost, get } from "./client.js";

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

/** Request body for minting a standalone POD type (badge/collectible). */
export interface CreatePodRequest {
  kind: "badge" | "collectible";
  name: string;
  description?: string;
  categoryId?: string;
  supply: number;
  /** Client-built, ed25519-signed by the creator's POD key. */
  signedManifest: SignedManifestV1;
  /** The `supply` pre-signed pod bodies committed to by the manifest. */
  podBodies: PodV2Body[];
  /** Display artwork — Swarm ref (no 0x) from uploadSiteImage. */
  image?: string;
}

/**
 * Mint a standalone POD type. The server validates the signed manifest, uploads
 * the pod bodies, sponsor-registers on-chain, and writes the directory entry —
 * returning the new entry. Throws on error.
 */
export async function createPod(req: CreatePodRequest): Promise<PodDirectoryEntry> {
  const r = await authPost<PodDirectoryEntry>(
    "/api/pod",
    req as unknown as Record<string, unknown>,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to create POD");
  return r.data;
}

/** Patch the mutable display fields of one POD type (name, image, description, categoryId). */
export async function updatePod(
  manifestRef: string,
  patch: {
    name?: string;
    description?: string;
    image?: string;
    categoryId?: string | null;
  },
): Promise<PodDirectoryEntry> {
  const r = await authPut<PodDirectoryEntry>(
    `/api/pod/${encodeURIComponent(manifestRef)}`,
    patch,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to update POD");
  return r.data;
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
