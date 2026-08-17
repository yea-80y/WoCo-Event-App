/**
 * Public read API for Swarm-native social counts and coaster credits.
 *
 * Unauthenticated by design: everything served here is already public on Swarm,
 * and gating a recount behind our auth would make us the thing the evidence
 * manifest exists to avoid depending on.
 *
 * The manifest endpoint is the point of the whole design, not a debug route. It
 * is what lets a reader disbelieve the count productively — recount the leaves,
 * check their own presence, or walk the participant list and rebuild the index
 * without asking us for anything.
 */

import { Hono } from "hono";
import { recountManifest } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { INDEXABLE_FORMATS, indexSubject, type IndexableFormat } from "../lib/social/indexer.js";
import { publishedHint } from "../lib/social/publisher.js";

export const socialRoutes = new Hono<AppEnv>();

const FORMATS = INDEXABLE_FORMATS;
const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

/**
 * A tally costs one versioned feed read per participant, and a stream-day
 * counter is read far more often than it changes. Short enough that a live
 * count still feels live; long enough that a spike does not turn into a
 * per-viewer fan-out of Swarm reads on one bee.
 */
const CACHE_TTL_MS = 30_000;

/**
 * Cache entries retained. The endpoint is unauthenticated and its key includes
 * a caller-supplied subject, so any well-formed bytes32 mints an entry — an
 * unevicted Map would grow for as long as anyone kept asking about subjects
 * that do not exist. Staleness alone never removes anything, so retention has
 * to be explicit.
 */
const CACHE_MAX_ENTRIES = 500;

type Cached = { at: number; value: Awaited<ReturnType<typeof indexSubject>> };
const cache = new Map<string, Cached>();
/** One in-flight tally per subject: without this a burst of misses all start
 *  their own fan-out, which is the read spike the cache exists to prevent. */
const inflight = new Map<string, Promise<Cached["value"]>>();

/**
 * Store a result, dropping expired entries first and then the oldest insertion
 * if still at capacity. A Map iterates in insertion order, so the first key is
 * the least recently ADDED — good enough here, since every entry expires in
 * 30 seconds anyway and the point is a ceiling, not an eviction policy.
 *
 * A tally over ZERO participants is never cached: it is the cheapest possible
 * computation (no reads at all) and it is exactly what an unknown subject
 * produces, so caching it would fill the map with the one result that gains
 * nothing by being remembered.
 */
function remember(key: string, value: Cached["value"]): void {
  if (value.manifest.participants.length === 0) return;

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
    while (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  cache.set(key, { at: Date.now(), value });
}

async function tally(format: IndexableFormat, subject: string): Promise<{ value: Cached["value"]; ageMs: number }> {
  const key = `${format}|${subject}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return { value: hit.value, ageMs: now - hit.at };

  let run = inflight.get(key);
  if (!run) {
    run = indexSubject(format, subject as `0x${string}`)
      .then((value) => {
        remember(key, value);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  return { value: await run, ageMs: 0 };
}

function parseParams(c: { req: { query: (k: string) => string | undefined } }):
  | { ok: true; format: IndexableFormat; subject: string }
  | { ok: false; error: string } {
  const format = c.req.query("format") ?? "";
  const subject = (c.req.query("subject") ?? "").toLowerCase();
  if (!FORMATS.includes(format as IndexableFormat)) {
    return { ok: false, error: `format must be one of ${FORMATS.join(", ")}` };
  }
  if (!SUBJECT_RE.test(subject)) return { ok: false, error: "subject must be a 0x-prefixed lowercase bytes32" };
  return { ok: true, format: format as IndexableFormat, subject };
}

/**
 * The number, plus the two things that qualify it. `unreadable` is not an error
 * state — it is a count computed over an incomplete read, which is the best
 * available answer and must not be presented as a complete one.
 */
socialRoutes.get("/count", async (c) => {
  const p = parseParams(c);
  if (!p.ok) return c.json({ ok: false, error: p.error }, 400);

  try {
    const { value, ageMs } = await tally(p.format, p.subject);
    c.header("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return c.json({
      ok: true,
      data: {
        subject: p.subject,
        format: p.format,
        count: value.manifest.count,
        participants: value.manifest.participants.length,
        contributors: value.manifest.leaves.length,
        unreadable: value.unreadable.length,
        equivocations: value.equivocations,
        ageMs,
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : "tally failed" }, 502);
  }
});

/**
 * The working: input set and per-statement values. Recountable offline.
 *
 * Serves the two qualifiers alongside it — the feeds that could not be read and
 * the holders who equivocated — so this ONE response is everything a reader
 * needs to state the number honestly. They live outside the manifest proper
 * (they are not leaves) but a reader who has to make a second request for
 * "is this count complete?" will not make it, and will publish a floor as a
 * total. `/count` remains the endpoint for a bare number: a widget or an
 * overlay wants the figure, not the evidence.
 */
socialRoutes.get("/manifest", async (c) => {
  const p = parseParams(c);
  if (!p.ok) return c.json({ ok: false, error: p.error }, 400);

  try {
    const { value, ageMs } = await tally(p.format, p.subject);

    // Recount our own manifest before serving it. Circular as a proof and not
    // meant as one — a reader still has to recount independently, which is the
    // point of publishing leaves. What it catches is OUR bug: a tally and a
    // manifest builder that disagree would otherwise ship a headline number the
    // published evidence does not support, and be discovered by a stranger.
    const check = recountManifest(value.manifest);
    if (!check.consistent) {
      console.error(
        `[social] manifest self-check failed for ${p.format} ${p.subject}: ` +
        `declared ${value.manifest.count}, leaves sum to ${check.recounted}`,
      );
      return c.json({ ok: false, error: "manifest failed its own recount" }, 500);
    }

    c.header("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return c.json({
      ok: true,
      data: {
        ...value.manifest,
        unreadable: value.unreadable,
        equivocations: value.equivocations,
        ageMs,
        // Where the same evidence is PUBLISHED (#312) — the feed owner and topic
        // a reader can compute for themselves, plus the version this process
        // last wrote. Returned so a client can go straight to the right chunk
        // instead of probing forward from zero, and so that "read it yourself
        // instead of trusting this response" is one field away rather than a
        // paragraph of documentation. Null when this deployment publishes
        // nothing, which is the honest answer to "where else can I get this".
        published: publishedHint(p.format, p.subject),
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : "tally failed" }, 502);
  }
});

/**
 * Restoring an input set from a published manifest is the rebuild path
 * commitment 6 requires, and it lives on the OPERATOR surface (`/api/ops`),
 * not here.
 *
 * It was briefly a public endpoint on the reasoning that it could not do harm:
 * a participant is only an address whose feed we will read, and every statement
 * found still has to verify. That reasoning was wrong in the dimension that
 * matters — not authenticity, but COST. Each admitted address becomes one
 * versioned feed read on every later tally for that subject, and a read that
 * finds nothing is the most expensive kind this node performs
 * (`swarm/soc.ts:358-367`, the class that overwhelmed the bee node on
 * 2026-07-06). An unauthenticated caller could therefore set the standing price
 * of every subsequent count. Rebuilds are rare and operator-initiated, so the
 * ops surface costs nothing to use.
 *
 * What that closed, precisely: anonymous BULK admission. It is not the only
 * route into the registry — the relay still admits one participant per statement
 * it stamps (see #301) — so this narrowed the surface rather than eliminating it.
 */
export function clearTallyCache(): void {
  cache.clear();
}
