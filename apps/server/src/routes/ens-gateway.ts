/**
 * `GET /api/ens-gateway/v1/:sender/:data` — the EIP-3668 endpoint Durin's
 * L1Resolver is pointed at. Replaces NameStone's dead `gateway.durin.dev`.
 *
 * This router is deliberately thin: it owns the HTTP shape (status, cache
 * headers, the disabled 503) and nothing else. All the decisions that gate the
 * signing key live in `lib/ens-gateway/ccip.ts`, where they are testable without
 * booting a server.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types.js";
import { createCcipHandler, type CcipHandler } from "../lib/ens-gateway/ccip.js";
import { loadEnsGatewayConfig, ensGatewaySignerAddress } from "../lib/ens-gateway/config.js";
import { readL2ViaRpc } from "../lib/ens-gateway/l2-reader.js";

export type EnsGatewayMount = CcipHandler | { disabled: string };

export function createEnsGatewayRoutes(handlerOrDisabled: EnsGatewayMount): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  if (typeof handlerOrDisabled !== "function") {
    const message = `ENS gateway is not configured: ${handlerOrDisabled.disabled}`;
    app.all("*", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ message }, 503);
    });
    return app;
  }

  app.get("/v1/:sender/:data", async (c) => {
    const out = await handlerOrDisabled(c.req.param("sender"), c.req.param("data"));
    // A signed answer is safe to cache, but only far below the signature's own
    // TTL — a cached response served past `expires` is a hard resolution failure
    // for the client, not a stale-but-usable one.
    c.header("Cache-Control", out.cacheable ? "public, max-age=60" : "no-store");
    return c.json(out.body, out.status as ContentfulStatusCode);
  });

  return app;
}

const loaded = loadEnsGatewayConfig();

if ("disabled" in loaded) {
  console.error(`[ens-gateway] disabled: ${loaded.disabled}`);
} else {
  console.log(
    `[ens-gateway] serving *.${loaded.parentName} — signer=${ensGatewaySignerAddress(loaded)} ` +
    `chain=${loaded.chainId} registry=${loaded.registryAddress} ttl=${loaded.ttlSeconds}s ` +
    `resolvers=${loaded.allowedSenders.join(",")}`,
  );
}

export const ensGatewayRoutes = createEnsGatewayRoutes(
  "disabled" in loaded
    ? loaded
    : createCcipHandler(loaded, { readL2: readL2ViaRpc(loaded.chainId) }),
);

/**
 * Health surface. `configured: false` is not an alarm on its own (the gateway is
 * opt-in), but `signer` is: it must equal `L1Resolver.signer()` on L1, and if it
 * ever changes without that being set, every `*.woco.eth` name stops resolving.
 */
export function ensGatewayStatus(): {
  configured: boolean;
  signer: string | null;
  chainId: number | null;
  registry: string | null;
  parent: string | null;
  reason?: string;
} {
  if ("disabled" in loaded) {
    return {
      configured: false,
      signer: null,
      chainId: null,
      registry: null,
      parent: null,
      reason: loaded.disabled,
    };
  }
  return {
    configured: true,
    signer: ensGatewaySignerAddress(loaded),
    chainId: loaded.chainId,
    registry: loaded.registryAddress,
    parent: loaded.parentName,
  };
}
