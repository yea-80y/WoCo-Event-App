import { Topic } from "@ethersphere/bee-js";
import { siteCreatorDirectoryTopic, siteConfigTopic, sitePagesTopicFn, siteEventsIndexTopic, isSitePointer } from "@woco/shared";
import type { SiteDirectoryEntry, SiteDirectory, Site, SitePalette, SiteEventsIndex, Page, Hex0x, VersionedFeedRead } from "@woco/shared";
import { readFeedPage, readFeedPageStrict, writeFeedPage, encodeJsonFeed, decodeJsonFeed, type FeedReadStrictResult } from "../swarm/feeds.js";
import { readContentFeedJsonResult } from "../swarm/soc-upload.js";

const DIR_PAGE_LIMIT = 4096;

// ── Read ─────────────────────────────────────────────────────────────────────

/** A resolved site config plus its ownership provenance. */
export interface ResolvedSite {
  site: Site;
  /** Set when the config is a CLIENT-OWNED SOC (the signer that owns it). */
  siteFeedSigner?: Hex0x;
}

/**
 * Resolve a site's config, following the client-owned indirection when present.
 * The platform config feed holds either the legacy full `Site` (pages merged from
 * the split pages feed) or a `SitePointer`, in which case the full Site (pages
 * included) is read from the owner's SOC at `siteConfigTopic(siteId)`. In the
 * pointer case `site.ownerAddress` is OVERRIDDEN by the pointer's server-stamped
 * value — ownership gates must never trust the client-signed payload's claim.
 *
 * THREE ANSWERS, NOT TWO — and the third is the point (#181).
 *
 *   found        the site's config, with its ownership provenance.
 *   absent       the feed provably holds no site. A caller MAY treat the siteId
 *                as unclaimed.
 *   unavailable  neither could be established: a network fault, bytes that will
 *                not decode, a payload naming a different site. Nothing may be
 *                concluded, and an authorisation gate must refuse.
 *
 * The ownership gates use this to answer "does someone already own this siteId?"
 * and it used to answer with `null`, which they read as "no". So one failed Swarm
 * read — a slow bee, a gateway timeout, a chunk needing re-fetch — let any
 * authenticated caller be stamped owner of an existing site, take over its
 * `woco-multisite-{siteId}` feed and re-point the custom domains that resolve
 * through it. Nothing to race and nothing to guess: retry until a read fails.
 *
 * The separation lives here rather than at the call sites because a caller cannot
 * recover a distinction the reader has already discarded — the same conclusion as
 * #154, #155, #170 and #171.
 */
export type SiteConfigRead =
  | { status: "found"; site: Site; siteFeedSigner?: Hex0x }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

/**
 * Injectable readers, defaulting to the real ones — the same shape
 * `claims-feed.ts` and `pending-claims-feed.ts` use, and for the same reason: the
 * branches worth testing here are the FAILURE ones, and a test cannot make a live
 * Swarm read fail on demand.
 */
export interface SiteConfigReaders {
  readConfigPage: (topic: Topic) => Promise<FeedReadStrictResult>;
  readPointerTarget: (ownerHex: string, baseTopic: string) => Promise<VersionedFeedRead>;
  readPagesPage: (topic: Topic) => Promise<Uint8Array | null>;
}

const DEFAULT_READERS: SiteConfigReaders = {
  readConfigPage: readFeedPageStrict,
  readPointerTarget: readContentFeedJsonResult,
  readPagesPage: readFeedPage,
};

export async function resolveSiteConfig(
  siteId: string,
  readers: SiteConfigReaders = DEFAULT_READERS,
): Promise<SiteConfigRead> {
  const configTopic = Topic.fromString(siteConfigTopic(siteId));
  // A rejecting reader would otherwise be a FOURTH outcome — the function would
  // throw instead of returning one of the three, and the tri-state would not be
  // total. The real default resolves rather than throws, but a caller may inject
  // anything and a future reader may change; catching keeps the contract true by
  // construction rather than by assumption.
  const configPage = await readers
    .readConfigPage(configTopic)
    .catch((e: unknown) => ({ status: "error" as const, error: e instanceof Error ? e : new Error(String(e)) }));
  if (configPage.status === "error") {
    return { status: "unavailable", reason: `config feed read failed: ${configPage.error.message}` };
  }
  if (configPage.status === "absent") return { status: "absent" };

  const head = decodeJsonFeed<unknown>(configPage.data);
  // Bytes exist and do not decode. Corrupt or foreign, never evidence that the
  // site was never published — reading it as absent is how the name gets given
  // away.
  if (!head) return { status: "unavailable", reason: "config feed payload did not decode" };

  if (isSitePointer(head)) {
    const payload = await readers
      .readPointerTarget(head.siteFeedSigner.replace(/^0x/, ""), siteConfigTopic(siteId))
      .catch((e: unknown) => ({ status: "unavailable" as const, reason: String(e) }));

    if (payload.status === "unavailable") {
      return { status: "unavailable", reason: `pointer target unreadable: ${payload.reason ?? "unknown"}` };
    }
    // A pointer exists, so a site WAS published. Its target being absent is an
    // inconsistency to refuse on, not a vacancy to hand out.
    if (payload.status === "absent") {
      return { status: "unavailable", reason: "pointer target absent — site feed is inconsistent" };
    }

    let site: Site;
    try {
      site = JSON.parse(new TextDecoder().decode(payload.bytes)) as Site;
    } catch {
      return { status: "unavailable", reason: "pointer target did not parse as JSON" };
    }
    if (!site?.siteId || site.siteId !== siteId) {
      return { status: "unavailable", reason: "pointer target names a different siteId" };
    }
    site.ownerAddress = head.ownerAddress;
    return { status: "found", site, siteFeedSigner: head.siteFeedSigner };
  }

  // Legacy platform-written site. The payload decoded and is not a pointer, but
  // that alone does not make it this site: any decodable JSON reaches here — a
  // future pointer version that `isSitePointer` does not recognise, an unrelated
  // document, a config naming a different siteId. The pointer branch already
  // refuses those; this branch used to cast and return them as `found`, which
  // contradicted this function's own contract and handed a malformed Site to the
  // display paths. The gates fail closed on it either way (a missing or mismatched
  // ownerAddress refuses a stranger), so this is correctness, not a second hole.
  const site = head as Site;
  if (!site?.siteId || site.siteId !== siteId) {
    return { status: "unavailable", reason: "config payload is not a site config for this siteId" };
  }

  // Pages live in their own split feed. A failed pages read stays non-fatal — the
  // site is established either way, and pages are content rather than an ownership
  // fact — so a rejection is flattened to "no pages" rather than losing the site.
  const pagesPage = await readers
    .readPagesPage(Topic.fromString(sitePagesTopicFn(siteId)))
    .catch(() => null);
  if (pagesPage) {
    const pagesData = decodeJsonFeed<{ pages: Page[] }>(pagesPage);
    if (pagesData?.pages) site.pages = pagesData.pages;
  }
  return { status: "found", site };
}

/**
 * Collapse a read to the site or nothing, for DISPLAY paths only.
 *
 * Never decide ownership with this — it restores the exact conflation #181 was
 * about. It exists so read endpoints that legitimately fall through to "show
 * nothing" do not each re-implement the collapse.
 */
export async function resolveSiteConfigOrNull(
  siteId: string,
  readers: SiteConfigReaders = DEFAULT_READERS,
): Promise<ResolvedSite | null> {
  const res = await resolveSiteConfig(siteId, readers);
  return res.status === "found" ? { site: res.site, siteFeedSigner: res.siteFeedSigner } : null;
}

// In-memory memo for getCreatorSites — collapses burst reads when the
// creator portal mounts AND repeat loads across tabs/refreshes. 5 minutes
// matches CREATOR_EVENTS_MEMO_TTL_MS. Upsert paths bypass with
// { fresh: true } and invalidate on write so a newly published / deployed
// site appears immediately for its author.
const CREATOR_SITES_MEMO_TTL_MS = 5 * 60_000;
const _creatorSitesMemo = new Map<string, { at: number; data: SiteDirectoryEntry[] }>();
const _creatorSitesInFlight = new Map<string, Promise<SiteDirectoryEntry[]>>();

/**
 * Fetch just the theme palette + brandName for a site. Used by the Stripe
 * webhook to theme ticket emails and PNG cards with the organiser's branding.
 */
export async function getSiteTheme(
  siteId: string,
): Promise<{ palette: SitePalette; brandName: string; contactEmail?: string } | null> {
  try {
    // Display path: theming a ticket email. An unreadable config means the email
    // goes out with WoCo's default palette, which is the correct fallback and not
    // an ownership decision.
    const resolved = await resolveSiteConfigOrNull(siteId);
    if (!resolved?.site?.theme?.palette) return null;
    return {
      palette: resolved.site.theme.palette,
      brandName: resolved.site.theme.brandName,
      // Reply-To for ticket email. The From stays platform-owned — only replies
      // are redirected, so an organiser's domain reputation can never affect
      // whether attendees receive their tickets (see lib/email/client.ts).
      contactEmail: resolved.site.contact?.email,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the TRUSTED content-feed signer for one event from a site's
 * server-written `SiteEventsIndex` (the money-path carrier). The index is
 * written + owner-gated by the server (`stampEventSigners` stamps each entry's
 * `creatorFeedSigner` from a trusted read), so the signer it carries is safe to
 * pass into `getEvent(eventId, signerHint)` on the claim/payment path — unlike a
 * signer taken from a client request (see the `getEvent` doc + commit 93ea980).
 *
 * `siteId` is only a POINTER chosen by the caller; the trust comes from the
 * server-written index it selects, never from the request. Returns null when the
 * site/index/entry is absent or the event has no carried signer (legacy
 * platform-signed event → caller falls back to the legacy read).
 */
export async function resolveSiteEventSigner(
  siteId: string,
  eventId: string,
): Promise<string | null> {
  // Bounded format guard on the caller-supplied pointer: a malformed/oversized
  // siteId can never resolve a real index, so reject it before doing a Swarm read
  // (avoids wasted reads on garbage input). Matches the siteId shape accepted at
  // checkout (stripe.ts) — ULID-ish, conservative charset + length.
  if (!/^[0-9a-zA-Z_-]{8,64}$/.test(siteId)) return null;
  try {
    const page = await readFeedPage(Topic.fromString(siteEventsIndexTopic(siteId)));
    if (!page) return null;
    const index = decodeJsonFeed<SiteEventsIndex>(page);
    const entry = index?.events.find((e) => e.eventId === eventId);
    return entry?.creatorFeedSigner ?? null;
  } catch {
    return null;
  }
}

export function invalidateCreatorSitesCache(ethAddress: string): void {
  _creatorSitesMemo.delete(ethAddress.toLowerCase());
}

export async function getCreatorSites(
  ethAddress: string,
  opts: { fresh?: boolean } = {},
): Promise<SiteDirectoryEntry[]> {
  const key = ethAddress.toLowerCase();
  if (!opts.fresh) {
    const memo = _creatorSitesMemo.get(key);
    if (memo && Date.now() - memo.at < CREATOR_SITES_MEMO_TTL_MS) return memo.data;
    const inFlight = _creatorSitesInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const load = (async () => {
    const page0 = await readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress)));
    if (!page0) return [];
    const dir = decodeJsonFeed<SiteDirectory>(page0);
    if (!dir) return [];

    const totalPages = dir.pages ?? 0;
    if (totalPages === 0) return [...dir.entries];

    const overflow = await Promise.all(
      Array.from({ length: totalPages }, (_, i) =>
        readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress, i + 1))),
      ),
    );
    const all = [...dir.entries];
    for (const pageData of overflow) {
      if (!pageData) break;
      const decoded = decodeJsonFeed<SiteDirectory>(pageData);
      if (decoded?.entries) all.push(...decoded.entries);
    }
    return all;
  })();

  _creatorSitesInFlight.set(key, load);
  try {
    const data = await load;
    // Only memoize populated results. readFeedPage() swallows transient
    // errors into null (returning []), which would otherwise pin an empty
    // response for CREATOR_SITES_MEMO_TTL_MS — exactly the "navigate away,
    // come back" symptom on first creator-portal load.
    if (data.length > 0) {
      _creatorSitesMemo.set(key, { at: Date.now(), data });
    }
    return data;
  } finally {
    _creatorSitesInFlight.delete(key);
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

async function writeDirectoryPages(entries: SiteDirectoryEntry[], topicFn: (p: number) => string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const pages: SiteDirectoryEntry[][] = [];
  let current: SiteDirectoryEntry[] = [];

  for (const entry of entries) {
    current.push(entry);
    const test: SiteDirectory = { v: 1, entries: current, updatedAt, pages: 0 };
    if (JSON.stringify(test).length > DIR_PAGE_LIMIT) {
      current.pop();
      if (current.length > 0) pages.push(current);
      current = [entry];
    }
  }
  if (current.length > 0) pages.push(current);

  const page0: SiteDirectory = {
    v: 1,
    entries: pages[0] ?? [],
    updatedAt,
    pages: pages.length - 1,
  };
  await writeFeedPage(Topic.fromString(topicFn(0)), encodeJsonFeed(page0));

  for (let p = 1; p < pages.length; p++) {
    const overflow: SiteDirectory = { v: 1, entries: pages[p], updatedAt };
    await writeFeedPage(Topic.fromString(topicFn(p)), encodeJsonFeed(overflow));
  }
}

/**
 * Strict read of the creator's site directory for the WRITE path. Returns
 * the full prior contents or throws on any transient read error. Bootstrap
 * (page 0 absent) returns [] — safe to write the first site.
 *
 * MUST be used in place of getCreatorSites() before any directory rewrite —
 * a [] from a transient Swarm failure would otherwise cause upsert to
 * overwrite the directory with just the new entry, wiping every other site
 * the creator owns.
 */
async function readCreatorSitesStrict(ethAddress: string): Promise<SiteDirectoryEntry[]> {
  const page0 = await readFeedPageStrict(Topic.fromString(siteCreatorDirectoryTopic(ethAddress)));
  if (page0.status === "error") {
    throw new Error(`Site directory read failed (page 0) — refusing to write: ${page0.error.message}`);
  }
  if (page0.status === "absent") return [];

  const dir = decodeJsonFeed<SiteDirectory>(page0.data);
  if (!dir) {
    throw new Error("Site directory page 0 decoded to null — refusing to write");
  }

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const overflow = await readFeedPageStrict(Topic.fromString(siteCreatorDirectoryTopic(ethAddress, p)));
    if (overflow.status === "error") {
      throw new Error(`Site directory read failed (overflow page ${p}) — refusing to write: ${overflow.error.message}`);
    }
    if (overflow.status === "absent") break;
    const decoded = decodeJsonFeed<SiteDirectory>(overflow.data);
    if (decoded?.entries) all.push(...decoded.entries);
  }
  return all;
}

/**
 * Upsert a site entry into the creator's directory feed.
 * Existing entry for the same siteId is replaced (updates feedHash, deployedUrl, etc).
 *
 * Throws if the prior directory state can't be read confidently — refuses
 * to write rather than risk overwriting the directory with a partial view.
 * Callers (publish / deploy) invoke this fire-and-forget so the throw
 * surfaces as a logged warning; the published site itself is unaffected.
 */
export async function upsertCreatorSite(ethAddress: string, entry: SiteDirectoryEntry): Promise<void> {
  const existing = await readCreatorSitesStrict(ethAddress);
  const prior = existing.find((e) => e.siteId === entry.siteId);
  const filtered = existing.filter((e) => e.siteId !== entry.siteId);
  // Merge over the prior entry so a caller that doesn't know a field (publish
  // doesn't know feedHash/deployedUrl; deploy doesn't know siteFeedSigner)
  // never wipes what the other wrote.
  const updated = [{ ...prior, ...entry }, ...filtered]; // most-recently-published first
  await writeDirectoryPages(updated, (p) => siteCreatorDirectoryTopic(ethAddress, p));
  invalidateCreatorSitesCache(ethAddress);
  console.log(`[site] Creator directory updated for ${ethAddress}: ${updated.length} site(s)`);
}
