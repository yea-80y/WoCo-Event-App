/**
 * Who may write to a site, decided from the site id alone.
 *
 * Ownership used to be whatever the server-written pointer at
 * `woco/site/config/{siteId}` said, and a pointer that read as ABSENT let the
 * caller through and stamped them owner. A lapsed batch or a lost chunk makes
 * every pointer read that way, so the record that guarded a site was the one
 * thing that could hand it over.
 *
 * A v2 id (`@woco/shared` site/site-id.ts) is derived from its owner's account,
 * so this check is arithmetic on the id and the VERIFIED session parent: no
 * read, nothing to lose, nothing this server could rewrite. Every site write
 * runs it BEFORE any Swarm read, and the read that follows no longer decides
 * who the owner is.
 *
 * Ids made before v2 are random and prove nothing. The three below are the test
 * sites kept across the change, each under the account that deployed it (read
 * from the deploy record and from the deployed pages, 2026-11-19). Any other
 * old id is refused: nothing can show whose it was. The list is closed; it
 * goes when those sites do.
 */

import { isOwnedSiteIdShape, siteIdOwnedBy } from "@woco/shared";

export const EARLIER_SITE_OWNERS: ReadonlyMap<string, string> = new Map([
  ["mvk4388p-rm7dnip", "0x2b6e834afbf4cfaa8990e3205de02e07ee95fe5d"],
  ["mw59p9pl-xy51zc9", "0x2b6e834afbf4cfaa8990e3205de02e07ee95fe5d"],
  ["mw59l4fc-esurd0y", "0x2b6e834afbf4cfaa8990e3205de02e07ee95fe5d"],
]);

export const SITE_ID_RETIRED_CODE = "SITE_ID_RETIRED";

export interface SiteOwnerRefusal {
  status: 403 | 409;
  error: string;
  code?: string;
}

/**
 * Null when `parentAddress` (the verified session parent) owns `siteId` by the
 * id itself, or by the closed list of earlier sites. Otherwise the refusal.
 */
export function siteOwnerRefusal(
  siteId: string,
  parentAddress: string,
  earlier: ReadonlyMap<string, string> = EARLIER_SITE_OWNERS,
): SiteOwnerRefusal | null {
  const caller = parentAddress.toLowerCase();
  if (isOwnedSiteIdShape(siteId)) {
    return siteIdOwnedBy(siteId, caller) ? null : { status: 403, error: "Not the site owner" };
  }
  const pinned = earlier.get(siteId);
  if (pinned !== undefined) {
    return pinned === caller ? null : { status: 403, error: "Not the site owner" };
  }
  return {
    status: 409,
    code: SITE_ID_RETIRED_CODE,
    // An app loaded before the change still makes old ids: a refresh fixes a new
    // draft by itself. A site published under an old id has to be started again.
    error: "This site was made with an earlier version of WoCo. Refresh the app and try again. If you see this again, start the site afresh to publish it.",
  };
}
