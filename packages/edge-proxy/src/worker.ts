/**
 * WoCo Edge Proxy — Cloudflare Worker
 *
 * Maps custom domains to Swarm-hosted event sites.
 *
 * Flow:
 *   1. Visitor hits events.mycompany.com (CNAME → sites.woco-net.com)
 *   2. Worker intercepts, looks up hostname → contentHash via WoCo API
 *   3. Proxies the request to gateway.ethswarm.org/bzz/{contentHash}/{path}
 *   4. Returns the Swarm content to the visitor
 *
 * Caching:
 *   - KV cache: domain → contentHash (5 minute TTL)
 *   - Falls back to WoCo API if KV miss
 */

interface Env {
  WOCO_API_URL: string;
  SWARM_GATEWAY: string;
  DOMAINS?: KVNamespace;
}

const CACHE_TTL_SECONDS = 300; // 5 minutes

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    // Health check
    if (url.pathname === "/_health") {
      return new Response(JSON.stringify({ ok: true, hostname }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Look up domain → content hash
    const resolved = await resolveDomain(hostname, env);
    if (!resolved) {
      return new Response(
        `<html><body style="font-family:system-ui;text-align:center;padding:4rem;background:#09090f;color:#e0e0e0;">
          <h1>Domain not configured</h1>
          <p>${hostname} is not linked to any WoCo event site.</p>
          <p style="color:#6a6a80;margin-top:2rem;">
            <a href="https://woco.eth.limo" style="color:#7c6cf0;">Set up your event at woco.eth.limo</a>
          </p>
        </body></html>`,
        { status: 404, headers: { "Content-Type": "text/html" } },
      );
    }

    // Build Swarm gateway URL
    const path = url.pathname === "/" ? "" : url.pathname;
    const swarmUrl = `${env.SWARM_GATEWAY}/bzz/${resolved.contentHash}${path}${url.search}`;

    try {
      const swarmResp = await fetch(swarmUrl, {
        headers: {
          "Accept": request.headers.get("Accept") || "*/*",
          "Accept-Encoding": request.headers.get("Accept-Encoding") || "",
        },
      });

      // Clone response and add CORS + cache headers
      const headers = new Headers(swarmResp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("X-WoCo-Event", resolved.contentHash);

      // Cache static assets aggressively, HTML less so
      const contentType = headers.get("Content-Type") || "";
      if (contentType.includes("text/html")) {
        headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
      } else if (
        contentType.includes("javascript") ||
        contentType.includes("css") ||
        contentType.includes("image") ||
        contentType.includes("font")
      ) {
        headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800");
      }

      return new Response(swarmResp.body, {
        status: swarmResp.status,
        headers,
      });
    } catch (err) {
      return new Response("Failed to fetch from Swarm gateway", { status: 502 });
    }
  },
};

// ---------------------------------------------------------------------------
// Domain resolution with KV caching
// ---------------------------------------------------------------------------

interface ResolveResult {
  contentHash: string;
  feedManifestHash: string;
}

async function resolveDomain(
  hostname: string,
  env: Env,
): Promise<ResolveResult | null> {
  // Try KV cache first
  if (env.DOMAINS) {
    const cached = await env.DOMAINS.get(hostname, "json");
    if (cached) return cached as ResolveResult;
  }

  // Fall back to WoCo API
  try {
    const resp = await fetch(
      `${env.WOCO_API_URL}/api/domains/resolve/${encodeURIComponent(hostname)}`,
    );
    if (!resp.ok) return null;

    const json = (await resp.json()) as {
      ok: boolean;
      data?: ResolveResult;
    };

    if (!json.ok || !json.data) return null;

    // Cache in KV
    if (env.DOMAINS) {
      await env.DOMAINS.put(hostname, JSON.stringify(json.data), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    }

    return json.data;
  } catch {
    return null;
  }
}
