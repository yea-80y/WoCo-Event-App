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

export interface CertWarmupDeps {
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface ResolvableWarmupDeps extends CertWarmupDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  windowMs?: number;
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

/**
 * Warm a name's certificate only once the PUBLIC gateway serves its new
 * pointer (#557).
 *
 * "After the receipt" was not enough. eth.limo resolves through that public
 * gateway, whose own memo and Cloudflare's edge can go on serving the previous
 * answer for up to about two minutes, and a fresh name's previous answer is
 * "no contenthash". Knocking ten seconds after the receipt therefore bought
 * eth.limo's 300 s negative instead of a certificate: on 2026-09-21 `sitetest`
 * was warmed at +10 s, failed, and got its certificate about 40 minutes later.
 *
 * So: poll the exact request an outside resolver makes, and knock once when it
 * answers with the new contenthash. If it never does within the window, do NOT
 * knock — a handshake then would cache the negative this exists to avoid, and
 * the first visitor's own handshake is the fallback that works today.
 */
export async function warmSubEnsWebCertWhenResolvable(
  label: string,
  expectedContenthash: string,
  queryUrl: string | null,
  deps: ResolvableWarmupDeps = {},
): Promise<number | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? RESOLVABLE_POLL_INTERVAL_MS;
  const windowMs = deps.windowMs ?? RESOLVABLE_POLL_WINDOW_MS;

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

  const want = expectedContenthash.toLowerCase();
  const deadline = now() + windowMs;
  for (;;) {
    if ((await servedContenthash(doFetch, queryUrl)) === want) {
      return warmSubEnsWebCert(label, { fetch: doFetch, log });
    }
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  log(
    `[sub-ens] cert warm-up skipped for ${name}: the public gateway did not serve the new contenthash within ` +
      `${Math.round(windowMs / 1000)} s, and a handshake now would cache eth.limo's negative`,
  );
  return null;
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
    log(`[sub-ens] cert warm-up ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
