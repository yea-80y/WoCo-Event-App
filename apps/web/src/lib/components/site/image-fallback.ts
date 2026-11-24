const KNOWN_IMAGE_GATEWAYS = [
  "https://gateway.woco-net.com",
  "https://gateway.etherna.io",
];

function cleanGateway(url: string | undefined | null): string | null {
  const trimmed = url?.trim().replace(/\/$/, "");
  if (!trimmed) return null;

  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * `storedOn` is the event's recorded storage gateway (`gatewayUrl`), tried FIRST
 * because it holds the image the moment it is uploaded - Etherna does, other
 * nodes only once it has spread. It is organiser-written, so it is honoured only
 * when it names one of the known gateways; anything else is ignored rather than
 * fetched, or an organiser could point every viewer's browser at their server.
 *
 * A PUBLISHED page (its config names a known `contentGatewayUrl`, our own gateway)
 * tries that one before `storedOn`: its images were uploaded well before the page
 * was read, ours answered in 0.26 s against Etherna's 1.0-1.3 s (2026-11-24), and
 * it is the address the page's own head already names, so the tab icon and the
 * picture are one download. An image edited a moment ago that our bee cannot find
 * yet costs one 404 (~1.3 s) before `storedOn` is tried.
 */
export function imageUrlCandidates(
  imageHash: string | undefined,
  preferredGateway?: string,
  storedOn?: string,
): string[] {
  if (!imageHash || /^0+$/.test(imageHash)) return [];

  const runtime = typeof window !== "undefined" ? window.SITE_CONFIG : undefined;
  const stored = cleanGateway(storedOn);
  const published = cleanGateway(runtime?.contentGatewayUrl);
  const gateways = [
    published && KNOWN_IMAGE_GATEWAYS.includes(published) ? published : null,
    stored && KNOWN_IMAGE_GATEWAYS.includes(stored) ? stored : null,
    runtime?.contentGatewayUrl,
    runtime?.gatewayUrl,
    preferredGateway,
    ...KNOWN_IMAGE_GATEWAYS,
  ];

  const unique = new Set<string>();
  for (const gateway of gateways) {
    const clean = cleanGateway(gateway);
    if (clean) unique.add(clean);
  }

  return [...unique].map((gateway) => `${gateway}/bytes/${imageHash}`);
}

export function firstImageUrl(
  imageHash: string | undefined,
  preferredGateway?: string,
  storedOn?: string,
): string | undefined {
  return imageUrlCandidates(imageHash, preferredGateway, storedOn)[0];
}

/** Wait before each retry: about a minute in all. */
export const IMAGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Loads the SAME url again after a failed load. The builder shows an image the
 * moment it is uploaded, but the upload is deferred, so Etherna can answer for it
 * only some seconds later - and a browser never retries a failed image itself.
 * Etherna sends its refusals `no-store`, so each retry is a real request.
 * Stops when the element has moved on to another src (a list re-used it for a
 * different image) or after the last delay.
 */
export function retrySameImageUrl(event: Event, delays: readonly number[] = IMAGE_RETRY_DELAYS_MS): void {
  const img = event.currentTarget as HTMLImageElement | null;
  const url = img?.getAttribute("src");
  if (!img || !url) return;

  const attempt = img.dataset.retryFor === url ? Number(img.dataset.retryCount ?? "0") : 0;
  if (!(attempt < delays.length)) return;
  img.dataset.retryFor = url;
  img.dataset.retryCount = String(attempt + 1);

  setTimeout(() => {
    if (img.getAttribute("src") !== url) return;
    img.removeAttribute("src");
    img.setAttribute("src", url);
  }, delays[attempt]);
}

export function useNextImageUrl(
  event: Event,
  imageHash: string | undefined,
  preferredGateway?: string,
  storedOn?: string,
): void {
  const img = event.currentTarget as HTMLImageElement | null;
  if (!img) return;

  const candidates = imageUrlCandidates(imageHash, preferredGateway, storedOn);
  const currentIndex = Number.parseInt(img.dataset.imageGatewayIndex ?? "0", 10);
  const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;

  if (nextIndex >= candidates.length) return;
  img.dataset.imageGatewayIndex = String(nextIndex);
  img.src = candidates[nextIndex];
}
