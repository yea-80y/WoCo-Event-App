import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { RECOVERY_STATUS_VERSION } from "@woco/shared";
import { getRecoveryEnvelope, putRecoveryStatus, getRecoveryStatus } from "../lib/recovery/service.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";

export const recovery = new Hono<AppEnv>();

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// ── Rate limits (#176) ────────────────────────────────────────────────────────
// Both POST routes make an unconditional, non-deferred platform-batch feed write
// per call (the presence doc), and a free passkey account can loop them. Authentication is not a cost here, so the
// limiter is: per verified parent (the binding key — a protect ceremony is one
// call, and a user adding a few backups in a sitting is a handful) AND per client
// IP (a looser secondary bound, because a venue NAT is one IP).
const RECOVERY_WRITE_PARENT = new SlidingWindowLimiter([
  { limit: 6, windowMs: 60_000 },
  { limit: 20, windowMs: 60 * 60_000 },
]);
const RECOVERY_WRITE_IP = new SlidingWindowLimiter([
  { limit: 30, windowMs: 60_000 },
  { limit: 120, windowMs: 60 * 60_000 },
]);
// The public reads cost a bee feed read each. Same order as the directory's read
// limiter (events.ts), per IP.
const RECOVERY_READ_IP = new SlidingWindowLimiter([{ limit: 120, windowMs: 60_000 }]);
// Bodies here are empty or a single flag — a cap well above that keeps a caller
// from making the auth middleware read and hash megabytes.
const RECOVERY_MAX_BODY_BYTES = 8 * 1024;

function writeLimited(c: { req: { header: (n: string) => string | undefined } }, parentAddress: string): boolean {
  // Peek both, then record both: a request refused on the IP bucket is not
  // charged to the parent bucket (and vice versa).
  const pk = `p:${parentAddress}`;
  const ik = `ip:${clientIp(c)}`;
  if (!RECOVERY_WRITE_PARENT.peek(pk) || !RECOVERY_WRITE_IP.peek(ik)) return true;
  RECOVERY_WRITE_PARENT.record(pk);
  RECOVERY_WRITE_IP.record(ik);
  return false;
}
function readLimited(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return !RECOVERY_READ_IP.allow(`ip:${clientIp(c)}`);
}

// POST /api/recovery/escrow — authenticated. §13: the sealed escrow itself is a
// GUARDIAN-owned SOC the client signs + uploads directly (`/api/swarm/soc`), and
// since #157 so is the guardian→account auto-find index. This endpoint records
// ONLY the untrusted platform PRESENCE hint (kernel→"protected") that the setup
// screen renders when the chain is unreadable. It takes no body fields: the
// kernelAddress is the verified session parent, and the guardian + label that
// used to be stored here were a public linkage leak.
recovery.post("/escrow", jsonBodyLimit(RECOVERY_MAX_BODY_BYTES), requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  if (writeLimited(c, parentAddress)) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    // A user can only write their own (parent-stamped) doc. Holds no escrow/key.
    await putRecoveryStatus(parentAddress, {
      v: RECOVERY_STATUS_VERSION,
      configured: true,
      updatedAt: Date.now(),
    });
    return c.json({ ok: true, data: { kernelAddress: parentAddress } });
  } catch (err) {
    console.error("[api] putRecoveryStatus error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to record recovery hint: ${msg}` }, 500);
  }
});

// POST /api/recovery/escrow/clear — authenticated. The mirror of /escrow, run after
// the account proved on-chain that it changed its recovery route (#165, #164).
//
//  - REMOVE ALL (default): flip the presence hint to not-configured.
//  - REVOKE ONE (`keepStatus: true`): the account still HAS working backups, so
//    the presence hint must stay — flipping it would make the portal's
//    chain-unreadable fallback tell a protected user "no backup found". Nothing
//    to do here then; the route answers ok so the client's bookkeeping is uniform.
//
// There are no auto-find tombstones any more: the guardian-owned index cannot be
// edited without the backup wallet, and the portal filters a stale entry by
// asking the chain whether this guardian still protects the account (#157).
//
// It clears a HINT ONLY. The revoke itself is the client's sudo userOp; a server
// that could turn recovery off by itself would be a new attack surface.
recovery.post("/escrow/clear", jsonBodyLimit(RECOVERY_MAX_BODY_BYTES), requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  if (writeLimited(c, parentAddress)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const body = (c.get("body") ?? {}) as { keepStatus?: unknown };
  // Anything but literal `true` is the remove-all shape.
  const keepStatus = body.keepStatus === true;
  try {
    if (!keepStatus) {
      await putRecoveryStatus(parentAddress, {
        v: RECOVERY_STATUS_VERSION,
        configured: false,
        updatedAt: Date.now(),
      });
    }
    return c.json({ ok: true, data: { kernelAddress: parentAddress, statusFlipped: !keepStatus } });
  } catch (err) {
    console.error("[api] clear recovery hint error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to clear recovery hint: ${msg}` }, 500);
  }
});

// GET /api/recovery/status/:kernelAddress — PUBLIC presence hint (§13). Returns
// `{ v, configured, updatedAt }`, or a synthesised {configured:true} for LEGACY
// accounts whose envelope still sits on the old platform feed. Untrusted
// convenience: real recoverability is proven only by decrypting the guardian SOC.
// It says nothing about WHO the guardian is (#157) — a public Kernel address must
// not resolve to its backup wallet in one call.
recovery.get("/status/:kernelAddress", async (c) => {
  const kernelAddress = c.req.param("kernelAddress");
  if (!ADDR_RE.test(kernelAddress)) {
    return c.json({ ok: false, error: "Invalid kernelAddress" }, 400);
  }
  if (readLimited(c)) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const status = await getRecoveryStatus(kernelAddress);
    if (status) {
      // Project, never forward: a doc written before #157 carries the guardian
      // and label, and this endpoint must not hand them out.
      return c.json({ ok: true, data: { v: status.v, configured: status.configured, updatedAt: status.updatedAt } });
    }
    const legacy = await getRecoveryEnvelope(kernelAddress);
    return c.json({ ok: true, data: legacy ? { v: RECOVERY_STATUS_VERSION, configured: true } : null });
  } catch (err) {
    console.error("[api] getRecoveryStatus error:", err);
    return c.json({ ok: false, error: "Failed to load recovery status" }, 500);
  }
});

// GET /api/recovery/escrow/:kernelAddress — PUBLIC, LEGACY (§13). New escrows live
// in a guardian-owned SOC read directly by the client; this returns the old
// platform-signed envelope and exists ONLY as the recovery read-fallback for
// accounts protected before the migration. Ciphertext to the guardian, so public
// read is safe by design (§11.6).
recovery.get("/escrow/:kernelAddress", async (c) => {
  const kernelAddress = c.req.param("kernelAddress");
  if (!ADDR_RE.test(kernelAddress)) {
    return c.json({ ok: false, error: "Invalid kernelAddress" }, 400);
  }
  if (readLimited(c)) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const envelope = await getRecoveryEnvelope(kernelAddress);
    return c.json({ ok: true, data: envelope });
  } catch (err) {
    console.error("[api] getRecoveryEnvelope error:", err);
    return c.json({ ok: false, error: "Failed to load recovery envelope" }, 500);
  }
});
