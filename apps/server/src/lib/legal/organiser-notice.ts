/**
 * Reading an organiser's privacy notice for the public pages (#legal, organiser notice).
 *
 * The notice is the organiser's own client-signed feed
 * (`woco/legal/privacy-notice/{account}`, owned by their content-feed signer). The
 * server holds none of it; what it adds is WHO to read it for and UNDER WHICH
 * SIGNER, taken from server-held sources only:
 *   - an event: `eventKeys` - the creator pinned at create (#670) and, once their
 *     account has a key ring, the ring's signer (#186). Never the event feed's own
 *     description of itself: an organiser signs that, and could name another
 *     organiser's account and signer to borrow their notice at their own checkout.
 *   - a site: `resolveSiteConfig` - the server-written pointer's owner and the
 *     ring-aware signer it already resolves.
 * A legacy event (no record) or a legacy platform-written site has no trusted
 * carrier, so it gets no stored notice - the page shows the pre-filled one. A
 * removed passkey can still sign under its old signer, which is exactly why the
 * ring's signer, never a recorded one, is read once a ring exists.
 */

import { organiserNoticeContentTopic, validateOrganiserNotice, type OrganiserNoticeV1 } from "@woco/shared";
import type { VersionedFeedRead } from "@woco/shared";

export type NoticeRead =
  | { status: "found"; notice: OrganiserNoticeV1 }
  /** No notice, or one that fails validation: the page shows the pre-filled notice. */
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type NoticeFeedReader = (ownerHex: string, topic: string) => Promise<VersionedFeedRead>;

export async function readOrganiserNotice(
  creator: string,
  signer: string,
  readFeed: NoticeFeedReader,
): Promise<NoticeRead> {
  let res: VersionedFeedRead;
  try {
    res = await readFeed(signer.toLowerCase().replace(/^0x/, ""), organiserNoticeContentTopic(creator));
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === "absent") return { status: "absent" };
  if (res.status === "unavailable") return { status: "unavailable", reason: res.reason ?? "unavailable" };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(res.bytes).replace(/\0+$/, ""));
  } catch {
    return { status: "absent" };
  }
  const notice = validateOrganiserNotice(raw, creator);
  return notice ? { status: "found", notice } : { status: "absent" };
}

/** The account and signer an event's notice is read under, or null where nothing trusted names them. */
export type NoticeCarrier = { creator: string; signer: string } | null | "unavailable";

export function carrierFromEventKeys(
  keys: { kind: "ring" | "record" | "unavailable"; creator: string; feedSigner: string } | { kind: "legacy" },
): NoticeCarrier {
  if (keys.kind === "legacy") return null;
  if (keys.kind === "unavailable") return "unavailable";
  return { creator: keys.creator.toLowerCase(), signer: keys.feedSigner.toLowerCase() };
}

/**
 * The business details a privacy notice may be pre-filled from: the name buyers
 * see, the support email and the support address. Every one is optional and the
 * organiser edits them before anything is published.
 */
export function businessProfileForNotice(account: {
  business_profile?: { name?: string | null; support_email?: string | null; support_address?: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null; country?: string | null } | null } | null;
  company?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
}): { name?: string; supportEmail?: string; supportAddress?: string } {
  const bp = account.business_profile ?? undefined;
  const name = bp?.name || account.company?.name || account.settings?.dashboard?.display_name || undefined;
  const a = bp?.support_address ?? undefined;
  const supportAddress = a
    ? [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter((x): x is string => !!x).join(", ")
    : "";
  return {
    ...(name ? { name } : {}),
    ...(bp?.support_email ? { supportEmail: bp.support_email } : {}),
    ...(supportAddress ? { supportAddress } : {}),
  };
}
