import { newOwnedSiteId, siteIdOwnedBy, type SiteDirectoryEntry } from "@woco/shared";

/**
 * Has this site been put live? `record` is its My Sites card, `storedHere` whether
 * this device holds a copy that came from a deploy or from the server.
 *
 * Being on the My Sites list is not enough: going back to the list adds the
 * draft in hand as a card, with none of these set. Counting that as live kept
 * the draft's placeholder id, which the server then refused for good.
 */
export function siteIsLive(
  record: Pick<SiteDirectoryEntry, "publishedAt" | "deployedUrl" | "feedHash"> | undefined,
  storedHere: boolean,
): boolean {
  return storedHere || !!(record && (record.publishedAt || record.deployedUrl || record.feedHash));
}

/**
 * The id a site is saved under.
 *
 * A site id is derived from its owner's account (`@woco/shared` site/site-id.ts),
 * and the server refuses a save under an id the account does not own. A draft is
 * started before anyone has signed in, so it carries a placeholder until its
 * first save: this is where it gets the real one.
 *
 * `published` keeps a site that is already live under the id it has. That covers
 * the sites made before ids proved their owner; whether one of those may still
 * be saved is the server's answer, not something to re-key around, because a
 * new id would be a new site and leave the live one behind.
 */
export function siteIdForSave(siteId: string, account: string, published: boolean): string {
  if (published || siteIdOwnedBy(siteId, account)) return siteId;
  return newOwnedSiteId(account);
}
