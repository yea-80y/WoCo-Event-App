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
 * One address, one form: expand any IPv6 literal to exactly 8 hextets.
 *
 * A trailing dotted quad occupies the LAST TWO hextets, so it is folded to hex
 * before the elision is expanded — otherwise `::ffff:1.2.3.4` counts as 7 groups
 * and the fill arithmetic is off by one. Doing it here means every later
 * decision reads one canonical shape rather than re-parsing spellings (#221).
 */
function toHextets(addr: string): string[] | null {
  if (!isIPv6(addr)) return null;
  let a = addr;
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (quad) {
    if (!isIPv4(quad[1]!)) return null;
    const o = quad[1]!.split(".").map(Number) as [number, number, number, number];
    a = a.slice(0, quad.index) + (((o[0] << 8) | o[1]) >>> 0).toString(16) + ":" + (((o[2] << 8) | o[3]) >>> 0).toString(16);
  }
  const parts = expandIpv6(a);
  return parts.length === 8 ? parts : null;
}

/**
 * The IPv4 caller behind an IPv4-mapped address, in ANY of its spellings.
 *
 * `::ffff:203.0.113.7`, `::ffff:cb00:7107` and `0:0:0:0:0:ffff:203.0.113.7` are
 * three spellings of one machine. Only the first used to be recognised; the
 * other two fell through to the /64 path and keyed `0:0:0:0::/64` — so the same
 * caller got a different bucket depending on spelling, AND every hex-spelled
 * IPv4 caller in the world collided into that one bucket (`::ffff:102:304` is
 * 1.2.3.4 and `::ffff:506:708` is 5.6.7.8, and both landed there). Recognising
 * the mapped prefix on the canonical hextets instead of on the text fixes both
 * directions at once (#221).
 */
function mappedIpv4(h: string[]): string | null {
  for (let i = 0; i < 5; i++) if (parseInt(h[i]!, 16) !== 0) return null;
  if (parseInt(h[5]!, 16) !== 0xffff) return null;
  const hi = parseInt(h[6]!, 16);
  const lo = parseInt(h[7]!, 16);
  const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  return isIPv4(v4) ? v4 : null;
}

/**
 * Namespace for a value that is not an address we can reduce.
 *
 * Without it the literal keyspace overlaps the normalised one, and the literal
 * `"unknown"` normalised to exactly {@link UNKNOWN_CLIENT} — so a caller could
 * put itself in the shared header-less bucket, or in another caller's, just by
 * choosing what to send. The prefix cannot occur in a dotted quad, a `/64` key,
 * or `UNKNOWN_CLIENT`, so the two keyspaces are now disjoint by construction.
 */
const LITERAL_PREFIX = "raw:";

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

  const hextets = toHextets(addr);
  if (hextets) {
    // An IPv4-mapped address is that IPv4 caller, whichever way it is spelled,
    // and must land in its bucket.
    const mapped = mappedIpv4(hextets);
    if (mapped) return mapped;

    const prefix = hextets
      .slice(0, IPV6_PREFIX_HEXTETS)
      .map((x) => x.replace(/^0+(?=.)/, ""))
      .join(":");
    return `${prefix}::/64`;
  }

  // Not an address we recognise. Bucket on the literal rather than collapsing it
  // into UNKNOWN_CLIENT, so one malformed value cannot share a bucket with the
  // header-less case or with a different malformed value — and namespaced, so it
  // cannot be spelled to land in either.
  return LITERAL_PREFIX + addr;
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
