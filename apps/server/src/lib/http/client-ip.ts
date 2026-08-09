/**
 * The identity every rate limiter buckets on (#179).
 *
 * Nine call sites derived this independently and disagreed, which is how three of
 * them ended up trusting a value the caller controls. One helper, so the next
 * limiter cannot invent a tenth answer.
 *
 * WHY THERE IS NO X-FORWARDED-FOR FALLBACK
 *
 * Verified against Cloudflare's published behaviour, because the textbook answer
 * is wrong for this deployment in both directions:
 *
 *  - The edge APPENDS the connecting address to whatever `X-Forwarded-For` the
 *    client sent, rather than replacing it. So `xff[0]` is caller-authored — that
 *    is the defect, and it is why reading it first defeated the limiter even at
 *    the sites that also read `cf-connecting-ip` as a fallback.
 *  - `cloudflared` then appends the visitor address at the END of that chain
 *    (cloudflare/cloudflared#1426). So the rightmost entry is the real client, NOT
 *    the tunnel — the "every caller collapses into one bucket" concern that argued
 *    against a rightmost-entry rule does not apply here.
 *
 * Which leaves no reason to read the header at all: its first entry is forgeable
 * and its last is a redundant copy of one the edge already guarantees. A fallback
 * would add a parsing surface and a second way to be wrong, for nothing.
 *
 * `cf-connecting-ip` is set by the edge and overwrites anything the client sends.
 * That is what makes it usable — but note the property is NETWORK-level, not a
 * property of the header: it holds because the origin binds loopback and is
 * reachable only through the tunnel. If the origin ever gains a second ingress,
 * this header becomes caller-supplied like any other and this file's premise
 * fails. That is the thing to re-check, not the header choice.
 */

import { isIPv4, isIPv6 } from "node:net";

/**
 * Bucket key for callers that arrive without the edge header.
 *
 * Verified against the DEPLOYED stack, `deploy/docker-compose.yml` — the one the
 * ops runbook mirrors to /opt/woco. Its `server` service binds
 * `127.0.0.1:3001:3001` and declares no healthcheck, and `apps/server/Dockerfile`
 * has no HEALTHCHECK either, so nothing reaches the origin except through the
 * tunnel. This bucket should therefore be empty on every route, not merely on the
 * limited ones, and {@link clientIp} logs when it is not.
 *
 * NOT `docker-compose.yml` at the repo root — an earlier version of this comment
 * cited it, and it is the wrong artefact twice over: it is not deployed, and it
 * publishes `3001:3001` on ALL interfaces, which would make the loopback premise
 * below false rather than support it. If that file ever becomes a deployment, or
 * a second ingress is added, the premise this module rests on is what breaks —
 * re-check it there, not in the header handling.
 *
 * Kept as a shared bucket rather than a refusal for now: refusing would change
 * what those routes return, and the case for it rests on "nothing legitimate
 * arrives here", which the log is there to confirm before acting on. Once it is
 * confirmed silent, refusing is the stronger answer — see #179.
 */
export const UNKNOWN_CLIENT = "unknown";

/** IPv6 addresses are allocated to end sites in blocks; bucket on the block. */
const IPV6_PREFIX_HEXTETS = 4; // /64

function expandIpv6(addr: string): string[] {
  const [head = "", tail = ""] = addr.split("::", 2);
  const hasElision = addr.includes("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (!hasElision) return h.map((x) => x || "0");
  const fill = Math.max(0, 8 - h.length - t.length);
  return [...h, ...new Array(fill).fill("0"), ...t].map((x) => x || "0");
}

/**
 * Reduce an address to the unit a single caller controls.
 *
 * Without this one caller holds many buckets for free. An end site is routinely
 * allocated a whole IPv6 /64 or wider, so bucketing on the full address lets the
 * low bits be varied at will; and the same address has several textual forms
 * (case, `::` elision, a `%zone` suffix, an IPv4-mapped `::ffff:` wrapper), each
 * of which would key a different bucket while naming the same machine.
 */
export function normaliseClientIp(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return UNKNOWN_CLIENT;

  // A zone index is local to the host that emitted it and never identifies a
  // remote caller.
  const addr = trimmed.split("%")[0];
  if (isIPv4(addr)) return addr;

  // An IPv4-mapped address is that IPv4 caller, and must land in its bucket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped && isIPv4(mapped[1])) return mapped[1];

  if (isIPv6(addr)) {
    const hextets = expandIpv6(addr);
    if (hextets.length >= IPV6_PREFIX_HEXTETS) {
      const prefix = hextets
        .slice(0, IPV6_PREFIX_HEXTETS)
        .map((x) => x.replace(/^0+(?=.)/, ""))
        .join(":");
      return `${prefix}::/64`;
    }
  }

  // Not an address we recognise. Bucket on the literal rather than collapsing it
  // into UNKNOWN_CLIENT, so one malformed value cannot share a bucket with the
  // header-less case or with a different malformed value.
  return addr;
}

/**
 * The rate-limit identity for this request.
 *
 * Returns {@link UNKNOWN_CLIENT} when the edge header is absent — callers wanting
 * a distinct allowance for that shared bucket should compare against the constant
 * rather than re-deriving the string.
 */
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const edge = c.req.header("cf-connecting-ip")?.trim();
  if (!edge) {
    // Should be unreachable on a rate-limited route; see UNKNOWN_CLIENT.
    if (process.env.NODE_ENV === "production") {
      console.warn("[client-ip] request on a rate-limited route with no cf-connecting-ip");
    }
    return UNKNOWN_CLIENT;
  }
  return normaliseClientIp(edge);
}
