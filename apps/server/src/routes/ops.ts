/**
 * /api/ops — operator surface for the undelivered-email ledger.
 *
 * `/api/health` reports that N transactional sends were abandoned. Until now
 * the only way to learn WHO, or to mark one handled, was to read and edit
 * `.data/email-failures.json` over SSH — so remediating a paid-but-undelivered
 * ticket meant hand-editing a compliance store on a production VM
 * (docs/SES_MIGRATION_HANDOVER.md §4a row 11).
 *
 * AUTH is a bearer token, not the wallet session delegation every other write
 * endpoint uses. Deliberate: this is platform operations, not an organiser
 * action, and there is no operator identity in the auth model to hang it off.
 * `OPS_TOKEN` unset means the routes REFUSE, never open — a fail-open ops
 * surface over the one store holding buyer plaintext is not a trade worth
 * making for convenience.
 *
 * The LIST never carries plaintext. Addresses come one entry at a time from
 * `/:id/recipients`, and every such fetch is logged. An operator triaging an
 * incident polls the list; if that response streamed every buyer address, the
 * routine act would be the disclosing one. Chasing a specific buyer is the
 * deliberate act, so it is the one that costs an extra request.
 *
 * A bad token gets 404, not 401. There is nothing to be gained by confirming to
 * an unauthenticated caller that an operator surface exists here at all.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../types.js";
import {
  failureHealth,
  listFailures,
  resolveFailure,
  type EmailFailure,
} from "../lib/email/failure-ledger.js";
import { forgetRetries } from "../lib/email/retry-queue.js";

const ops = new Hono<AppEnv>();

/** Constant-time even when the lengths differ — `timingSafeEqual` throws on those. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Guess-throttling that CANNOT lock out the real operator.
 *
 * The first version counted failures before checking the token, so ten bad
 * requests a minute shut the door on everyone — an unauthenticated attacker
 * could disable the remediation surface during exactly the incident it exists
 * for. A 32-byte token is not brute-forceable over HTTP anyway; what the
 * counter is really for is the log line that says somebody is trying.
 *
 * So: a valid token always passes and resets the counter. An invalid one pays a
 * delay that grows with recent failures, which makes guessing expensive without
 * making the endpoint deniable.
 */
const FAILED_ATTEMPT_WINDOW_MS = 60_000;
const MAX_PENALTY_MS = 2_000;
let failedAttempts: number[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const requireOpsToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const notFound = () => c.json({ ok: false, error: "Not found" }, 404);

  const expected = process.env.OPS_TOKEN || "";
  if (!expected) {
    console.error("[ops] OPS_TOKEN is not set — refusing the request");
    return notFound();
  }

  const header = c.req.header("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const now = Date.now();
  failedAttempts = failedAttempts.filter((t) => now - t < FAILED_ATTEMPT_WINDOW_MS);

  if (presented && tokenMatches(presented, expected)) {
    failedAttempts = [];
    await next();
    return;
  }

  failedAttempts.push(now);
  // Never log the presented value: it would put a near-miss of the real token,
  // or the real token itself after a copy-paste slip, into the docker logs.
  console.warn(
    `[ops] Rejected a request with a bad or missing operator token ` +
      `(${failedAttempts.length} in the last minute)`,
  );
  await sleep(Math.min(MAX_PENALTY_MS, failedAttempts.length * 100));
  return notFound();
};

ops.use("*", requireOpsToken);

/** Strip the plaintext addresses, keeping everything an operator can triage on. */
function redact(entry: EmailFailure): EmailFailure {
  return { ...entry, recipients: entry.recipients.map(({ hash }) => ({ hash })) };
}

/**
 * GET /api/ops/email-failures
 *
 * Unresolved entries newest-first by default, ALWAYS redacted.
 * `?includeResolved=1` for the full record, `?limit=` to bound the response.
 */
ops.get("/email-failures", (c) => {
  const includeResolved = c.req.query("includeResolved") === "1";
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;

  const rows = listFailures({ includeResolved, limit });
  return c.json({
    ok: true,
    data: { health: failureHealth(), count: rows.length, entries: rows.map(redact) },
  });
});

/**
 * GET /api/ops/email-failures/:id/recipients
 *
 * The buyer's actual address, for the one entry being chased. Separate from the
 * list so that reading plaintext is always a distinct, logged act rather than a
 * side effect of looking at the queue.
 *
 * An entry whose plaintext was redacted under Art. 17 returns an empty list, not
 * an error: the record still exists, the address deliberately does not.
 */
ops.get("/email-failures/:id/recipients", (c) => {
  const id = c.req.param("id");
  const entry = listFailures({ includeResolved: true, limit: Number.MAX_SAFE_INTEGER }).find(
    (e) => e.id === id,
  );
  if (!entry) return c.json({ ok: false, error: "No such ledger entry" }, 404);

  console.warn(
    `[ops] Operator read plaintext recipients for ledger entry ${id} ` +
      `(${entry.kind}, ${entry.recipients.length} addressee(s))`,
  );
  return c.json({
    ok: true,
    data: {
      id: entry.id,
      kind: entry.kind,
      subject: entry.subject,
      // Marketing entries never held one; a redacted transactional entry no
      // longer does. Both come back as hash-only rather than as an error.
      recipients: entry.recipients,
      ...(entry.context ? { context: entry.context } : {}),
    },
  });
});

/**
 * POST /api/ops/email-failures/:id/resolve
 *
 * Marks one entry handled — the buyer was contacted, the ticket resent by hand,
 * or the address is dead. This is what clears `email.undelivered.ok: false` on
 * `/api/health`, so `by` is required: an alarm cleared by nobody in particular
 * is an alarm nobody owns.
 */
ops.post("/email-failures/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { by?: string } | null;
  const by = (body?.by || "").trim().slice(0, 100);
  if (!by) {
    return c.json({ ok: false, error: "`by` is required — who actioned this?" }, 400);
  }

  const resolved = resolveFailure(id, by);
  if (!resolved) {
    // Already resolved and not found are the same answer on purpose: either way
    // there is nothing left for the operator to do with this id.
    return c.json({ ok: false, error: "No unresolved entry with that id" }, 404);
  }

  // Drop any queued automatic retry: the operator has just said this is
  // handled, and a backoff timer firing afterwards would re-send mail they may
  // already have sent by hand. The worker re-reads the ledger for the same
  // reason, covering the window where an item has already left the queue.
  forgetRetries(id);

  console.log(`[ops] Ledger entry ${id} marked resolved by ${by}`);
  return c.json({ ok: true, data: { resolved: true, health: failureHealth() } });
});

/** Tests only — clears the failed-attempt window between cases. */
export function _resetOpsLockoutForTest(): void {
  failedAttempts = [];
}

export { ops };
