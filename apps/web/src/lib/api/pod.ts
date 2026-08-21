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
  /**
   * The pod bodies committed to by the manifest's Merkle root. `supply` of them
   * on the chain rail, where each is a claimable edition; exactly ONE template
   * body for a certificate badge, which has no editions to claim. The server
   * enforces the count per rail.
   */
  podBodies: PodV2Body[];
  /** Display artwork — Swarm ref (no 0x) from uploadSiteImage. */
  image?: string;
  /**
   * How holdings of this badge are recorded. Absent means `chain` — today's
   * rail: sponsor-register the manifest so slot ownership is readable.
   * `pod-cert` records holding as an issuer-signed certificate naming the
   * holder's key, so there is no chain registration at all.
   */
  holdingSource?: "pod-cert";
  /**
   * REQUIRED with `holdingSource: "pod-cert"`, and the server refuses without
   * it: the issuer's secp256k1 content-feed address. Chunk addresses are
   * `keccak256(identifier ‖ owner)` and the owner half appears in no public
   * artifact, so a certificate badge minted without this has a log nobody —
   * including its own issuer, on a different device — can ever find.
   *
   * MUST come from `auth.getContentFeedSigner()`, never typed or derived
   * elsewhere: it has to be the address the issuing client will actually write
   * under.
   */
  certLogOwner?: string;
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
    /**
     * Distinct holders certified so far. CERTIFICATE BADGES ONLY — the server
     * refuses it on anything chain-sourced, whose count it can derive itself.
     * Display layer: the recomputable truth is the issuer's signed log.
     */
    issuedCount?: number;
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

/** One attendee edition and whether it has a badge key on file. */
export interface AttendeeKeyRow {
  seriesId: string;
  edition: number;
  /** Absent = this attendee cannot be certified yet. Shown, never dropped. */
  podPubKey?: string;
  /** How the binding was made. Provenance, not proof — see below. */
  route: "email-link" | "claim";
}

/**
 * Attendees of one of your events, and their badge keys where the platform has
 * one. Organiser-only.
 *
 * READ THE PROVENANCE BEFORE USING THESE TO ISSUE. `podPubKey` is self-declared
 * by the claiming client and was never checked against that account's actual
 * POD identity (#345). A row proves the platform saw a verified possession
 * proof for that edition; it does not prove whose badge key this is. A
 * certificate is permanent and has no v1 revocation, so the surface must show
 * that caveat where the organiser decides, not bury it here.
 *
 * Rows with NO key are returned deliberately — a list of only the certifiable
 * ones cannot be told apart from a list that came back short.
 */
export async function getAttendeeKeys(eventId: string): Promise<AttendeeKeyRow[]> {
  const r = await authGet<{ eventId: string; attendees: AttendeeKeyRow[] }>(
    `/api/events/${encodeURIComponent(eventId)}/attendee-keys`,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to load attendee keys");
  return r.data.attendees;
}
