import { Hono } from "hono";
import { isError } from "ethers";
import { requireAuth } from "../middleware/auth.js";
import {
  isLabelAvailable,
  getLabelOwner,
  mintSubEnsName,
  updateSubEnsContenthash,
} from "../lib/chain/sub-ens-contract.js";
import type { AppEnv } from "../types.js";

export const subEnsRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Mirror of WoCoRegistrar._validLabel — server-side fast path before hitting the chain. */
function validateLabel(label: string): string | null {
  if (label.length < 3 || label.length > 63) return "label must be 3–63 characters";
  if (!/^[a-z0-9]/.test(label))              return "label must start with a letter or digit";
  if (!/[a-z0-9]$/.test(label))              return "label must end with a letter or digit";
  if (!/^[a-z0-9-]+$/.test(label))           return "label may only contain a–z, 0–9, and hyphens";
  if (label.includes("--"))                   return "label cannot contain consecutive hyphens";
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/sub-ens/check/:label
 * Public — no auth. Returns { available: boolean, reason? }.
 */
subEnsRoutes.get("/check/:label", async (c) => {
  const label = c.req.param("label").toLowerCase().trim();

  const validationError = validateLabel(label);
  if (validationError) {
    return c.json({ ok: true, data: { available: false, reason: validationError } });
  }

  try {
    const available = await isLabelAvailable(label);
    return c.json({ ok: true, data: { available } });
  } catch (err) {
    console.error("[sub-ens] availability check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }
});

/**
 * POST /api/sub-ens/claim
 * Auth required. Mints label.woco.eth to the authenticated organiser on Arbitrum.
 *
 * Body: { label: string, swarmHash?: string, description?: string, avatar?: string }
 *
 * - label: the sub-ENS label (e.g. "punkpub")
 * - swarmHash: 64-char hex Swarm BZZ hash of the deployed site (no 0x prefix); optional at claim time
 * - description, avatar: optional ENS text records set in the same tx
 */
subEnsRoutes.post("/claim", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = await c.req.json<{
    label: string;
    swarmHash?: string;
    description?: string;
    avatar?: string;
  }>();

  const label = body.label?.toLowerCase()?.trim();
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);

  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  if (body.swarmHash) {
    const clean = body.swarmHash.replace(/^0x/, "");
    if (!/^[a-f0-9]{64}$/.test(clean)) {
      return c.json({ ok: false, error: "swarmHash must be a 64-char hex string" }, 400);
    }
  }

  // Build ENS text records from optional profile fields
  const textKeys: string[] = [];
  const textValues: string[] = [];
  if (body.description?.trim()) { textKeys.push("description"); textValues.push(body.description.trim()); }
  if (body.avatar?.trim())      { textKeys.push("avatar");      textValues.push(body.avatar.trim()); }

  // Pre-flight availability check for a clean user-facing error (contract also guards this)
  try {
    const available = await isLabelAvailable(label);
    if (!available) return c.json({ ok: false, error: "label already taken" }, 409);
  } catch (err) {
    console.error("[sub-ens] pre-flight check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }

  try {
    const txHash = await mintSubEnsName(
      label,
      parentAddress,
      body.swarmHash?.replace(/^0x/, "") ?? null,
      textKeys,
      textValues,
    );
    return c.json({
      ok: true,
      data: { label, ensName: `${label}.woco.eth`, txHash },
    });
  } catch (err: unknown) {
    // Decode ethers v6 custom errors (requires error defs in REGISTRAR_ABI)
    if (isError(err, "CALL_EXCEPTION")) {
      const name = (err as { revert?: { name?: string } }).revert?.name;
      if (name === "LabelIsReserved")     return c.json({ ok: false, error: "label is reserved" }, 409);
      if (name === "InvalidLabel")        return c.json({ ok: false, error: "invalid label" }, 400);
      if (name === "NotAuthorisedSponsor") {
        console.error("[sub-ens] sponsor wallet not authorised on registrar");
        return c.json({ ok: false, error: "name registration temporarily unavailable" }, 503);
      }
    }
    // Race condition: another request registered the label between our check and the tx
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NotAvailable")) return c.json({ ok: false, error: "label already taken" }, 409);

    console.error("[sub-ens] claim failed:", err);
    return c.json({ ok: false, error: "claim failed" }, 500);
  }
});

/**
 * POST /api/sub-ens/set-contenthash
 * Auth required. Updates the Swarm pointer for label.woco.eth after a site redeploy.
 * Called internally by sites.ts deploy route; also available externally for admin/CLI.
 *
 * Body: { label: string, swarmHash: string }
 */
subEnsRoutes.post("/set-contenthash", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = await c.req.json<{ label: string; swarmHash: string }>();

  const label = body.label?.toLowerCase()?.trim() ?? "";
  const swarmHash = (body.swarmHash ?? "").replace(/^0x/, "").trim();

  if (!label) return c.json({ ok: false, error: "label is required" }, 400);
  if (!swarmHash) return c.json({ ok: false, error: "swarmHash is required" }, 400);
  if (!/^[a-f0-9]{64}$/.test(swarmHash)) {
    return c.json({ ok: false, error: "swarmHash must be a 64-char hex string" }, 400);
  }

  // Ownership check — verify the authenticated organiser owns this label on-chain.
  // The sponsor wallet is authorised to update ANY label's contenthash, so this
  // server-side guard is the only thing preventing cross-organiser overwrite (IDOR).
  const owner = await getLabelOwner(label);
  if (!owner) return c.json({ ok: false, error: "label not found" }, 404);
  if (owner !== parentAddress.toLowerCase()) {
    return c.json({ ok: false, error: "not authorised for this label" }, 403);
  }

  try {
    const txHash = await updateSubEnsContenthash(label, swarmHash);
    return c.json({ ok: true, data: { label, txHash } });
  } catch (err: unknown) {
    if (isError(err, "CALL_EXCEPTION")) {
      const name = (err as { revert?: { name?: string } }).revert?.name;
      if (name === "EmptyContenthash") return c.json({ ok: false, error: "swarmHash is empty" }, 400);
    }
    console.error("[sub-ens] set-contenthash failed:", err);
    return c.json({ ok: false, error: "update failed" }, 500);
  }
});
