import dns from "node:dns/promises";
import {
  getAllUnverifiedDomains,
  markDomainVerified,
  CNAME_TARGET,
  SERVER_IP,
  rootDomain,
} from "./service.js";

const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes

async function checkDomain(hostname: string): Promise<boolean> {
  // Subdomains: CNAME → sites.woco-net.com
  try {
    const records = await dns.resolveCname(hostname);
    if (records.some((r) => r.toLowerCase().replace(/\.$/, "") === CNAME_TARGET)) {
      return true;
    }
  } catch { /* fall through */ }

  // Apex/bare domains: A record → our server IP
  const isApex = rootDomain(hostname) === hostname;
  if (isApex) {
    try {
      const a = await dns.resolve4(hostname);
      return a.includes(SERVER_IP);
    } catch { /* not configured */ }
  }

  return false;
}

async function tick(): Promise<void> {
  let domains: Awaited<ReturnType<typeof getAllUnverifiedDomains>>;
  try {
    domains = await getAllUnverifiedDomains();
  } catch (err) {
    console.warn("[domains/poller] failed to load domains:", err);
    return;
  }

  await Promise.allSettled(
    domains.map(async (entry) => {
      const dnsOk = await checkDomain(entry.hostname);

      if (dnsOk) {
        await markDomainVerified(entry.hostname);
        // No owner notification: identity here is a wallet address, and we hold
        // no email for it. Restore once organiser contact addresses exist.
        console.log(`[domains/poller] verified: ${entry.hostname}`);
      }
    }),
  );
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDomainPoller(): void {
  if (timer) return;
  // First run after a short delay to let the server finish booting
  setTimeout(() => tick().catch((e) => console.warn("[domains/poller] tick error:", e)), 30_000);
  timer = setInterval(
    () => tick().catch((e) => console.warn("[domains/poller] tick error:", e)),
    POLL_INTERVAL_MS,
  );
}

export function stopDomainPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
