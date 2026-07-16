/**
 * Canonical gateway URLs. Beyond being read endpoints, these are the ROUTING
 * SIGNAL for server-side batch selection: /api/swarm/soc, /api/swarm/bytes and
 * the site/event deploy endpoints match the gatewayUrl host to decide which
 * postage batch pays (the caller's Etherna batch when they own a live one, the
 * shared Etherna platform batch otherwise, the WoCo platform batch when the
 * WoCo gateway — or nothing — is sent).
 */
export const ETHERNA_GATEWAY_URL = "https://gateway.etherna.io";
export const WOCO_GATEWAY_URL = "https://gateway.woco-net.com";
