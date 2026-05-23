import type { MiddlewareHandler } from "hono";
import { getDomainByHostname, markDomainVerified } from "../lib/domains/service.js";
import { PROXY_URL } from "../config/swarm.js";

const WOCO_HOSTS = new Set([
  "events-api.woco-net.com",
  "gateway.woco-net.com",
  "localhost",
  "127.0.0.1",
]);

export const customDomainProxy: MiddlewareHandler = async (c, next) => {
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();

  if (!host || WOCO_HOSTS.has(host) || host.endsWith(".woco-net.com")) {
    return next();
  }

  const entry = await getDomainByHostname(host);
  if (!entry || entry.deactivated) return next();

  // DNS pointing to us = proof of ownership; mark verified on first traffic
  if (!entry.verified) {
    await markDomainVerified(host);
  }

  const url = new URL(c.req.url);
  const target = `${PROXY_URL}/bzz/${entry.contentHash}${url.pathname}${url.search}`;

  try {
    const resp = await fetch(target, {
      headers: { Accept: c.req.header("accept") ?? "*/*" },
    });
    const headers = new Headers(resp.headers);
    headers.delete("content-encoding"); // Hono re-encodes; avoid double-gzip
    return new Response(resp.body, { status: resp.status, headers });
  } catch {
    return c.text("Failed to fetch site content", 502);
  }
};
