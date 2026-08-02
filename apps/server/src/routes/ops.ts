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
 * Plaintext addresses are withheld unless `?reveal=1` is passed explicitly, and
 * every reveal is logged. The token alone should not turn an idle `curl` into a
 * dump of every buyer address we hold; remediation is a deliberate act and can
 * afford a deliberate flag.
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

const ops = new Hono<AppEnv>();

/** Constant-time even when the lengths differ — `timingSafeEqual` throws on those. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const requireOpsToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = process.env.OPS_TOKEN || "";
  if (!expected) {
    console.error("[ops] OPS_TOKEN is not set — refusing the request");
    return c.json(
      { ok: false, error: "Operator endpoints are not configured", code: "OPS_DISABLED" },
      503,
    );
  }
  const header = c.req.header("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !tokenMatches(presented, expected)) {
    console.warn("[ops] Rejected a request with a bad or missing operator token");
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }
  await next();
};

ops.use("*", requireOpsToken);

/** Strip the plaintext addresses, keeping everything an operator can triage on. */
function redact(entry: EmailFailure): EmailFailure {
  return { ...entry, recipients: entry.recipients.map(({ hash }) => ({ hash })) };
}

/**
 * GET /api/ops/email-failures
 *
 * Unresolved entries newest-first by default. `?includeResolved=1` for the full
 * record, `?reveal=1` to include the buyer's address (needed to actually chase
 * a ticket), `?limit=` to bound the response.
 */
ops.get("/email-failures", (c) => {
  const includeResolved = c.req.query("includeResolved") === "1";
  const reveal = c.req.query("reveal") === "1";
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;

  const rows = listFailures({ includeResolved, limit });
  if (reveal) {
    const withPlaintext = rows.filter((e) => e.recipients.some((r) => r.address)).length;
    // Access to buyer addresses is a disclosure event; leave a trail of it.
    console.warn(
      `[ops] Operator revealed plaintext recipients on ${withPlaintext} of ${rows.length} ledger entries`,
    );
  }

  return c.json({
    ok: true,
    data: {
      health: failureHealth(),
      count: rows.length,
      entries: reveal ? rows : rows.map(redact),
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

  console.log(`[ops] Ledger entry ${id} marked resolved by ${by}`);
  return c.json({ ok: true, data: { resolved: true, health: failureHealth() } });
});

export { ops };
