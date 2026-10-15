/**
 * The API's CORS lists. Kept here, not inline in index.ts, so a real preflight
 * can be tested (`test/cors-headers.test.ts`): Hono echoes ONLY the listed
 * request headers, and every browser client that is cross-origin to the API -
 * the app, the embed, the door scanner - fails its preflight on a header missing
 * here. In-process tests never preflight, so nothing else would notice.
 */
import { SCANNER_DEVICE_HEADER } from "@woco/shared";

/**
 * Every origin is reflected. The API authenticates by signed headers (session
 * delegation, door pass), never by cookies, so an origin gains nothing from being
 * let in; and the clients are on many origins by design - the app on two gateways,
 * organiser sites and custom domains, the embed on anyone's page, the scanner at
 * `scan.woco.eth.limo` and at its gateway URL.
 */
export const corsOrigin = (origin: string): string => origin || "*";

export const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "X-Session-Address",
  "X-Session-Delegation",
  "X-Session-Sig",
  "X-Session-Nonce",
  "X-Session-Timestamp",
  "X-PAYMENT",
  "X-Client-Key",
  "X-Door-Pass",
  SCANNER_DEVICE_HEADER,
];

export const CORS_EXPOSE_HEADERS = ["PAYMENT-REQUIRED", "X-FACILITATOR-URL", "PAYMENT-RESPONSE"];
