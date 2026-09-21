/**
 * Warm the TLS certificate for a name's public web address.
 *
 * eth.limo issues a subname's certificate on demand, during the FIRST TLS
 * handshake for that hostname — so without this the organiser's own first click
 * is the issuance: seconds of blank tab, sometimes a browser error. One attempt
 * and no retries, ever: each handshake spends one of the gateway's ~10 `/ask`
 * per 15 minutes for that hostname, so a retry loop is precisely how a name gets
 * locked out of being issued at all. A HEAD is enough — the handshake triggers
 * issuance, the response is irrelevant. And it must run only AFTER the
 * contenthash receipt: eth.limo caches a "no contenthash" answer for 300 s, so
 * warming early buys a negative instead of a certificate.
 */

import { AbiCoder } from "ethers";
import { subEnsName, subEnsWebUrl, validateLabel } from "@woco/shared";

/**
 * The handshake BLOCKS while eth.limo issues the certificate (1-2 minutes on
 * 2026-09-21), so the attempt must stay open that long. 30 s used to give up
 * mid-issuance.
 */
export const CERT_WARMUP_TIMEOUT_MS = 120_000;

/** How often, and for how long, to wait for the public gateway to serve the new pointer. */
export const RESOLVABLE_POLL_INTERVAL_MS = 15_000;
export const RESOLVABLE_POLL_WINDOW_MS = 5 * 60_000;

/**
 * eth.limo's DNS-over-HTTPS diagnostic: its own resolver's answer for a name,
 * as `dnslink=/bzz/<ref>`. A request to `dns.eth.limo`, never a handshake for
 * the name's host, so it spends none of that host's `/ask` budget. Its answers
 * carry ttl 300, hence a window a little past five minutes.
 */
export const ETH_LIMO_DOH_URL = "https://dns.eth.limo/dns-query";
export const ETH_LIMO_POLL_WINDOW_MS = 6 * 60_000;

export interface CertWarmupDeps {
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface ResolvableWarmupDeps extends CertWarmupDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  windowMs?: number;
  ethLimoWindowMs?: number;
}

export interface ExpectedPointer {
  /** The contenthash bytes just written, as hex. */
  contenthash: string;
  /** The Swarm reference inside it, as eth.limo reports it back. */
  swarmHash: string;
}

const ABI = AbiCoder.defaultAbiCoder();

/** The contenthash the public gateway currently serves, lowercased hex, or null if it did not answer cleanly. */
async function servedContenthash(doFetch: typeof fetch, queryUrl: string): Promise<string | null> {
  try {
    const res = await doFetch(queryUrl, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: string };
    if (typeof body.data !== "string") return null;
    const [result] = ABI.decode(["bytes", "uint64", "bytes"], body.data);
    const [contenthash] = ABI.decode(["bytes"], result as string);
    return String(contenthash).toLowerCase();
  } catch {
    return null;
  }
}

/** The bzz reference eth.limo's own resolver holds for `name`, lowercased, or null if it holds none or did not answer cleanly. */
async function ethLimoBzzRef(doFetch: typeof fetch, name: string): Promise<string | null> {
  try {
    const res = await doFetch(`${ETH_LIMO_DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { Answer?: Array<{ data?: unknown }> };
    for (const answer of body.Answer ?? []) {
      if (typeof answer.data !== "string") continue;
      const m = /^"?dnslink=\/bzz\/([0-9a-fA-F]{64})"?$/.exec(answer.data);
      if (m) return m[1].toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/** Poll until `holds` answers true or the window closes; true only if it held. */
async function pollUntil(
  holds: () => Promise<boolean>,
  windowMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + windowMs;
  for (;;) {
    if (await holds()) return true;
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Warm a name's certificate only once eth.limo can resolve its new pointer (#557).
 *
 * "After the receipt" was not enough. eth.limo resolves through our PUBLIC
 * gateway, whose memo and Cloudflare's edge can go on serving the previous
 * answer for up to about two minutes, and a fresh name's previous answer is "no
 * contenthash". Knocking ten seconds after the receipt therefore bought
 * eth.limo's 300 s negative instead of a certificate: on 2026-09-21 `sitetest`
 * was warmed at +10 s, failed, and got its certificate about 40 minutes later.
 *
 * Two gates, in this order, then ONE knock:
 * 1. Our public gateway serves the new contenthash - polled at the exact URL an
 *    outside resolver asks, without contacting eth.limo at all. Asking eth.limo
 *    while that answer is still "unset" is how a 300 s negative gets made.
 * 2. eth.limo's own resolver reports the new reference. That waits out a
 *    negative it cached before we got here - an early click on the link.
 * If either gate does not open within its window, do NOT knock: a handshake
 * then spends an ask to cache the negative, and the first visitor's own
 * handshake is the fallback that works today.
 */
export async function warmSubEnsWebCertWhenResolvable(
  label: string,
  expected: ExpectedPointer,
  queryUrl: string | null,
  deps: ResolvableWarmupDeps = {},
): Promise<number | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? RESOLVABLE_POLL_INTERVAL_MS;

  const invalid = validateLabel(label);
  if (invalid) {
    log(`[sub-ens] cert warm-up refused label ${JSON.stringify(label)}: ${invalid}`);
    return null;
  }
  const name = subEnsName(label);
  if (!queryUrl) {
    log(`[sub-ens] cert warm-up skipped for ${name}: no public gateway URL configured to confirm it resolves`);
    return null;
  }

  const wantContenthash = expected.contenthash.toLowerCase();
  const gatewayServes = await pollUntil(
    async () => (await servedContenthash(doFetch, queryUrl)) === wantContenthash,
    deps.windowMs ?? RESOLVABLE_POLL_WINDOW_MS,
    intervalMs,
    sleep,
    now,
  );
  if (!gatewayServes) {
    log(`[sub-ens] cert warm-up skipped for ${name}: the public gateway did not serve the new contenthash in time`);
    return null;
  }

  const wantRef = expected.swarmHash.replace(/^0x/i, "").toLowerCase();
  const ethLimoResolves = await pollUntil(
    async () => (await ethLimoBzzRef(doFetch, name)) === wantRef,
    deps.ethLimoWindowMs ?? ETH_LIMO_POLL_WINDOW_MS,
    intervalMs,
    sleep,
    now,
  );
  if (!ethLimoResolves) {
    log(`[sub-ens] cert warm-up skipped for ${name}: eth.limo did not resolve the new reference in time`);
    return null;
  }

  return warmSubEnsWebCert(label, { fetch: doFetch, log });
}

export async function warmSubEnsWebCert(
  label: string,
  deps: CertWarmupDeps = {},
): Promise<number | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  // The hostname is built from the label. Every caller has already proven
  // on-chain ownership, which the registrar only grants to a valid label, but a
  // courtesy request must not inherit that guarantee from whoever calls it: a
  // label carrying `/` or `@` would point this HEAD at an arbitrary host.
  const invalid = validateLabel(label);
  if (invalid) {
    log(`[sub-ens] cert warm-up refused label ${JSON.stringify(label)}: ${invalid}`);
    return null;
  }
  const url = subEnsWebUrl(label);

  try {
    const res = await doFetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(CERT_WARMUP_TIMEOUT_MS),
    });
    log(`[sub-ens] cert warm-up ${url} → ${res.status}`);
    return res.status;
  } catch (err) {
    // undici reports a refused certificate (TLS alert) and a dead network alike
    // as "fetch failed"; the cause's code is what tells them apart.
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    log(
      `[sub-ens] cert warm-up ${url} failed: ${err instanceof Error ? err.message : String(err)}` +
        (typeof cause === "string" ? ` (${cause})` : ""),
    );
    return null;
  }
}
