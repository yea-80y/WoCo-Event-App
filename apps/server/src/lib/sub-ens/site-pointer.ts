/**
 * Does a site's sub-ENS name point at the site? Asked by the deploy route,
 * answered without writing anything (registry v2.2, Fable sponsor-key consult
 * §2.2).
 *
 * A name is bound to a site's FEED MANIFEST, not to one publish: the manifest
 * is stable per (feed owner, topic), and each publish advances the feed behind
 * it, so the name follows every redeploy with no chain write and no prompt.
 * The holder signs the pointer once, at bind; this check reports whether that
 * still holds, and if not, the one thing to sign.
 *
 * `feedOwner` travels with the answer because it decides what the signature
 * hands over. A client-owned feed answers only to the holder's own key; a
 * platform-signed one (a login with no feed signer, e.g. Coinbase Smart Wallet
 * until its escrow path lands) is authored by the platform, and the client
 * must say so before asking for a signature (consult §11.1).
 */

import { getLabelOwner, getLabelContenthash, decodeSwarmContenthash } from "../chain/sub-ens-contract.js";
import { isProfileName } from "../profile/name-ledger.js";
import type { SiteDeploySubEns, SiteFeedOwner } from "@woco/shared";

export type { SiteDeploySubEns, SiteFeedOwner };

export interface SitePointerDeps {
  readOwner: (label: string) => Promise<string | null>;
  readContenthash: (label: string) => Promise<string | null>;
  isProfileName: (account: string, label: string) => boolean;
}

export async function checkSiteSubEns(
  label: string,
  parentAddress: string,
  feedManifestHash: string,
  feedOwner: SiteFeedOwner,
  deps: Partial<SitePointerDeps> = {},
): Promise<SiteDeploySubEns> {
  const {
    readOwner = getLabelOwner,
    readContenthash = getLabelContenthash,
    isProfileName: isProfile = isProfileName,
  } = deps;

  // A chain read that did not answer is not evidence the organiser lost the
  // name: "not_owner" would accuse them of something never established.
  let owner: string | null;
  try {
    owner = await readOwner(label);
  } catch {
    return { label, status: "skipped", reason: "unverified" };
  }
  if (owner !== parentAddress.toLowerCase()) return { label, status: "skipped", reason: "not_owner" };

  // The identity name points at the app, never at a site.
  if (isProfile(parentAddress, label)) return { label, status: "skipped", reason: "profile_name" };

  // No manifest this deploy (bee did not answer): there is nothing stable to
  // offer, and the immutable hash would need a signature per publish.
  if (!feedManifestHash) return { label, status: "skipped", reason: "no_feed_manifest" };
  const target = feedManifestHash.toLowerCase();

  // Unreadable is not "points elsewhere": asking for a signature on a read
  // fault would prompt a holder to re-sign what may already be right.
  let raw: string | null;
  try {
    raw = await readContenthash(label);
  } catch {
    return { label, status: "skipped", reason: "unverified" };
  }
  if (raw && decodeSwarmContenthash(raw) === target) return { label, status: "ok", target, feedOwner };
  return { label, status: "awaiting_signature", target, feedOwner };
}
