/**
 * The codes a person can show from the share sheet, and where each one goes.
 * Pure: `share-inputs.ts` reads the profile, the feeds and the chain; this
 * decides.
 *
 *   Invite to host   the referral link, carrying the PROFILE name or the address
 *   Follow me        the profile: the name's own web address once the chain shows
 *                    it loads, the app's profile link otherwise
 *   one per page     an event or site the account's own names point at
 *
 * A name is used only when it is the verified profile name or the chain says
 * this account holds it, and used as a web address only when the chain shows it
 * has a contenthash (a name without one fails its certificate on first visit).
 */

import { subEnsName, subEnsWebUrl } from "@woco/shared";
import { canonicalUrl } from "../sub-ens/host-label.js";

/**
 * The shareable referral link for an account, always on the canonical app host.
 *
 * Owner rule (2026-09-15): a gateway URL is never user-facing — WoCo names exist
 * so nothing has to be shown at one. This reverses #34's choice to keep
 * whatever origin the sharer was browsing, which from the gateway put a
 * `/bzz/{manifest}/` path in every invite and made the invite code denser.
 * #34's objection to a fixed host (old builds keep emitting it) is already
 * accepted for sign-in, which sends people to the same `CANONICAL_APP_ORIGIN`.
 *
 * In local dev the link therefore points at production; open `#/ref/…` on the
 * dev host to exercise the invite page there.
 *
 * `referrer` is an address or a WoCo sub-ENS label — the router accepts both,
 * so a sharer with a name gets `#/ref/theirvenue` instead of forty hex
 * characters, and the visitor who follows it is told a name rather than hex.
 */
export function referralLink(referrer: string): string {
  return canonicalUrl(`#/ref/${referrer}`);
}

export type ShareKind = "invite" | "follow" | "page";

export interface ShareCode {
  /** "invite", "follow", or the page's name. */
  id: string;
  kind: ShareKind;
  /** How the sheet names the choice. */
  title: string;
  link: string;
  /** The WoCo name the link carries, or null for an address link, which is never printed. */
  name: string | null;
}

/** A name the chain says this account holds, and whether it has a contenthash. */
export interface HeldName {
  /** Lower case, as `readNameRecords` returns it. */
  label: string;
  points: boolean;
}

export function shareCodes(input: {
  address: string;
  /** The verified profile name (`sub-ens/profile-name.ts`), or null. */
  profileName: string | null;
  held: readonly HeldName[];
  /** Names the account's own event and site feeds carry, with the page's title. */
  pages?: readonly { label: string; title: string }[];
}): ShareCode[] {
  const address = input.address.toLowerCase();
  const profile = input.profileName?.toLowerCase() ?? null;
  const loads = new Map(input.held.map((n) => [n.label, n.points]));
  const profileLoads = profile !== null && loads.get(profile) === true;

  const codes: ShareCode[] = [
    {
      id: "invite",
      kind: "invite",
      title: "Invite to host",
      link: referralLink(profile ?? address),
      name: profile,
    },
    {
      id: "follow",
      kind: "follow",
      title: "Follow me",
      link: profileLoads ? subEnsWebUrl(profile) : canonicalUrl(`#/profile/${address}`),
      name: profileLoads ? profile : null,
    },
  ];

  // The profile name is the person, so it is never offered again as a page.
  const offered = new Set(profile ? [profile] : []);
  for (const page of input.pages ?? []) {
    const label = page.label.toLowerCase();
    if (offered.has(label) || loads.get(label) !== true) continue;
    offered.add(label);
    codes.push({
      id: label,
      kind: "page",
      title: page.title || subEnsName(label),
      link: subEnsWebUrl(label),
      name: label,
    });
  }
  return codes;
}
