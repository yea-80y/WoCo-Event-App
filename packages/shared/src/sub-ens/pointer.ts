/**
 * What the server tells the client about a name's pointer (registrar v2.2).
 * The platform never writes a pointer: it says whether one is needed and at
 * what, and the HOLDER signs it (`POST /api/sub-ens/set-contenthash`).
 */

/** Who authors a site's feed. A client-owned feed answers only to the
 *  holder's own key; a platform-signed one is written by WoCo (a login with
 *  no feed signer). */
export type SiteFeedOwner = "client" | "platform";

/** The site deploy's answer about the site's name. */
export type SiteDeploySubEns =
  | { label: string; status: "ok"; target: string; feedOwner: SiteFeedOwner }
  | { label: string; status: "awaiting_signature"; target: string; feedOwner: SiteFeedOwner }
  | {
      label: string;
      status: "skipped";
      reason: "not_owner" | "profile_name" | "unverified" | "no_feed_manifest";
    };

/** The profile bind's answer when the name should point at the app and does not. */
export interface PointerRequest {
  status: "awaiting_signature";
  /** 64-hex Swarm reference, no 0x. */
  target: string;
}
