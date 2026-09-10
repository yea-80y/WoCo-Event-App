import type {
  ObjectDirectory, ObjectCategory, ObjectHolding, ObjectDirectoryEntry,
  SignedManifestV2, EditionV1Body, IssuerBindingV1,
} from "@woco/shared";
import { authGet, authPut, authPost, get } from "./client.js";

/**
 * object layer API client (Step 4). Reads/writes the creator object directory + the
 * public holdings read. Mirrors `api/sites.ts`. Server owner-stamps writes from
 * the verified session, so no address is sent.
 */

/** The signed-in creator's object directory (types + categories). Throws on error. */
export async function getMyObjects(): Promise<ObjectDirectory> {
  const r = await authGet<ObjectDirectory>("/api/pod/mine");
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to load objects");
  return r.data;
}

/** Replace the creator's object category list. Throws on error. */
export async function setObjectCategories(categories: ObjectCategory[]): Promise<ObjectCategory[]> {
  const r = await authPut<{ categories: ObjectCategory[] }>("/api/pod/categories", { categories });
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to save categories");
  return r.data.categories;
}

/**
 * Request body for minting a standalone badge/collectible type.
 *
 * v2 formats since PR 4 (issuer-curve migration): the manifest is
 * `woco.manifest.v2` signed by the derived issuing key, the bodies are
 * `woco.edition.v1`, and `issuerBinding` carries the issuing key's proof of
 * possession over the parent. THE PRE-5a SEAM: the server still reads
 * `objectBodies` and verifies v1 until PR 5a re-points it, so a live mint in the
 * window is refused loudly — covered by the deploy freeze (PRs 3–5a are one
 * deploy unit).
 */
export interface CreateObjectRequest {
  kind: "badge" | "collectible";
  name: string;
  description?: string;
  categoryId?: string;
  supply: number;
  /** Client-built, personal-signed by the creator's derived issuing key. */
  signedManifest: SignedManifestV2;
  /**
   * The edition bodies committed to by the manifest's Merkle root. `supply` of
   * them on the chain rail, where each is a claimable edition; exactly ONE
   * template body for a certificate badge, which has no editions to claim. The
   * server enforces the count per rail.
   */
  editionBodies: EditionV1Body[];
  /** Proof of possession binding the issuing key to the (server-verified)
   *  parent — same statement the event-create payload carries; the server
   *  (5a) pins `parent → issuer` and must check recovered == issuer ==
   *  the manifest's `body.issuer`. */
  issuerBinding: IssuerBindingV1;
  /** Display artwork — Swarm ref (no 0x) from uploadSiteImage. */
  image?: string;
  /**
   * How holdings of this badge are recorded. Absent means `chain` — today's
   * rail: sponsor-register the manifest so slot ownership is readable.
   * `cert` records holding as an issuer-signed certificate naming the
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
 * Mint a standalone object type. The server validates the signed manifest, uploads
 * the object bodies, sponsor-registers on-chain, and writes the directory entry —
 * returning the new entry. Throws on error.
 */
export async function createObject(req: CreateObjectRequest): Promise<ObjectDirectoryEntry> {
  const r = await authPost<ObjectDirectoryEntry>(
    "/api/pod",
    req as unknown as Record<string, unknown>,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to create object");
  return r.data;
}

/** Patch the mutable display fields of one object type (name, image, description, categoryId). */
export async function updateObject(
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
): Promise<ObjectDirectoryEntry> {
  const r = await authPut<ObjectDirectoryEntry>(
    `/api/pod/${encodeURIComponent(manifestRef)}`,
    patch,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to update object");
  return r.data;
}

/**
 * Public trustless holdings read — does `holder` hold this object type on-chain?
 * Used for "you hold N" previews and client-side gate hints (the server
 * re-checks authoritatively at claim/order time).
 */
export async function getObjectHolding(params: {
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
  return get<ObjectHolding>(`/api/pod/holdings?${q.toString()}`, params.apiUrl);
}

/** One attendee edition bound to an account. */
export interface AttendeeKeyRow {
  seriesId: string;
  edition: number;
  /** How the binding was made. Provenance, not proof — see below. */
  route: "email-link" | "claim";
}

/**
 * Attendees of one of your events whose ticket is bound to an account.
 * Organiser-only.
 *
 * NO BADGE KEY COMES BACK (#518). The ed25519 key these rows used to carry was
 * self-declared by the claiming client and never checked against anything
 * (#345); it is gone with the rest of the holder key, and the certificate rail
 * has no holder identity to offer until its own secp256k1 migration lands. Every
 * bound edition is therefore un-certifiable, and the surface must say so.
 *
 * Every binding is returned — a list that came back short cannot be told apart
 * from one where nobody qualifies.
 */
export async function getAttendeeKeys(eventId: string): Promise<AttendeeKeyRow[]> {
  const r = await authGet<{ eventId: string; attendees: AttendeeKeyRow[] }>(
    `/api/events/${encodeURIComponent(eventId)}/attendee-keys`,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to load attendee keys");
  return r.data.attendees;
}
