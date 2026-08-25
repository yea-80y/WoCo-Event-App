/**
 * Hash-based router with surface awareness (attendee vs creator).
 *
 * Route map (canonical → component-route alias kept for back-compat):
 *
 *   NEUTRAL surface
 *     /                            splitter (landing — funnels to organiser vs attendee)
 *     /legal, /legal/:doc          legal (privacy, terms, organiser-terms, dpa, cookies)
 *
 *   ATTENDEE surface
 *     /discover                    discover (events feed — was at /)
 *     /event/:id                   event
 *     /tickets   (and /my-tickets) my-tickets
 *     /verify                      verify
 *     /signup                      signup (email-CTA landing; ?gt= gate token)
 *     /profile, /profile/:addr     profile
 *     /shops/:id/tap               shop-tap (tap-to-pay activation)
 *     /shop/:shopId/order/:code    shop-order (Stripe return — success/cancel)
 *     /coaster/:subject            coaster (log a lap — reached by QR/link, not nav)
 *
 *   CREATOR surface
 *     /creator                          creator-home  (studio dashboard)
 *     /creator/events                   dashboard-index
 *     /creator/events/new   (and /create) create
 *     /creator/events/:id               dashboard
 *     /creator/events/:id/embed         embed-setup
 *     /creator/sites        (and /build)  build
 *     /creator/shops                    my-shops
 *     /creator/shops/:shopId            shop-editor
 *     /creator/shops/:shopId/pos        shop-pos
 *     /creator/payouts                  payouts
 *     /creator/profile/:addr            profile (creator surface)
 *     /dashboard, /dashboard/:id        dashboard-index / dashboard (legacy)
 *     /event/:id/dashboard              dashboard (legacy)
 *     /event/:id/embed                  embed-setup (legacy)
 *     /site-builder                     site-builder (legacy single-event builder)
 *     /stripe/return, /stripe/refresh   stripe-return / stripe-refresh
 */

export type Surface = "neutral" | "attendee" | "creator";

let _route = $state("splitter");
let _params = $state<Record<string, string>>({});
let _surface = $state<Surface>("neutral");

function parseHash(): string {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  return hash.replace(/^#/, "") || "/";
}

interface Match {
  route: string;
  params: Record<string, string>;
  surface: Surface;
}

function matchRoute(pathWithQuery: string): Match {
  const qIdx = pathWithQuery.indexOf("?");
  const path = qIdx === -1 ? pathWithQuery : pathWithQuery.slice(0, qIdx);
  const query = qIdx === -1 ? "" : pathWithQuery.slice(qIdx + 1);

  // ── Neutral splitter (root landing) ──────────────────────────────────────
  if (path === "/" || path === "") return { route: "splitter", params: {}, surface: "neutral" };

  // ── Legal documents (neutral: reachable pre-login, from emails, and from a
  //    checkout the buyer has not signed into) ──────────────────────────────
  const legalMatch = path.match(/^\/legal(?:\/([a-z-]+))?$/);
  if (legalMatch) {
    return { route: "legal", params: { doc: legalMatch[1] ?? "index" }, surface: "neutral" };
  }

  // ── Creator surface (explicit /creator/* prefix) ─────────────────────────
  if (path === "/creator") return { route: "creator-home", params: {}, surface: "creator" };
  if (path === "/creator/events") return { route: "dashboard-index", params: {}, surface: "creator" };
  if (path === "/creator/events/new") return { route: "create", params: {}, surface: "creator" };
  if (path === "/creator/sites") return { route: "build", params: {}, surface: "creator" };
  if (path === "/creator/shops") return { route: "my-shops", params: {}, surface: "creator" };
  if (path === "/creator/pods") return { route: "creator-pods", params: {}, surface: "creator" };
  if (path === "/creator/payouts") return { route: "payouts", params: {}, surface: "creator" };
  if (path === "/creator/audience") {
    // ?announce={eventId} — the post-publish prompt lands here with the
    // composer open and that event preselected.
    const announce = new URLSearchParams(query).get("announce");
    return { route: "audience", params: announce ? { announce } : {}, surface: "creator" };
  }
  if (path === "/creator/profile") return { route: "profile", params: {}, surface: "creator" };

  const shopPosMatch = path.match(/^\/creator\/shops\/([^/]+)\/pos$/);
  if (shopPosMatch) return { route: "shop-pos", params: { shopId: shopPosMatch[1] }, surface: "creator" };

  const shopEditorMatch = path.match(/^\/creator\/shops\/([^/]+)$/);
  if (shopEditorMatch) return { route: "shop-editor", params: { shopId: shopEditorMatch[1] }, surface: "creator" };

  const creatorSiteEventsMatch = path.match(/^\/creator\/sites\/([^/]+)\/events$/);
  if (creatorSiteEventsMatch) return { route: "site-events", params: { siteId: creatorSiteEventsMatch[1] }, surface: "creator" };

  const creatorEventEmbed = path.match(/^\/creator\/events\/(.+)\/embed$/);
  if (creatorEventEmbed) return { route: "embed-setup", params: { id: creatorEventEmbed[1] }, surface: "creator" };

  const creatorEventManage = path.match(/^\/creator\/events\/(.+)$/);
  if (creatorEventManage) return { route: "dashboard", params: { id: creatorEventManage[1] }, surface: "creator" };

  const creatorProfileMatch = path.match(/^\/creator\/profile\/(0x[a-fA-F0-9]{40})$/);
  if (creatorProfileMatch) return { route: "profile", params: { address: creatorProfileMatch[1] }, surface: "creator" };

  // ── Attendee surface ────────────────────────────────────────────────────
  if (path === "/discover") return { route: "discover", params: {}, surface: "attendee" };
  if (path === "/tickets" || path === "/my-tickets") return { route: "my-tickets", params: {}, surface: "attendee" };
  if (path === "/verify") return { route: "verify", params: {}, surface: "attendee" };
  if (path === "/signup") {
    const gt = new URLSearchParams(query).get("gt");
    return { route: "signup", params: gt ? { gt } : {}, surface: "attendee" };
  }
  if (path === "/protect") return { route: "protect", params: {}, surface: "attendee" };
  if (path === "/recover") return { route: "recover", params: {}, surface: "attendee" };
  if (path === "/profile") return { route: "profile", params: {}, surface: "attendee" };
  const soonMatch = path.match(/^\/soon\/(.+)$/);
  if (soonMatch) return { route: "soon", params: { feature: soonMatch[1] }, surface: "attendee" };

  // Reached from a QR code or a shared link, never from nav: a one-coaster
  // pilot inside an events app does not spend permanent nav real estate.
  // Parameterised rather than hard-coded to the pilot coaster so a second
  // subject needs no redeploy; the page itself refuses any subject the shipped
  // catalogue does not name.
  const coasterMatch = path.match(/^\/coaster\/(0x[0-9a-fA-F]{64})$/);
  if (coasterMatch) {
    return { route: "coaster", params: { subject: coasterMatch[1].toLowerCase() }, surface: "attendee" };
  }

  const shopTapMatch = path.match(/^\/shops\/([^/]+)\/tap$/);
  if (shopTapMatch) return { route: "shop-tap", params: { shopId: shopTapMatch[1] }, surface: "attendee" };

  const shopOrderMatch = path.match(/^\/shop\/([^/]+)\/order\/([^/]+)$/);
  if (shopOrderMatch) return { route: "shop-order", params: { shopId: shopOrderMatch[1], code: shopOrderMatch[2] }, surface: "attendee" };

  const profileMatch = path.match(/^\/profile\/(0x[a-fA-F0-9]{40})$/);
  if (profileMatch) return { route: "profile", params: { address: profileMatch[1] }, surface: "attendee" };

  // ── Legacy creator routes (kept for back-compat; render in creator shell) ─
  if (path === "/create") return { route: "create", params: {}, surface: "creator" };
  if (path === "/dashboard") return { route: "dashboard-index", params: {}, surface: "creator" };
  if (path === "/build") return { route: "build", params: {}, surface: "creator" };
  if (path === "/site-builder") {
    const params: Record<string, string> = {};
    if (query.split("&").includes("advanced=1")) params.advanced = "1";
    return { route: "site-builder", params, surface: "creator" };
  }
  if (path === "/stripe/return") return { route: "stripe-return", params: {}, surface: "creator" };
  if (path === "/stripe/refresh") return { route: "stripe-refresh", params: {}, surface: "creator" };

  const legacyDashboardMatch = path.match(/^\/event\/(.+)\/dashboard$/);
  if (legacyDashboardMatch) return { route: "dashboard", params: { id: legacyDashboardMatch[1] }, surface: "creator" };

  const legacyEmbedMatch = path.match(/^\/event\/(.+)\/embed$/);
  if (legacyEmbedMatch) return { route: "embed-setup", params: { id: legacyEmbedMatch[1] }, surface: "creator" };

  const eventPurchasedMatch = path.match(/^\/event\/(.+)\/purchased$/);
  if (eventPurchasedMatch) return { route: "event-purchased", params: { id: eventPurchasedMatch[1] }, surface: "attendee" };

  // Event detail page is attendee-facing (public) — even for creators viewing their own.
  const eventMatch = path.match(/^\/event\/(.+)$/);
  if (eventMatch) return { route: "event", params: { id: eventMatch[1] }, surface: "attendee" };

  return { route: "splitter", params: {}, surface: "neutral" };
}

function update() {
  // Referral capture: #/ref/{referrer} isn't a screen — persist the referrer
  // and land on discover. The referrer is an address OR a WoCo sub-ENS name, so
  // an organiser can share `#/ref/theirvenue` instead of forty hex characters.
  //
  // The lazy import points at the dependency-free capture module rather than
  // the API client, so an address link costs a few lines instead of the client
  // + auth graph; the resolver is only pulled when a link actually carries a
  // name.
  const refMatch = parseHash().match(/^\/ref\/([^/?#]+)$/);
  if (refMatch) {
    void import("../campaign/referral-capture.js").then(async (m) => {
      const token = m.classifyRefToken(decodeURIComponent(refMatch[1]));
      // One call for either kind: it replaces the whole previous capture, so a
      // second invite can never inherit the first one's name or address.
      m.beginCapture(token);
      if (token.kind !== "name") return;
      // The name is stored BEFORE it resolves. Resolution is a network read and
      // may fail; the visitor is owed the acknowledgement either way, and the
      // post path re-resolves later so a registrar blip does not cost the
      // referrer their credit.
      const { resolveSubEnsAddress } = await import("../api/sub-ens.js");
      const res = await resolveSubEnsAddress(token.label).catch(() => null);
      if (res?.status === "found") {
        m.storeCapturedRef(res.address);
      } else if (res?.status === "none") {
        // "none" is the registrar answering that the name is not registered —
        // authoritative, so forget the capture here rather than leaving a dead
        // name pending and telling the visitor someone will get the credit.
        // "error" is nobody answering and must never be read as absence (#177),
        // so that case alone leaves the name for the post path to retry.
        m.clearCapturedRef();
      }
    });
    window.location.replace(`${window.location.pathname}#/discover`);
    return;
  }
  const matched = matchRoute(parseHash());
  _route = matched.route;
  _params = matched.params;
  _surface = matched.surface;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", update);
  update();
}

export function navigate(path: string) {
  window.location.hash = path;
}

export const router = {
  get route() { return _route; },
  get params() { return _params; },
  get surface() { return _surface; },
  navigate,
};
