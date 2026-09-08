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

import { subEnsWebUrl, validateLabel } from "@woco/shared";

export const CERT_WARMUP_TIMEOUT_MS = 30_000;

export interface CertWarmupDeps {
  fetch?: typeof fetch;
  log?: (line: string) => void;
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
