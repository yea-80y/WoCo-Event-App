/**
 * Where a `.woco.eth` name is reachable on the web.
 *
 * The gateway suffix is NOT a stable fact about the name, so it lives here and
 * nowhere else. 2026-09-06: eth.limo refuses to issue a TLS certificate for our
 * two-label subnames, so every `<label>.woco.eth.limo` link died in the browser
 * before a resolver was ever asked — the names themselves resolve fine on
 * mainnet through woco.eth's resolver. Cloudflare's eth.link gateway serves
 * them. If .limo starts issuing, flip SUB_ENS_WEB_SUFFIX here and nowhere else:
 * `apps/web/test/sub-ens-web-url.test.ts` fails if a literal suffix reappears
 * under `apps/web/src`.
 */

/** The ENS parent every WoCo name is minted under. */
export const SUB_ENS_PARENT = "woco.eth";

/** Public web gateway suffix. Flip here and nowhere else. */
export const SUB_ENS_WEB_SUFFIX = "woco.eth.link";

/** `nabil` → `nabil.woco.eth` — the name itself, never a URL. */
export function subEnsName(label: string): string {
  return `${label}.${SUB_ENS_PARENT}`;
}

/** `nabil` → `https://nabil.woco.eth.link` — the browsable address. */
export function subEnsWebUrl(label: string): string {
  return `https://${label}.${SUB_ENS_WEB_SUFFIX}`;
}
