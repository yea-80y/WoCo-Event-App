import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import dns from "node:dns/promises";

const DOMAINS_FILE = join(process.cwd(), ".data", "domains.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainEntry {
  /** Custom hostname e.g. "events.mycompany.com" */
  hostname: string;
  /** Event ID this domain is linked to (event-site path) */
  eventId?: string;
  /** Site ID this domain is linked to (multi-page builder path) */
  siteId?: string;
  /** Swarm feed manifest hash (from site deploy) */
  feedManifestHash: string;
  /** Direct content hash (latest deploy) */
  contentHash: string;
  /** Organiser's Ethereum address (lowercase) */
  ownerAddress: string;
  /** DNS verification status */
  verified: boolean;
  /** When the domain was registered */
  createdAt: string;
  /** When DNS was last verified */
  verifiedAt?: string;
  /** Whether the domain's NS is on Cloudflare (detected at registration) */
  onCloudflare?: boolean;
  /** DNS provider name detected at registration */
  provider?: string;
  /** ISO date when the 7-day free trial expires (non-CF domains only) */
  trialExpiresAt?: string;
  /** Set by poller when grace period expires and no CF DNS + no subscription */
  deactivated?: boolean;
}

interface DomainsStore {
  v: 1;
  domains: DomainEntry[];
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cache: DomainsStore = { v: 1, domains: [] };
let loaded = false;

async function ensureDataDir() {
  const dir = dirname(DOMAINS_FILE);
  await fs.mkdir(dir, { recursive: true });
}

async function loadDomains(): Promise<DomainsStore> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(DOMAINS_FILE, "utf-8");
    cache = JSON.parse(raw);
    loaded = true;
  } catch {
    cache = { v: 1, domains: [] };
    loaded = true;
  }
  return cache;
}

async function saveDomains(): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(DOMAINS_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CNAME target — what users point their domain at
// ---------------------------------------------------------------------------

export const CNAME_TARGET = "sites.woco-net.com";
export const SERVER_IP = "46.225.174.72";

// ---------------------------------------------------------------------------
// NS detection
// ---------------------------------------------------------------------------

const NS_PATTERNS: Array<{ test: (ns: string) => boolean; provider: string }> = [
  { test: (n) => n.endsWith(".ns.cloudflare.com"),                           provider: "Cloudflare" },
  { test: (n) => n.includes(".domaincontrol.com"),                           provider: "GoDaddy" },
  { test: (n) => n.includes(".registrar-servers.com"),                       provider: "Namecheap" },
  { test: (n) => n.includes(".googledomains.com") || n.includes(".squarespacedns.com") || n.includes(".nsone.net") || n.includes(".systemdns.com"), provider: "Squarespace" },
  { test: (n) => n.includes(".ui-dns."),                                     provider: "IONOS" },
  { test: (n) => /ns-\d+-[abc]\.awsdns/.test(n),                            provider: "AWS Route 53" },
  { test: (n) => /^ns[1-4]\.name\.com$/.test(n),                            provider: "Name.com" },
  { test: (n) => /^ns[1-2]\.hover\.com$/.test(n),                           provider: "Hover" },
  { test: (n) => n.endsWith(".ns.porkbun.com"),                              provider: "Porkbun" },
  { test: (n) => n.endsWith(".ovh.net") || n.endsWith(".anycast.me") || n.endsWith(".ovh.ca"), provider: "OVHcloud" },
  { test: (n) => /^ns-\d+-[abc]\.gandi\.net$/.test(n),                      provider: "Gandi" },
  { test: (n) => n === "ns.123-reg.co.uk" || n.includes("123-reg"),         provider: "123-reg" },
  { test: (n) => /^ns0[12]\.one\.com$/.test(n),                             provider: "One.com" },
  { test: (n) => /^ns[1-4]\.strato\.de$/.test(n),                          provider: "Strato" },
  { test: (n) => n.includes(".fasthosts.co.uk") || n.includes(".ukfast.net"), provider: "Fasthosts" },
  { test: (n) => n.includes(".ultradns."),                                   provider: "Network Solutions" },
  { test: (n) => /^ns[1-3]\.dreamhost\.com$/.test(n),                      provider: "DreamHost" },
  { test: (n) => /^ns[1-2]\.bluehost\.com$/.test(n),                       provider: "Bluehost" },
  { test: (n) => /^ns[1-2]\.hostgator\.com$/.test(n),                      provider: "HostGator" },
  { test: (n) => n.includes(".heartinternet.uk"),                            provider: "Heart Internet" },
  { test: (n) => n === "hydrogen.ns.hetzner.com" || n === "helium.ns.hetzner.de" || n.includes(".ns.hetzner."), provider: "Hetzner DNS" },
];

export /** Strip subdomain prefix to get the registrable domain for NS lookup.
 *  Handles ccSLDs like .co.uk, .org.uk, .com.au by keeping 3 labels. */
function rootDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const ccSLDs = new Set(["co", "org", "net", "gov", "ac", "me", "ltd", "plc", "sch", "com", "edu", "mil"]);
  if (tld.length === 2 && ccSLDs.has(sld)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export async function detectProvider(hostname: string): Promise<{
  onCloudflare: boolean;
  provider: string;
}> {
  try {
    const root = rootDomain(hostname);
    const nsRecords = await dns.resolveNs(root);
    const normalized = nsRecords.map((n) => n.toLowerCase().replace(/\.$/, ""));
    for (const { test, provider } of NS_PATTERNS) {
      if (normalized.some(test)) {
        return { onCloudflare: provider === "Cloudflare", provider };
      }
    }
  } catch {
    // DNS lookup failed (NXDOMAIN, timeout, etc.) — treat as unknown
  }
  return { onCloudflare: false, provider: "Unknown" };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function registerDomain(
  hostname: string,
  target: { eventId: string } | { siteId: string },
  feedManifestHash: string,
  contentHash: string,
  ownerAddress: string,
): Promise<DomainEntry & { onCloudflare: boolean; provider: string }> {
  const store = await loadDomains();
  const normalized = hostname.toLowerCase().trim();

  const { onCloudflare, provider } = await detectProvider(normalized);

  const existing = store.domains.find((d) => d.hostname === normalized);
  if (existing) {
    if (existing.ownerAddress !== ownerAddress.toLowerCase()) {
      throw new Error("Domain already registered by another organiser");
    }
    // Update existing entry
    if ("eventId" in target) existing.eventId = target.eventId;
    if ("siteId" in target) existing.siteId = target.siteId;
    existing.feedManifestHash = feedManifestHash;
    existing.contentHash = contentHash;
    existing.verified = false;
    existing.onCloudflare = onCloudflare;
    existing.provider = provider;
    await saveDomains();
    return { ...existing, onCloudflare, provider };
  }

  const entry: DomainEntry = {
    hostname: normalized,
    feedManifestHash,
    contentHash,
    ownerAddress: ownerAddress.toLowerCase(),
    verified: false,
    createdAt: new Date().toISOString(),
    onCloudflare,
    provider,
    ...("eventId" in target ? { eventId: target.eventId } : { siteId: target.siteId }),
  };

  store.domains.push(entry);
  await saveDomains();
  return { ...entry, onCloudflare, provider };
}

export async function verifyDomain(hostname: string): Promise<{
  verified: boolean;
  error?: string;
}> {
  const store = await loadDomains();
  const normalized = hostname.toLowerCase().trim();
  const entry = store.domains.find((d) => d.hostname === normalized);

  if (!entry) {
    return { verified: false, error: "Domain not registered" };
  }

  const isApex = rootDomain(normalized) === normalized;

  // Try CNAME first (works for subdomains)
  try {
    const records = await dns.resolveCname(normalized);
    if (records.some((r) => r.toLowerCase().replace(/\.$/, "") === CNAME_TARGET)) {
      entry.verified = true;
      entry.verifiedAt = new Date().toISOString();
      await saveDomains();
      return { verified: true };
    }
  } catch {
    // CNAME lookup failed — may be an apex domain with Cloudflare CNAME flattening,
    // or the record genuinely doesn't exist yet. Fall through.
  }

  // Apex/bare domains can't use CNAME — verify via A record pointing to our server
  if (isApex) {
    try {
      const aRecords = await dns.resolve4(normalized);
      if (aRecords.includes(SERVER_IP)) {
        entry.verified = true;
        entry.verifiedAt = new Date().toISOString();
        await saveDomains();
        return { verified: true };
      }
      return {
        verified: false,
        error: `A record found but points to ${aRecords[0]} — change it to ${SERVER_IP}`,
      };
    } catch {
      return {
        verified: false,
        error: `No A record found yet for ${normalized}. Add one pointing to ${SERVER_IP} and wait a few minutes for DNS to propagate.`,
      };
    }
  }

  return {
    verified: false,
    error: `No CNAME record found yet for ${normalized}. Add one pointing to ${CNAME_TARGET} and wait a few minutes for DNS to propagate.`,
  };
}

export async function getDomainByHostname(
  hostname: string,
): Promise<DomainEntry | null> {
  const store = await loadDomains();
  return (
    store.domains.find((d) => d.hostname === hostname.toLowerCase().trim()) ??
    null
  );
}

export async function getDomainsForEvent(
  eventId: string,
): Promise<DomainEntry[]> {
  const store = await loadDomains();
  return store.domains.filter((d) => d.eventId === eventId);
}

export async function getDomainsForSite(
  siteId: string,
): Promise<DomainEntry[]> {
  const store = await loadDomains();
  return store.domains.filter((d) => d.siteId === siteId);
}

export async function getDomainsForOwner(
  ownerAddress: string,
): Promise<DomainEntry[]> {
  const store = await loadDomains();
  return store.domains.filter(
    (d) => d.ownerAddress === ownerAddress.toLowerCase(),
  );
}

export async function getAllUnverifiedDomains(): Promise<DomainEntry[]> {
  const store = await loadDomains();
  return store.domains.filter((d) => !d.verified && !d.deactivated);
}

export async function markDomainVerified(hostname: string): Promise<void> {
  const store = await loadDomains();
  const entry = store.domains.find(
    (d) => d.hostname === hostname.toLowerCase(),
  );
  if (!entry) return;
  entry.verified = true;
  entry.verifiedAt = new Date().toISOString();
  await saveDomains();
}

/** Called after a successful site re-deploy to update contentHash for all registered domains. */
export async function updateDomainsForSite(
  siteId: string,
  contentHash: string,
  feedManifestHash: string,
): Promise<void> {
  const store = await loadDomains();
  let changed = false;
  for (const d of store.domains) {
    if (d.siteId === siteId) {
      d.contentHash = contentHash;
      d.feedManifestHash = feedManifestHash;
      changed = true;
    }
  }
  if (changed) await saveDomains();
}

export async function removeDomain(
  hostname: string,
  ownerAddress: string,
): Promise<boolean> {
  const store = await loadDomains();
  const normalized = hostname.toLowerCase().trim();
  const idx = store.domains.findIndex(
    (d) =>
      d.hostname === normalized &&
      d.ownerAddress === ownerAddress.toLowerCase(),
  );
  if (idx === -1) return false;
  store.domains.splice(idx, 1);
  await saveDomains();
  return true;
}

/**
 * Look up domain → content hash. Used by the Cloudflare Worker proxy.
 * Returns null if domain not registered, not verified, or deactivated.
 */
export async function resolveDomain(
  hostname: string,
): Promise<{ contentHash: string; feedManifestHash: string } | null> {
  const entry = await getDomainByHostname(hostname);
  if (!entry || !entry.verified || entry.deactivated) return null;
  return {
    contentHash: entry.contentHash,
    feedManifestHash: entry.feedManifestHash,
  };
}
