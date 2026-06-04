export const GATEWAYS = [
  { id: "etherna", label: "Etherna gateway (default)", url: "https://gateway.etherna.io", default: true },
  { id: "woco",    label: "WoCo gateway (testing)",    url: "https://gateway.woco-net.com", default: false },
] as const;

export type GatewayId = (typeof GATEWAYS)[number]["id"];
