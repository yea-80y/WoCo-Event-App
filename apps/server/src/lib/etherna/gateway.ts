/**
 * Where THIS server sends its own Etherna HTTP calls - and nothing else (#657).
 *
 * `ETHERNA_GATEWAY_URL` used to be read in seven places and to double as the
 * ROUTING signal: `isEthernaGateway` compared request and feed gateways against
 * it. Clients send the canonical host from `@woco/shared`, so an env value on
 * another host would have made every Etherna write silently stamp on WoCo and
 * every Etherna-routed read stop asking Etherna. Now routing, recorded values and
 * anything handed to a browser use the shared canonical URL; the env var only
 * says where the server's own requests go (a private endpoint, a proxy).
 */

import { ETHERNA_GATEWAY_URL, isEthernaGatewayUrl } from "@woco/shared";

export const ETHERNA_FETCH_BASE = (process.env.ETHERNA_GATEWAY_URL || ETHERNA_GATEWAY_URL).replace(/\/+$/, "");

/**
 * A line for the boot log when the fetch base is not the canonical host, or
 * null. Not fatal: pointing the server's own calls elsewhere is legitimate. The
 * point is that the operator sees routing will NOT follow it.
 */
export function ethernaFetchBaseNotice(base: string = ETHERNA_FETCH_BASE): string | null {
  if (isEthernaGatewayUrl(base)) return null;
  return (
    `[etherna] ETHERNA_GATEWAY_URL (${base}) is not the canonical Etherna gateway (${ETHERNA_GATEWAY_URL}). ` +
    `The server's own Etherna requests go there; routing, recorded feed gateways and site configs still ` +
    `use ${ETHERNA_GATEWAY_URL}.`
  );
}
