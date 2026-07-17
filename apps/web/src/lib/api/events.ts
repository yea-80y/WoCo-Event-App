import type {
  EventFeed,
  EventDirectoryEntry,
  SnapshotCard,
  CreateEventV2Request,
  UpdateEventMetaRequest,
  CreateEventResponse,
  ClaimTicketResponse,
  SeriesClaimStatus,
  UserCollection,
  ClaimedTicket,
  SealedBox,
  OrderEntry,
} from "@woco/shared";
export type { OrderEntry };
import { authPost, authGet, get, apiBase, buildAuthHeaders, currentSiteId } from "./client.js";
import { auth } from "../auth/auth-store.svelte.js";
import { eventContentTopic } from "@woco/shared";
import { writeContentFeed, type ContentFeedSigner } from "../swarm/content-feed.js";
import { trashFeedOnManifest } from "../manifest/feed-log.js";

export interface PublishProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

/**
 * Sign + upload an event detail feed as the user's client-owned SOC. The server
 * never writes this feed — the owner does, here. Used on publish and whenever a
 * server op (on-chain registration, sub-ENS stamp) hands back an updated feed.
 *
 * `knownVersion` skips the latest-version probe (a missing-chunk network search):
 * pass it ONLY within the publish flow, where the eventId was minted this request
 * (version 0) or the previous write's version is in hand (+1). Returns the version
 * written so the caller can chain the next exact write.
 */
export async function signEventFeedSoc(
  feed: EventFeed,
  signer: ContentFeedSigner,
  knownVersion?: number,
): Promise<number> {
  return writeContentFeed({
    signerPrivKey: signer.privKey,
    topic: eventContentTopic(feed.eventId),
    data: feed,
    ...(knownVersion !== undefined ? { knownVersion } : {}),
    // Route the stamp to the batch the event content lives on. The feed carries its
    // own storage gateway (Etherna user batch vs WoCo); without this, an Etherna
    // event's detail SOC would be stamped on the WoCo batch on every edit/restamp.
    ...(feed.gatewayUrl ? { gatewayUrl: feed.gatewayUrl } : {}),
  });
}

/**
 * Create event with streaming progress (v2 — manifest-based).
 * Reads NDJSON from the server and calls onProgress for each update.
 *
 * @param baseUrlOverride  Target a different API server (e.g. organiser's self-hosted backend).
 * @param feedSigner  Phase B: when provided, the event becomes a CLIENT-OWNED feed —
 *   the server stamps `feedSigner.address` into the directory (discovery carrier) and
 *   skips the platform write, returning the assembled feed for the client to sign as a
 *   SOC here. Only valid against the default server (the SOC upload targets apiBase's
 *   postage batch), so callers MUST pass null when baseUrlOverride is set.
 * @param opts.deferFeedSign  Skip the SOC write here and hand the unsigned feed back
 *   in `result.eventFeed`. For paid-series publishes the caller signs ONCE after
 *   on-chain registration (a version-0 write here would be obsolete the moment the
 *   post-registration re-sign lands — one wasted round trip + stamped chunk per
 *   publish). The caller then OWNS the write: it must sign version 0 even when
 *   registration fails, or the event is unreadable once the server cache expires.
 */
export async function createEventStreaming(
  req: CreateEventV2Request,
  onProgress?: (p: PublishProgress) => void,
  baseUrlOverride?: string,
  feedSigner?: ContentFeedSigner | null,
  opts: { deferFeedSign?: boolean } = {},
): Promise<CreateEventResponse> {
  const base = baseUrlOverride ?? apiBase;
  // Stamp the signer address into the request so the server carries it into the
  // directory entry and returns the feed for SOC signing instead of platform-writing.
  if (feedSigner) {
    req = { ...req, creatorFeedSigner: feedSigner.address as `0x${string}` };
  }
  const bodyText = JSON.stringify(req);
  const path = "/api/events";
  const authHeaders = await buildAuthHeaders("POST", path, bodyText);

  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: bodyText,
  });

  if (!resp.ok) {
    try {
      const json = await resp.json();
      return { ok: false, error: json.error || "Request failed" };
    } catch {
      return { ok: false, error: `Request failed (${resp.status})` };
    }
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateEventResponse = { ok: false, error: "No response" };
  // Phase B: the client-signed event feed the server hands back in `done`.
  let pendingFeed: EventFeed | null = null;

  const handleEvent = (ev: any) => {
    if (ev.type === "progress") onProgress?.(ev as PublishProgress);
    else if (ev.type === "done") {
      result = { ok: true, eventId: ev.data?.eventId };
      if (ev.data?.eventFeed) pendingFeed = ev.data.eventFeed as EventFeed;
    } else if (ev.type === "error") result = { ok: false, error: ev.error };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* skip unparseable lines */ }
    }
  }
  if (buffer.trim()) {
    try { handleEvent(JSON.parse(buffer)); } catch { /* ignore */ }
  }

  // Phase B: sign + upload the event detail feed as a client-owned SOC. The server
  // only stamped the directory carrier; the feed itself is unreadable until this
  // lands, so a failure here fails the publish (the organiser retries).
  // The eventId was minted by the server THIS request, so the topic is fresh —
  // version 0 is exact and the latest-version probe (missing-chunk searches) is
  // skipped. A retried publish gets a NEW eventId, so 0 can never collide.
  if (result.ok && feedSigner && pendingFeed) {
    if (opts.deferFeedSign) {
      // Caller signs after registration (see @param deferFeedSign).
      result = { ...result, eventFeed: pendingFeed };
    } else {
      try {
        onProgress?.({ type: "progress", phase: "finalize", current: 0, total: 1, message: "Signing event feed..." });
        await signEventFeedSoc(pendingFeed, feedSigner, 0);
        onProgress?.({ type: "progress", phase: "finalize", current: 1, total: 1, message: "Event feed signed" });
        result = { ...result, eventFeed: pendingFeed };
      } catch (e) {
        return { ok: false, error: `Failed to sign event feed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  return result;
}

/**
 * Edit event-level metadata (title/tagline/description/dates/location/image).
 * Series data is manifest-committed + on-chain anchored — not editable.
 *
 * Phase B: the server only patches the platform directory entries and returns
 * the merged feed; the feed OWNER re-signs the event SOC here. Legacy events
 * are platform-rewritten server-side (merged feed still returned for the UI).
 *
 * @param opts.image       base64/data-URL replacement image (server uploads + whitelists).
 * @param opts.gatewayUrl  the event's storage gateway — routes the image stamp to its batch.
 * @param opts.feedSigner  the organiser's content-feed signer (Phase B). Its address is
 *   sent as the carrier hint so UNLISTED client-owned events resolve server-side.
 */
export async function updateEventMeta(
  eventId: string,
  updates: Pick<UpdateEventMetaRequest, "title" | "tagline" | "description" | "startDate" | "endDate" | "location" | "tags" | "geo">,
  opts: { image?: string; gatewayUrl?: string; feedSigner?: ContentFeedSigner | null } = {},
): Promise<EventFeed | null> {
  const resp = await authPost<{ eventId: string; eventFeed?: EventFeed }>(
    `/api/events/${eventId}/update-meta`,
    {
      ...updates,
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
      ...(opts.feedSigner ? { signer: opts.feedSigner.address } : {}),
    } satisfies UpdateEventMetaRequest,
  );
  if (!resp.ok) throw new Error(resp.error || "Failed to update event");

  // Phase B: re-sign the client-owned SOC with the merged feed. Only when the
  // returned feed is OURS — the SOC key must never sign a feed it doesn't own.
  const feed = resp.data?.eventFeed;
  if (feed?.creatorFeedSigner && opts.feedSigner
      && feed.creatorFeedSigner.toLowerCase() === opts.feedSigner.address.toLowerCase()) {
    await signEventFeedSoc(feed, opts.feedSigner);
    return feed;
  }
  return feed ?? null;
}

/**
 * Delete an event — only possible while it has ZERO orders (the server verifies
 * on-chain claims, legacy claim feeds, pending approvals and live buyer holds,
 * fail-closed). Feeds can't be erased from Swarm, so "delete" = tombstone: the
 * server removes both directory entries and, for Phase B events, hands back the
 * tombstoned feed for the OWNER to overwrite their SOC with here. The manifest
 * entry moves to trash so a future batch migration drops the feed.
 */
export async function deleteEvent(
  eventId: string,
  opts: { feedSigner?: ContentFeedSigner | null } = {},
): Promise<void> {
  const resp = await authPost<{ eventId: string; eventFeed?: EventFeed }>(
    `/api/events/${eventId}/delete`,
    { ...(opts.feedSigner ? { signer: opts.feedSigner.address } : {}) },
  );
  if (!resp.ok) throw new Error(resp.error || "Failed to delete event");

  const feed = resp.data?.eventFeed;
  if (feed?.creatorFeedSigner && opts.feedSigner
      && feed.creatorFeedSigner.toLowerCase() === opts.feedSigner.address.toLowerCase()) {
    await signEventFeedSoc(feed, opts.feedSigner);
  }
  // Manifest bookkeeping (best-effort): the feed is deletion-by-omission on the
  // next batch migration once its entry sits in trash.
  void trashFeedOnManifest("event", eventContentTopic(eventId));
}

/** Fetch the organiser's current nonce on the active chain (used to predict on-chain eventId). */
export async function getOrganiserNonce(address: string): Promise<{
  nonce: bigint;
  chainId: number;
  contractAddress: string;
}> {
  const resp = await get<{ address: string; nonce: string; chainId: number; contractAddress: string }>(
    `/api/events/organiser-nonce/${address.toLowerCase()}`,
  );
  if (!resp.data) throw new Error("Failed to fetch organiser nonce");
  return {
    nonce: BigInt(resp.data.nonce),
    chainId: resp.data.chainId,
    contractAddress: resp.data.contractAddress,
  };
}

/**
 * Register a series on-chain via the server's sponsor wallet.
 * No EOA or wallet connection needed — works for passkey/email organisers.
 */
export async function registerSeriesOnChain(
  eventId: string,
  seriesId: string,
): Promise<{ onChainEventId: string; txHash?: string; eventFeed?: EventFeed }> {
  // The route returns onChainEventId/txHash at the TOP level (not under .data),
  // so read the raw envelope rather than ApiResponse<T>'s data field.
  // The server resolves the event from trusted sources only (its cache, primed at
  // create, or the caller's platform-written creator index) — a client-supplied
  // signer carrier is deliberately not accepted.
  const resp = (await authPost<unknown>(
    `/api/events/${eventId}/register-on-chain`,
    { seriesId },
  )) as { ok: boolean; error?: string; onChainEventId?: string; txHash?: string; eventFeed?: EventFeed };
  if (!resp.ok || !resp.onChainEventId) {
    throw new Error(resp.error || "register-on-chain failed");
  }
  return { onChainEventId: resp.onChainEventId, txHash: resp.txHash, eventFeed: resp.eventFeed };
}

/** Confirm on-chain registration for a series after the organiser's registerEvent tx. */
export async function confirmChainRegistration(
  eventId: string,
  seriesId: string,
  onChainEventId: string,
  chainId: number,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(`/api/events/${eventId}/confirm-chain`, { seriesId, onChainEventId, chainId });
}

/**
 * The global directory. Cards are SnapshotCard (a superset of EventDirectoryEntry —
 * see service.ts `listEvents`), so this is typed as SnapshotCard[] to expose
 * `tags`/`geo` for client-side discovery filtering (#37 facet filter).
 */
export async function listEvents(): Promise<SnapshotCard[]> {
  const resp = await get<SnapshotCard[]>("/api/events");
  return resp.data ?? [];
}

/**
 * @param signer  Phase B discovery carrier — the organiser's content-feed-signer
 *   address, when the caller already holds it (e.g. from the directory entry or a
 *   cached feed). Lets the server read the client SOC as a pure relay, avoiding a
 *   directory scan. Omit it and the server resolves the carrier itself (cold load).
 */
export async function getEvent(eventId: string, apiUrl?: string, signer?: string): Promise<EventFeed | null> {
  const q = signer ? `?signer=${encodeURIComponent(signer)}` : "";
  const resp = await get<EventFeed>(`/api/events/${eventId}${q}`, apiUrl);
  return resp.data ?? null;
}

export async function claimTicket(
  eventId: string,
  seriesId: string,
  walletAddress: string,
  encryptedOrder?: SealedBox,
  apiUrl?: string,
  paymentProof?: import("@woco/shared").PaymentProof,
): Promise<ClaimTicketResponse> {
  // Wallet claims require session delegation (proves address ownership)
  const siteId = currentSiteId();
  // claimed.v2: cached POD pubkey only (never prompts a signature mid-claim) —
  // the ticket is issued to this identity and the account gate-bound at claim.
  const ownerPodPubKey = auth.podPublicKeyHex ?? undefined;
  const json = await authPost<ClaimTicketResponse>(
    `/api/events/${eventId}/series/${seriesId}/claim`,
    {
      mode: "wallet",
      walletAddress,
      encryptedOrder,
      ...(paymentProof ? { paymentProof } : {}),
      ...(siteId ? { siteId } : {}),
      ...(ownerPodPubKey ? { ownerPodPubKey } : {}),
    },
    apiUrl,
  );
  return {
    ok: json.ok,
    ticket: (json as any).ticket ?? json.data?.ticket,
    edition: (json as any).edition ?? json.data?.edition,
    approvalPending: (json as any).approvalPending,
    pendingId: (json as any).pendingId,
    error: json.error,
  };
}

export async function claimTicketByEmail(
  eventId: string,
  seriesId: string,
  email: string,
  encryptedOrder?: SealedBox,
  apiUrl?: string,
  paymentProof?: import("@woco/shared").PaymentProof,
): Promise<ClaimTicketResponse> {
  const siteId = currentSiteId();
  const resp = await fetch(`${apiUrl ?? apiBase}/api/events/${eventId}/series/${seriesId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "email", email, encryptedOrder, ...(paymentProof ? { paymentProof } : {}), ...(siteId ? { siteId } : {}) }),
  });
  const json = await resp.json();
  return {
    ok: json.ok,
    ticket: json.ticket ?? json.data?.ticket,
    edition: json.edition ?? json.data?.edition,
    approvalPending: json.approvalPending,
    pendingId: json.pendingId,
    error: json.error,
  };
}

export async function getClaimStatus(
  eventId: string,
  seriesId: string,
  userAddress?: string,
  userEmailHash?: string,
  apiUrl?: string,
): Promise<SeriesClaimStatus | null> {
  const params = new URLSearchParams();
  if (userAddress) params.set("address", userAddress);
  if (userEmailHash) params.set("emailHash", userEmailHash);
  const siteId = currentSiteId();
  if (siteId) params.set("siteId", siteId);
  const query = params.toString() ? `?${params}` : "";
  const resp = await get<SeriesClaimStatus>(
    `/api/events/${eventId}/series/${seriesId}/claim-status${query}`,
    apiUrl,
  );
  return resp.data ?? null;
}

// ---------------------------------------------------------------------------
// Collection (Passport)
// ---------------------------------------------------------------------------

export async function getMyCollection(): Promise<UserCollection> {
  const resp = await authGet<UserCollection>("/api/collection/me");
  if (!resp.ok) throw new Error(resp.error || "Failed to load collection");
  return resp.data ?? { v: 1, entries: [], updatedAt: "" };
}

export async function getTicketDetail(ref: string): Promise<ClaimedTicket | null> {
  const resp = await authGet<ClaimedTicket>(`/api/collection/me/ticket/${ref}`);
  return resp.data ?? null;
}

// ---------------------------------------------------------------------------
// Organizer Dashboard
// ---------------------------------------------------------------------------

export interface EventOrdersResponse {
  eventId: string;
  eventTitle: string;
  orders: OrderEntry[];
}

export async function getEventOrders(eventId: string): Promise<EventOrdersResponse> {
  const resp = await authGet<EventOrdersResponse>(`/api/events/${eventId}/orders`);
  if (!resp.data) throw new Error(resp.error || "Failed to load orders");
  return resp.data;
}

export interface WebhookRelayResponse {
  status: number;
  body: string;
}

export async function webhookRelay(
  eventId: string,
  webhookUrl: string,
  webhookHeaders: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<WebhookRelayResponse> {
  const resp = await authPost<WebhookRelayResponse>(
    `/api/events/${eventId}/webhook-relay`,
    { webhookUrl, webhookHeaders, payload },
  );
  if (!resp.data) throw new Error(resp.error || "Webhook relay failed");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Email broadcast
// ---------------------------------------------------------------------------

export interface BroadcastResponse {
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
  errors?: string[];
}

export async function sendBroadcast(
  eventId: string,
  subject: string,
  htmlBody: string,
  recipients: Array<{ email: string; name?: string }>,
): Promise<BroadcastResponse> {
  const resp = await authPost<BroadcastResponse>(
    `/api/events/${eventId}/broadcast`,
    { subject, htmlBody, recipients },
  );
  if (!resp.data) throw new Error(resp.error || "Broadcast failed");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Organizer approval flow
// ---------------------------------------------------------------------------

export interface PendingClaimEntry {
  pendingId: string;
  seriesId: string;
  seriesName: string;
  claimerKey: string;
  requestedAt: string;
  encryptedOrder?: SealedBox;
}

export async function getPendingClaims(eventId: string): Promise<PendingClaimEntry[]> {
  const resp = await authGet<{ eventId: string; pendingClaims: PendingClaimEntry[] }>(
    `/api/events/${eventId}/pending-claims`,
  );
  return resp.data?.pendingClaims ?? [];
}

export async function approvePendingClaim(
  eventId: string,
  seriesId: string,
  pendingId: string,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(
    `/api/events/${eventId}/series/${seriesId}/pending-claims/${pendingId}/approve`,
    {},
  );
}

export async function rejectPendingClaim(
  eventId: string,
  seriesId: string,
  pendingId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(
    `/api/events/${eventId}/series/${seriesId}/pending-claims/${pendingId}/reject`,
    { reason },
  );
}
