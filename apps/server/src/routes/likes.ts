/**
 * Likes API (#4) — EAS-attested profile/event likes.
 *
 * The chain is authoritative (feedback_client_first_architecture). These
 * routes are a thin verification + projection layer:
 *  - POST /record verifies the attestation ON-CHAIN before caching it; the
 *    attester is read from chain, never trusted from the body. It's a cache
 *    hint, not a trust anchor — the projection is rebuildable from logs.
 *  - GET endpoints serve the fast read cache. In the decentralised end state
 *    these reads move to the chain / EAS indexer / Stylus (#5).
 *
 * Route order: /trending and /following/:address are registered BEFORE
 * /:subjectType/:id so the static prefixes aren't captured as a subjectType.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { SubjectType } from "@woco/shared";
import { getVerifiedLike } from "../lib/likes/eas-onchain.js";
import {
  recordLike, removeLike, getLikeCount, getFollowing, getTrending,
} from "../lib/likes/index-store.js";

export const likesRoutes = new Hono<AppEnv>();

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const isHex32 = (s: unknown): s is string => typeof s === "string" && HEX32.test(s);
const isSubjectType = (n: unknown): n is SubjectType => n === 0 || n === 1;

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// ── Rate limit (server-side; the on-chain gas cap bounds per-key drain, this
//    bounds the funnel). Per parent AND per IP, sliding window. ───────────────
const RECORD_LIMIT = 20; // max like/unlike updates
const RECORD_WINDOW_MS = 60_000; // per minute
const _hits = new Map<string, number[]>();
function allow(bucket: string): boolean {
  const now = Date.now();
  const recent = (_hits.get(bucket) ?? []).filter((t) => now - t < RECORD_WINDOW_MS);
  if (recent.length >= RECORD_LIMIT) {
    _hits.set(bucket, recent);
    return false;
  }
  recent.push(now);
  _hits.set(bucket, recent);
  return true;
}

/**
 * POST /api/likes/record — record (like) or remove (unlike) after the client's
 * on-chain attest/revoke has confirmed. Body: { subject, subjectType, uid, action }.
 */
likesRoutes.post("/record", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as {
    subject?: string; subjectType?: number; uid?: string; action?: string;
  };

  if (!allow(`p:${parent}`) || !allow(`ip:${clientIp(c)}`)) {
    return c.json({ ok: false, error: "Too many like updates — slow down." }, 429);
  }

  const { subject, subjectType, uid, action } = body;
  if (
    !isHex32(subject) || !isHex32(uid) || !isSubjectType(subjectType) ||
    (action !== "like" && action !== "unlike")
  ) {
    return c.json({ ok: false, error: "Invalid request" }, 400);
  }

  // Source of truth: read + validate the attestation on-chain.
  const res = await getVerifiedLike(uid);
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  const like = res.like;

  // Linchpin: the on-chain attester MUST be the authenticated parent.
  if (like.attester !== parent) {
    return c.json({ ok: false, error: "Attester is not the authenticated account" }, 403);
  }
  // Defence-in-depth: the chain-decoded subject must match the client's claim.
  if (like.subject !== subject.toLowerCase() || like.subjectType !== subjectType) {
    return c.json({ ok: false, error: "Subject mismatch" }, 400);
  }

  if (action === "like") {
    if (like.revoked) return c.json({ ok: false, error: "Attestation is revoked on-chain" }, 400);
    await recordLike({
      subject: like.subject, subjectType: like.subjectType,
      attester: like.attester, uid: like.uid,
    });
  } else {
    // unlike — the on-chain attestation must actually be revoked.
    if (!like.revoked) return c.json({ ok: false, error: "Attestation is not revoked on-chain" }, 400);
    await removeLike(like.subject, like.attester);
  }

  return c.json({ ok: true, data: getLikeCount(like.subject, parent) });
});

/** GET /api/likes/trending?subjectType=&limit= — top subjects by count. */
likesRoutes.get("/trending", (c) => {
  const stRaw = c.req.query("subjectType");
  const subjectType = stRaw === undefined ? undefined : Number(stRaw);
  if (subjectType !== undefined && !isSubjectType(subjectType)) {
    return c.json({ ok: false, error: "Invalid subjectType" }, 400);
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  return c.json({ ok: true, data: getTrending(subjectType, limit) });
});

/** GET /api/likes/following/:address — subjects an address likes. */
likesRoutes.get("/following/:address", (c) => {
  const address = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ ok: false, error: "Invalid address" }, 400);
  }
  return c.json({ ok: true, data: getFollowing(address) });
});

/** GET /api/likes/:subjectType/:id?viewer= — count + likedByViewer. */
likesRoutes.get("/:subjectType/:id", (c) => {
  const subjectType = Number(c.req.param("subjectType"));
  const id = c.req.param("id");
  const viewer = c.req.query("viewer");
  if (!isSubjectType(subjectType) || !isHex32(id)) {
    return c.json({ ok: false, error: "Invalid subject" }, 400);
  }
  if (viewer && !/^0x[0-9a-fA-F]{40}$/.test(viewer)) {
    return c.json({ ok: false, error: "Invalid viewer" }, 400);
  }
  return c.json({ ok: true, data: getLikeCount(id, viewer) });
});
