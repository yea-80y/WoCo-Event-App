import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Domain registry stored as JSON file alongside the server
const DOMAINS_FILE = resolve(__dirname, "../../../data/domains.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainEntry {
  /** Custom hostname e.g. "events.mycompany.com" */
  hostname: string;
  /** Event ID this domain is linked to */
  eventId: string;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function registerDomain(
  hostname: string,
  eventId: string,
  feedManifestHash: string,
  contentHash: string,
  ownerAddress: string,
): Promise<DomainEntry> {
  const store = await loadDomains();
  const normalized = hostname.toLowerCase().trim();

  // Check if already registered
  const existing = store.domains.find((d) => d.hostname === normalized);
  if (existing) {
    if (existing.ownerAddress !== ownerAddress.toLowerCase()) {
      throw new Error("Domain already registered by another organiser");
    }
    // Update existing entry
    existing.eventId = eventId;
    existing.feedManifestHash = feedManifestHash;
    existing.contentHash = contentHash;
    existing.verified = false; // Re-verify after update
    await saveDomains();
    return existing;
  }

  const entry: DomainEntry = {
    hostname: normalized,
    eventId,
    feedManifestHash,
    contentHash,
    ownerAddress: ownerAddress.toLowerCase(),
    verified: false,
    createdAt: new Date().toISOString(),
  };

  store.domains.push(entry);
  await saveDomains();
  return entry;
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

  try {
    const records = await dns.resolveCname(normalized);
    const hasCname = records.some(
      (r) => r.toLowerCase().replace(/\.$/, "") === CNAME_TARGET,
    );

    if (hasCname) {
      entry.verified = true;
      entry.verifiedAt = new Date().toISOString();
      await saveDomains();
      return { verified: true };
    }

    return {
      verified: false,
      error: `CNAME not found. Add a CNAME record: ${normalized} → ${CNAME_TARGET}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DNS lookup failed";
    return {
      verified: false,
      error: `DNS lookup failed: ${msg}. Add a CNAME record: ${normalized} → ${CNAME_TARGET}`,
    };
  }
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

export async function getDomainsForOwner(
  ownerAddress: string,
): Promise<DomainEntry[]> {
  const store = await loadDomains();
  return store.domains.filter(
    (d) => d.ownerAddress === ownerAddress.toLowerCase(),
  );
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
 * Returns null if domain not registered or not verified.
 */
export async function resolveDomain(
  hostname: string,
): Promise<{ contentHash: string; feedManifestHash: string } | null> {
  const entry = await getDomainByHostname(hostname);
  if (!entry || !entry.verified) return null;
  return {
    contentHash: entry.contentHash,
    feedManifestHash: entry.feedManifestHash,
  };
}
