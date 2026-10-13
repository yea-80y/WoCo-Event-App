/**
 * The organiser's privacy notice in the browser: reading it for a public page,
 * and the organiser's own read + publish.
 *
 * PUBLIC READS go through the server (`/api/privacy-notice/*`), deliberately not
 * gateway-direct like a profile: the server is what knows, from its own records
 * and the onchain key ring (#670, #186), WHICH account an event or site belongs to
 * and which signer currently speaks for it. A page that read the notice under the
 * event feed's own `creatorFeedSigner` would let an organiser name another
 * organiser's account and show their notice at checkout. The server returns the
 * signed notice; the wording is generated here from the shared generator.
 *
 * THE ORGANISER'S OWN read and write are their own feed under their own signer,
 * through the `privacyNotice` family - never another family's route (#651).
 */

import {
  buildOrganiserNotice,
  organiserNoticeContentTopic,
  validateOrganiserNotice,
  type OrderField,
  type OrganiserNoticeDoc,
  type OrganiserNoticeV1,
} from "@woco/shared";
import { get } from "../api/http.js";
import { FEED_ROUTES } from "../swarm/gateways.js";
import { canonicalUrl } from "../sub-ens/host-label.js";

/** WoCo's own Privacy Policy, always on the canonical host (#605). */
export const WOCO_POLICY_URL = canonicalUrl("#/legal/privacy");

/** The hosted notice page for an event - opened in a new tab from every checkout, the embed included. */
export function organiserNoticeUrl(eventId: string): string {
  return canonicalUrl(`#/privacy-notice/${encodeURIComponent(eventId)}`);
}

export interface PublicNoticeData {
  creator: string | null;
  feedSigner: string | null;
  /** The server named the organiser from a record it holds, not from the feed. */
  trusted: boolean;
  notice: OrganiserNoticeV1 | null;
  noticeStatus: "found" | "absent" | "unavailable";
  event?: { title: string; orderFields: OrderField[] } | null;
  site?: { brandName: string | null; contactEmail: string | null; postalAddress: string | null; contactForm: boolean };
}

/**
 * The server's answer, re-validated here: the server is a transport for the
 * organiser's signed words, so a notice that does not validate for the creator it
 * names is dropped, never shown.
 */
export function acceptNoticeData(raw: PublicNoticeData | null | undefined): PublicNoticeData | null {
  if (!raw) return null;
  const notice = raw.notice && raw.creator && raw.trusted ? validateOrganiserNotice(raw.notice, raw.creator) : null;
  return { ...raw, notice };
}

export async function fetchEventNotice(eventId: string, apiUrl?: string): Promise<PublicNoticeData | null> {
  const resp = await get<PublicNoticeData>(`/api/privacy-notice/event/${encodeURIComponent(eventId)}`, apiUrl);
  return resp.ok ? acceptNoticeData(resp.data) : null;
}

export async function fetchSiteNotice(siteId: string, apiUrl?: string): Promise<PublicNoticeData | null> {
  const resp = await get<PublicNoticeData>(`/api/privacy-notice/site/${encodeURIComponent(siteId)}`, apiUrl);
  return resp.ok ? acceptNoticeData(resp.data) : null;
}

/**
 * What a public page shows. Only a notice the organiser CONFIRMED is ever shown as
 * theirs (owner decision 2026-10-11): the pre-filled draft is the editor's, never
 * the public's. Until they confirm, the page says so - and the server refuses
 * every sale for their events, so nobody is asked for details under a notice the
 * organiser has not seen (apps/server/src/lib/legal/notice-gate.ts).
 */
export type PublicNoticeView =
  | { kind: "loading" }
  | { kind: "notice"; doc: OrganiserNoticeDoc }
  /** The server could not be reached, or could not read the stored notice. */
  | { kind: "unavailable" }
  /**
   * No confirmed notice. `legacy`: an event with no record of who made it - no
   * notice can be shown for it, and it cannot sell until it is published again.
   */
  | { kind: "not-confirmed"; name: string | null; legacy: boolean; site: boolean };

export function publicNoticeView(
  /** `undefined` while the read is in flight; `null` when it failed. */
  data: PublicNoticeData | null | undefined,
  pageKnows: { name?: string; contactForm?: boolean } = {},
): PublicNoticeView {
  if (data === undefined) return { kind: "loading" };
  if (data === null || data.noticeStatus === "unavailable") return { kind: "unavailable" };
  if (data.notice) {
    return {
      kind: "notice",
      doc: buildOrganiserNotice({
        notice: data.notice,
        event: data.event ?? undefined,
        contactForm: pageKnows.contactForm ?? data.site?.contactForm ?? false,
        wocoPolicyUrl: WOCO_POLICY_URL,
      }),
    };
  }
  const name = (pageKnows.name ?? data.site?.brandName ?? "").trim() || null;
  // `legacy` is an EVENT with no record of who made it. A site's own events sell
  // under their own organisers' keys, so a site page never claims what is on sale.
  return { kind: "not-confirmed", name, legacy: !data.trusted && !data.site, site: !!data.site };
}

// ---------------------------------------------------------------------------
// The organiser's own notice
// ---------------------------------------------------------------------------

export type OwnNoticeRead =
  | { status: "found"; notice: OrganiserNoticeV1 }
  | { status: "absent" }
  | { status: "unavailable"; error: string };

/**
 * The organiser's own stored notice. THOROUGH: the editor fills its form from it,
 * and a false "absent" would offer a blank form over a notice that exists.
 */
export async function readOwnNotice(account: string, signerAddress: string): Promise<OwnNoticeRead> {
  const { readContentFeedResult } = await import("../swarm/content-feed.js");
  try {
    const res = await readContentFeedResult<unknown>(signerAddress, organiserNoticeContentTopic(account), {
      thorough: true,
      skipLegacy: true,
      route: FEED_ROUTES.privacyNotice,
    });
    if (res.status === "absent") return { status: "absent" };
    if (res.status !== "found") return { status: "unavailable", error: "Couldn't load your saved notice - check your connection and try again." };
    const notice = validateOrganiserNotice(res.value, account);
    return notice ? { status: "found", notice } : { status: "absent" };
  } catch (e) {
    return { status: "unavailable", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Publish the confirmed notice to the organiser's own feed. Refuses anything the readers would refuse. */
export async function publishOwnNotice(
  account: string,
  signer: { address: string; privKey: string },
  draft: Omit<OrganiserNoticeV1, "format" | "address" | "confirmedAt">,
): Promise<OrganiserNoticeV1> {
  const candidate = {
    ...draft,
    format: "woco.privacy-notice.v1",
    address: account.toLowerCase(),
    confirmedAt: new Date().toISOString(),
  };
  const notice = validateOrganiserNotice(stripEmpty(candidate), account);
  if (!notice) throw new Error("Some details aren't valid yet - check the highlighted fields.");
  const [{ writeContentFeed }, { logFeedToManifest }] = await Promise.all([
    import("../swarm/content-feed.js"),
    import("../manifest/feed-log.js"),
  ]);
  const topic = organiserNoticeContentTopic(account);
  await writeContentFeed({ signerPrivKey: signer.privKey, topic, data: notice, route: FEED_ROUTES.privacyNotice });
  // The batch-migration keep-list: without it the notice dies with the batch.
  void logFeedToManifest({ kind: "privacy-notice", topic, target: "etherna" });
  return notice;
}

/** Drop empty strings and false flags, so an emptied field is absent rather than "". */
export function stripEmpty<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out as T;
}
