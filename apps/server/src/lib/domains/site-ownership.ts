/**
 * Ownership gate for binding a custom domain to a siteId (#216).
 *
 * `POST /api/domains` verified the caller for the eventId branch and not at all
 * for the siteId branch, which took the id straight from the request body. Any
 * authenticated caller could therefore point a hostname THEY control at somebody
 * else's site, and `/resolve/:hostname` would then serve that organiser's content
 * hash under it — refreshed by the victim's every future deploy.
 *
 * The authority is `resolveSiteConfig`, the same one the publish and deploy gates
 * already stake takeover-prevention on. Its `found` ownership comes from the
 * server-stamped pointer rather than the client-signed payload, which is what
 * makes it trustworthy here. The creator's site directory is NOT an alternative:
 * its upsert is fire-and-forget and documented non-fatal, so it can lack a site
 * the caller genuinely owns and produce a false refusal.
 *
 * Extracted from the route so the decision is unit-testable with injected readers
 * — a live Swarm read cannot be made to fail on demand, and the failure paths are
 * the entire point.
 */

import { resolveSiteConfig, type SiteConfigReaders } from "../site/service.js";

export type SiteBindDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 503; error: string };

/**
 * Decide whether `parentAddress` may bind a domain to `siteId`.
 *
 * Three answers, and only one permits the bind (#181). `absent` means the siteId
 * was never published; `unavailable` means we could not find out — and treating
 * the second as the first is what let a caller retry until a read failed and be
 * handed somebody else's site.
 */
export async function decideSiteBind(
  siteId: string,
  parentAddress: string,
  readers?: SiteConfigReaders,
): Promise<SiteBindDecision> {
  const existing = await resolveSiteConfig(siteId, readers);

  if (existing.status === "unavailable") {
    console.warn(`[domains] site ownership undecidable for ${siteId}: ${existing.reason}`);
    return {
      ok: false,
      status: 503,
      error: "Could not verify site ownership right now — please try again",
    };
  }

  // Binding a hostname to a site that does not exist is not a legitimate
  // operation. The deploy route answers this state the same way, and the route
  // already requires a contentHash, which only exists after a deploy, which
  // requires a publish — so the only way to arrive here honestly is the brief
  // read-after-write window on a just-published site, which is retryable.
  if (existing.status === "absent") {
    return { ok: false, status: 404, error: "Site not found — publish your site first" };
  }

  // `parentAddress` arrives EIP-55 checksummed from `getAddress()`, and a stored
  // ownerAddress may be either form depending on when it was written. Lowercase
  // BOTH sides: comparing a checksummed caller against a lowercased owner refuses
  // every legitimate request — fail-closed, but broken.
  if (existing.site.ownerAddress.toLowerCase() !== parentAddress.toLowerCase()) {
    return { ok: false, status: 403, error: "Not the site owner" };
  }

  return { ok: true };
}
