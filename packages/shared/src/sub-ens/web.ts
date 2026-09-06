/**
 * Where a `.woco.eth` name is reachable on the web.
 *
 * The gateway suffix is NOT a stable fact about the name, so it lives here and
 * nowhere else. `.limo` and `.link` are the SAME eth.limo stack, so the
 * 2026-09-06 note that lived here — "eth.limo refuses a certificate for our
 * two-label subnames" — was wrong. The real mechanism, verified against
 * `ethlimo/dweb-proxy-api`: a subname's TLS certificate is issued on demand at
 * the first handshake and only if the name already resolves to a contenthash,
 * Caddy's `/ask` is rate-limited per hostname (~10 per 15 min, then 429), and a
 * resolution answer is cached 300 s — negatives included. So a name visited
 * before its contenthash landed locks itself out for the window. The server
 * warms the certificate once after every contenthash receipt
 * (`apps/server/src/lib/sub-ens/cert-warmup.ts`).
 *
 * `apps/web/test/sub-ens-web-url.test.ts` fails if a spelled-out suffix
 * reappears under `apps/web/src`.
 */

/** The ENS parent every WoCo name is minted under. */
export const SUB_ENS_PARENT = "woco.eth";

/** Public web gateway suffix. Flip here and nowhere else. */
export const SUB_ENS_WEB_SUFFIX = "woco.eth.limo";

/** `nabil` → `nabil.woco.eth` — the name itself, never a URL. */
export function subEnsName(label: string): string {
  return `${label}.${SUB_ENS_PARENT}`;
}

/** `nabil` → `https://nabil.woco.eth.limo` — the browsable address. */
export function subEnsWebUrl(label: string): string {
  return `https://${label}.${SUB_ENS_WEB_SUFFIX}`;
}
