/**
 * An organiser site's theme and contact address, for mail about one event (#983) -
 * only when the site belongs to that event's organiser. The siteId on a sale is the
 * pointer the BUYER's checkout carried: taken on trust, it would let anyone aim the
 * ticket email's Reply-To, the organiser's notice, or a resend at another organiser's
 * site. Used by all three.
 */

import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { getSiteTheme } from "../site/service.js";

export async function organiserSiteTheme(
  siteId: string,
  eventId: string,
  read: {
    creator: (eventId: string) => string | undefined;
    theme: typeof getSiteTheme;
  } = { creator: (id) => getRecordedFeedSigner(id)?.creatorAddress, theme: getSiteTheme },
) {
  const creator = read.creator(eventId)?.toLowerCase();
  if (!creator) return null;
  const theme = await read.theme(siteId);
  return theme && theme.ownerAddress === creator ? theme : null;
}
