/**
 * Document head helpers for SEO tags in a client-rendered SPA (#55).
 *
 * Everything here is keyed by an id so an SPA route change REPLACES the previous
 * page's tags instead of stacking them — two Event blocks on one page is worse
 * than none, because Google treats the mismatch as unreliable markup.
 *
 * Deployed organiser sites get their tags injected at deploy time as well
 * (docs/SEO_PLAN.md); this covers the surfaces whose content is only known at
 * runtime — the main app's event detail page and dynamically-loaded site events.
 */

const SEO_ATTR = "data-woco-seo";

function head(): HTMLHeadElement | null {
  return typeof document === "undefined" ? null : document.head;
}

/** Insert or replace a JSON-LD block. Passing null removes it. */
export function setJsonLd(id: string, data: unknown | null): void {
  const h = head();
  if (!h) return;

  const existing = h.querySelector<HTMLScriptElement>(
    `script[type="application/ld+json"][${SEO_ATTR}="${id}"]`,
  );

  if (data == null) {
    existing?.remove();
    return;
  }

  const json = JSON.stringify(data);
  if (existing) {
    if (existing.textContent !== json) existing.textContent = json;
    return;
  }

  const el = document.createElement("script");
  el.type = "application/ld+json";
  el.setAttribute(SEO_ATTR, id);
  el.textContent = json;
  h.appendChild(el);
}

/** Set <meta name="description">, creating it if the document has none. */
export function setMetaDescription(text: string | null): void {
  const h = head();
  if (!h) return;

  let el = h.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!text) {
    // Only remove tags we own — a deploy-time description must survive navigation.
    if (el?.getAttribute(SEO_ATTR)) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement("meta");
    el.name = "description";
    el.setAttribute(SEO_ATTR, "1");
    h.appendChild(el);
  }
  if (el.content !== text) el.content = text;
}

/** Set <link rel="canonical">. Defaults to the current URL without its fragment. */
export function setCanonical(url?: string | null): void {
  const h = head();
  if (!h) return;

  const href = url ?? (typeof window !== "undefined" ? window.location.href.split("#")[0] : null);
  let el = h.querySelector<HTMLLinkElement>('link[rel="canonical"]');

  if (!href) {
    if (el?.getAttribute(SEO_ATTR)) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    el.setAttribute(SEO_ATTR, "1");
    h.appendChild(el);
  }
  if (el.href !== href) el.href = href;
}

/** Document title, with the brand suffix search results expect. */
export function setTitle(title: string | null, brand?: string): void {
  if (typeof document === "undefined" || !title) return;
  document.title = brand && !title.includes(brand) ? `${title} | ${brand}` : title;
}
