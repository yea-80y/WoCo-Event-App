import { ETHERNA_GATEWAY_URL, WOCO_GATEWAY_URL } from "../../swarm/gateways.js";

export const GATEWAYS = [
  { id: "etherna", label: "Etherna gateway (default)", url: ETHERNA_GATEWAY_URL, default: true },
  { id: "woco",    label: "WoCo gateway (testing)",    url: WOCO_GATEWAY_URL, default: false },
] as const;

export type GatewayId = (typeof GATEWAYS)[number]["id"];
