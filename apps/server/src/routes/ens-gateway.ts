/**
 * `GET /api/ens-gateway/v1/:sender/:data` — the EIP-3668 endpoint Durin's
 * L1Resolver is pointed at. Replaces NameStone's dead `gateway.durin.dev`.
 *
 * This router is deliberately thin: it owns the HTTP shape (status, cache
 * headers, the disabled 503, the per-IP limit) and nothing else. All the
 * decisions that gate the signing key live in `lib/ens-gateway/ccip.ts`, where
 * they are testable without booting a server.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types.js";
import { createCcipHandler, type CcipHandler } from "../lib/ens-gateway/ccip.js";
import { loadEnsGatewayConfig, ensGatewaySignerAddress } from "../lib/ens-gateway/config.js";
import { createL2Reader, redactRpcUrl } from "../lib/ens-gateway/l2-reader.js";
import { ResponseMemo, memoTtlMsFor } from "../lib/ens-gateway/memo.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { clientIp } from "../lib/http/client-ip.js";

export type EnsGatewayMount = CcipHandler | { disabled: string };

/**
 * Per-IP ceiling for a route whose misses cost an `eth_call` each (#465 §2).
 *
 * A burst window plus a sustained one, because ENS clients arrive in bursts —
 * a page load resolves `addr`, `contenthash` and a handful of `text` records
 * back to back — while nothing legitimate keeps that rate up indefinitely.
 *
 * SIZED WITH ONE EYE ON SHARED RESOLVERS. Public resolution front-ends
 * (`.limo` and friends) query on their users' behalf, so a large share of real
 * traffic can arrive from a small number of addresses; a tight per-IP limit
 * here does not inconvenience a user, it stops every `*.woco.eth` name from
 * resolving for everyone behind that front-end. Hence limits far above human
 * cadence — the memo, not this, is what protects the RPC quota from repeats,
 * and this is what bounds a flood of DISTINCT keys that the memo cannot
 * collapse. Hardcoded rather than env-tunable to match every other limited
 * route in the server and to keep the fail-closed config contract unchanged.
 */
export const ENS_GATEWAY_RATE_WINDOWS = [
  { limit: 120, windowMs: 10_000 },
  { limit: 600, windowMs: 60_000 },
] as const;

export interface EnsGatewayRouteDeps {
  /** Injectable so tests get a fresh bucket set per case instead of sharing module state. */
  limiter?: SlidingWindowLimiter;
}

export function createEnsGatewayRoutes(
  handlerOrDisabled: EnsGatewayMount,
  routeDeps: EnsGatewayRouteDeps = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const limiter = routeDeps.limiter ?? new SlidingWindowLimiter(ENS_GATEWAY_RATE_WINDOWS);

  // Ahead of the disabled/enabled split so a flood is bounded in BOTH postures,
  // and ahead of the memo so the cheap-to-serve repeats still cost a token —
  // the limit bounds total request volume, not just RPC spend.
  app.use("*", async (c, next) => {
    if (!limiter.allow(`ip:${clientIp(c)}`)) {
      c.header("Cache-Control", "no-store");
      return c.json({ message: "rate limited" }, 429);
    }
    await next();
  });

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

const memo = "disabled" in loaded ? null : new ResponseMemo<{ data: string }>(memoTtlMsFor(loaded.ttlSeconds));

if ("disabled" in loaded) {
  console.error(`[ens-gateway] disabled: ${loaded.disabled}`);
} else {
  console.log(
    `[ens-gateway] serving *.${loaded.parentName} — signer=${ensGatewaySignerAddress(loaded)} ` +
    `chain=${loaded.chainId} registry=${loaded.registryAddress} ttl=${loaded.ttlSeconds}s ` +
    `resolvers=${loaded.allowedSenders.join(",")}`,
  );
  // Redacted: provider URLs routinely carry the API key in the path or query.
  const hosts = loaded.rpcUrls.map(redactRpcUrl).join(",");
  if (loaded.rpcUrls.length > 1) {
    console.log(`[ens-gateway] L2 cross-check ON across ${loaded.rpcUrls.length} endpoints: ${hosts}`);
  } else {
    console.warn(
      `[ens-gateway] L2 cross-check OFF — single endpoint ${hosts}. That provider is a trusted ` +
      "party: it can make this gateway sign a wrong record for any subname. Set ENS_GATEWAY_RPC_URL_2 " +
      "to a second, unrelated provider before woco.eth points at this resolver (#465).",
    );
  }
}

export const ensGatewayRoutes = createEnsGatewayRoutes(
  "disabled" in loaded
    ? loaded
    : createCcipHandler(loaded, {
        readL2: createL2Reader(loaded.chainId, loaded.rpcUrls),
        memo: memo ?? undefined,
      }),
);

/**
 * Health surface. `configured: false` is not an alarm on its own (the gateway is
 * opt-in), but `signer` is: it must equal `L1Resolver.signer()` on L1, and if it
 * ever changes without that being set, every `*.woco.eth` name stops resolving.
 *
 * `crossCheck: false` is the #465 §1 posture — one RPC provider is trusted to
 * tell the truth about every subname. It must be `true` before `woco.eth` points
 * at our resolver. Endpoint URLs are NOT reported: they carry provider
 * credentials, and naming our providers on a public endpoint would hand an
 * attacker the "knock one over, lie on the survivor" target list.
 */
export function ensGatewayStatus(): {
  configured: boolean;
  signer: string | null;
  chainId: number | null;
  registry: string | null;
  parent: string | null;
  crossCheck: boolean;
  memoEntries: number;
  reason?: string;
} {
  if ("disabled" in loaded) {
    return {
      configured: false,
      signer: null,
      chainId: null,
      registry: null,
      parent: null,
      crossCheck: false,
      memoEntries: 0,
      reason: loaded.disabled,
    };
  }
  return {
    configured: true,
    signer: ensGatewaySignerAddress(loaded),
    chainId: loaded.chainId,
    registry: loaded.registryAddress,
    parent: loaded.parentName,
    crossCheck: loaded.rpcUrls.length > 1,
    memoEntries: memo?.size() ?? 0,
  };
}
