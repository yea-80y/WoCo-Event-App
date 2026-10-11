import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { Site } from "@woco/shared";
import { readContentFeedJsonResult } from "../lib/swarm/soc-upload.js";
import { eventKeys } from "../lib/keyring/event-keys.js";
import { getEvent } from "../lib/event/service.js";
import { resolveSiteConfig } from "../lib/site/service.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { isSafeIdParam } from "../lib/site/deploy-config.js";
import { carrierFromEventKeys, readOrganiserNotice, type NoticeRead } from "../lib/legal/organiser-notice.js";

/**
 * Public reads of an organiser's privacy notice - see lib/legal/organiser-notice.ts
 * for why the server, not the page, decides whose notice and under which signer.
 *
 * Unauthenticated: the notice is public by design (it is shown at checkout). The
 * answer carries the organiser's stored notice when there is one, plus what the
 * page needs to pre-fill one when there is not; the WORDING is generated in the
 * browser from the shared generator, so this route never composes legal text.
 */
export const privacyNotice = new Hono<AppEnv>();

// Each miss is a version scan (a network search), so per IP, sized for a page
// load or two a second from one venue NAT.
const READS = new SlidingWindowLimiter([{ limit: 120, windowMs: 60_000 }]);

const readFeed = (ownerHex: string, topic: string) =>
  readContentFeedJsonResult(ownerHex, topic, "privacyNotice", { skipLegacy: true });

function noticeBody(read: NoticeRead) {
  return read.status === "found"
    ? { notice: read.notice, noticeStatus: "found" as const }
    : { notice: null, noticeStatus: read.status };
}

/** Does the site collect messages anywhere? Drives the contact-form lines of its notice. */
function hasContactForm(site: Site): boolean {
  return (site.pages ?? []).some((p) => (p.sections ?? []).some((s) => s.type === "contactForm"));
}

// GET /api/privacy-notice/event/:eventId
privacyNotice.get("/event/:eventId", async (c) => {
  if (!READS.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const eventId = c.req.param("eventId");
  if (!isSafeIdParam(eventId)) return c.json({ ok: false, error: "Invalid event id" }, 400);

  const [keys, feed] = await Promise.all([eventKeys(eventId), getEvent(eventId).catch(() => null)]);
  const carrier = carrierFromEventKeys(keys);
  const read: NoticeRead =
    carrier === "unavailable"
      ? { status: "unavailable", reason: "organiser keys unreadable" }
      : carrier
        ? await readOrganiserNotice(carrier.creator, carrier.signer, readFeed)
        : { status: "absent" };

  return c.json({
    ok: true,
    data: {
      // The trusted creator when there is one; a legacy event's own field otherwise,
      // used only to pre-fill a name - never to choose a stored notice.
      creator: carrier && carrier !== "unavailable" ? carrier.creator : (feed?.creatorAddress?.toLowerCase() ?? null),
      feedSigner: carrier && carrier !== "unavailable" ? carrier.signer : null,
      trusted: !!carrier && carrier !== "unavailable",
      ...noticeBody(read),
      event: feed && !feed.deleted ? { title: feed.title, orderFields: feed.orderFields ?? [] } : null,
    },
  });
});

// GET /api/privacy-notice/site/:siteId
privacyNotice.get("/site/:siteId", async (c) => {
  if (!READS.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const siteId = c.req.param("siteId");
  if (!isSafeIdParam(siteId)) return c.json({ ok: false, error: "Invalid site id" }, 400);

  const resolved = await resolveSiteConfig(siteId);
  if (resolved.status === "absent") return c.json({ ok: false, error: "Site not found" }, 404);
  if (resolved.status === "unavailable") return c.json({ ok: false, error: "Site unavailable" }, 503);
  const { site } = resolved;
  const creator = site.ownerAddress.toLowerCase();
  const signer = resolved.siteFeedSigner;
  const read: NoticeRead = signer ? await readOrganiserNotice(creator, signer, readFeed) : { status: "absent" };

  return c.json({
    ok: true,
    data: {
      creator,
      feedSigner: signer?.toLowerCase() ?? null,
      trusted: !!signer,
      ...noticeBody(read),
      site: {
        brandName: site.theme?.brandName ?? null,
        contactEmail: site.contact?.email ?? null,
        postalAddress: site.contact?.address ?? null,
        contactForm: hasContactForm(site),
      },
    },
  });
});
