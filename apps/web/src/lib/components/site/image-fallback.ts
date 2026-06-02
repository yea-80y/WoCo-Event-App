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

export function imageUrlCandidates(imageHash: string | undefined, preferredGateway?: string): string[] {
  if (!imageHash || /^0+$/.test(imageHash)) return [];

  const runtime = typeof window !== "undefined" ? window.SITE_CONFIG : undefined;
  const gateways = [
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

export function firstImageUrl(imageHash: string | undefined, preferredGateway?: string): string | undefined {
  return imageUrlCandidates(imageHash, preferredGateway)[0];
}

export function useNextImageUrl(
  event: Event,
  imageHash: string | undefined,
  preferredGateway?: string,
): void {
  const img = event.currentTarget as HTMLImageElement | null;
  if (!img) return;

  const candidates = imageUrlCandidates(imageHash, preferredGateway);
  const currentIndex = Number.parseInt(img.dataset.imageGatewayIndex ?? "0", 10);
  const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;

  if (nextIndex >= candidates.length) return;
  img.dataset.imageGatewayIndex = String(nextIndex);
  img.src = candidates[nextIndex];
}
