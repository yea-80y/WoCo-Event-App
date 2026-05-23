import dns from "node:dns/promises";
import {
  getAllUnverifiedDomains,
  markDomainVerified,
  deactivateDomain,
  CNAME_TARGET,
} from "./service.js";
import { getResend, getFromAddress } from "../email/client.js";

const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes
const GRACE_DAYS = 7;

async function checkDomain(hostname: string, onCloudflare: boolean): Promise<boolean> {
  // Try CNAME (subdomains)
  try {
    const records = await dns.resolveCname(hostname);
    if (records.some((r) => r.toLowerCase().replace(/\.$/, "") === CNAME_TARGET)) {
      return true;
    }
  } catch { /* fall through */ }

  // Apex on Cloudflare: CNAME flattened to A record — accept any A record
  const isApex = hostname.split(".").length === 2;
  if (isApex && onCloudflare) {
    try {
      const a = await dns.resolve4(hostname);
      return a.length > 0;
    } catch { /* not configured */ }
  }

  return false;
}

async function sendVerifiedEmail(
  ownerAddress: string,
  hostname: string,
): Promise<void> {
  try {
    const resend = getResend();
    await resend.emails.send({
      from: `"WoCo" <${getFromAddress()}>`,
      to: [ownerAddress], // ownerAddress is the wallet address — this won't deliver unless we have an email; skip silently
      subject: `Your custom domain ${hostname} is now live`,
      html: `<p>Your custom domain <strong>${hostname}</strong> is now configured and serving your WoCo site.</p>`,
    });
  } catch {
    // Email is best-effort — wallet addresses aren't email addresses; this will
    // succeed only for organisers who have an email address on file (future feature)
  }
}

async function tick(): Promise<void> {
  let domains: Awaited<ReturnType<typeof getAllUnverifiedDomains>>;
  try {
    domains = await getAllUnverifiedDomains();
  } catch (err) {
    console.warn("[domains/poller] failed to load domains:", err);
    return;
  }

  const now = Date.now();

  await Promise.allSettled(
    domains.map(async (entry) => {
      const cnameOk = await checkDomain(entry.hostname, entry.onCloudflare ?? false);

      if (cnameOk) {
        await markDomainVerified(entry.hostname);
        console.log(`[domains/poller] verified: ${entry.hostname}`);
        await sendVerifiedEmail(entry.ownerAddress, entry.hostname);
        return;
      }

      // Grace period expiry check (non-CF domains only)
      if (!entry.onCloudflare && entry.trialExpiresAt) {
        const expired = new Date(entry.trialExpiresAt).getTime() < now;
        if (expired) {
          await deactivateDomain(entry.hostname);
          console.log(`[domains/poller] deactivated (grace expired): ${entry.hostname}`);
        }
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
