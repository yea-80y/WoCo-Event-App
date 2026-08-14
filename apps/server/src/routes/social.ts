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
import type { AppEnv } from "../types.js";
import { indexSubject, type IndexableFormat } from "../lib/social/indexer.js";
import { mergeParticipants } from "../lib/social/participants.js";

export const socialRoutes = new Hono<AppEnv>();

const FORMATS: readonly IndexableFormat[] = ["woco.like.v1", "woco.follow.v1", "woco.credit.v1"];
const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

/**
 * A tally costs one versioned feed read per participant, and a stream-day
 * counter is read far more often than it changes. Short enough that a live
 * count still feels live; long enough that a spike does not turn into a
 * per-viewer fan-out of Swarm reads on one bee.
 */
const CACHE_TTL_MS = 30_000;

type Cached = { at: number; value: Awaited<ReturnType<typeof indexSubject>> };
const cache = new Map<string, Cached>();
/** One in-flight tally per subject: without this a burst of misses all start
 *  their own fan-out, which is the read spike the cache exists to prevent. */
const inflight = new Map<string, Promise<Cached["value"]>>();

async function tally(format: IndexableFormat, subject: string): Promise<{ value: Cached["value"]; ageMs: number }> {
  const key = `${format}|${subject}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return { value: hit.value, ageMs: now - hit.at };

  let run = inflight.get(key);
  if (!run) {
    run = indexSubject(format, subject as `0x${string}`)
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
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

/** The working: input set and per-statement values. Recountable offline. */
socialRoutes.get("/manifest", async (c) => {
  const p = parseParams(c);
  if (!p.ok) return c.json({ ok: false, error: p.error }, 400);

  try {
    const { value } = await tally(p.format, p.subject);
    c.header("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return c.json({ ok: true, data: { ...value.manifest, unreadable: value.unreadable } });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : "tally failed" }, 502);
  }
});

/**
 * Restore an input set from a published manifest — the rebuild path commitment
 * 6 requires. Unauthenticated because it cannot do harm: a participant is only
 * an address whose feed we will READ, every statement found there still has to
 * verify, and an address with nothing to say contributes nothing. The worst a
 * caller achieves is making us do reads that return nothing.
 */
socialRoutes.post("/participants", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const b = body as { format?: string; subject?: string; participants?: unknown };
  if (!FORMATS.includes(b.format as IndexableFormat)) {
    return c.json({ ok: false, error: "unknown format" }, 400);
  }
  if (typeof b.subject !== "string" || !SUBJECT_RE.test(b.subject.toLowerCase())) {
    return c.json({ ok: false, error: "subject must be a 0x-prefixed bytes32" }, 400);
  }
  if (!Array.isArray(b.participants) || b.participants.some((p) => typeof p !== "string")) {
    return c.json({ ok: false, error: "participants must be an array of addresses" }, 400);
  }
  if (b.participants.length > 10_000) {
    return c.json({ ok: false, error: "too many participants in one call" }, 413);
  }

  const added = mergeParticipants(b.format!, b.subject.toLowerCase(), b.participants as string[]);
  cache.clear();
  return c.json({ ok: true, data: { added } });
});
