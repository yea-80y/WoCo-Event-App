import { Hono } from "hono";
import { isError } from "ethers";
import { requireAuth } from "../middleware/auth.js";
import {
  isLabelAvailable,
  getLabelOwner,
  getOwnedLabels,
  mintSubEnsName,
  updateSubEnsContenthash,
  signSubEnsPermit,
  getRegistrarAddress,
  getSubEnsChainId,
  getMintAllowance,
  mintRateCapVerdict,
} from "../lib/chain/sub-ens-contract.js";
import { isProfileName, profileNameOf } from "../lib/profile/name-ledger.js";
import { stampEventSubEns } from "../lib/event/service.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import type { AppEnv } from "../types.js";

// Preview links resolve through the WoCo gateway (eth.limo .woco.eth resolution is
// parked until the mainnet resolver cutover — see SUB_ENS_ARBITRUM_PLAN.md).
const PREVIEW_GATEWAY = "https://gateway.woco-net.com";

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

/**
 * `/check` is the only sub-ENS read with no auth and no limit, and every render
 * of a name now goes through it (display verification, plan doc §3 point F). It
 * costs an RPC call, and the display rule is FAIL-CLOSED — so an attacker who
 * can exhaust the RPC quota can make names stop rendering. Sized for a human
 * typing in the claim field plus a page full of cards, not for a scraper.
 */
const checkLimiter = new SlidingWindowLimiter([
  { limit: 60, windowMs: 60_000 },
  { limit: 600, windowMs: 60 * 60_000 },
]);

/** Read the mint allowance, or null when the chain is unreachable — see
 *  `mintRateCapVerdict`, which treats null as "proceed", not "refuse". */
async function readMintAllowance(recipient: string) {
  try {
    return await getMintAllowance(recipient);
  } catch (err) {
    console.warn("[sub-ens] mintAllowance pre-flight unavailable:", err);
    return null;
  }
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

  // Validation first: a malformed label is answered without a chain read, so it
  // should not spend the caller's budget either.
  const ip = clientIp(c);
  if (!checkLimiter.peek(ip)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }
  checkLimiter.record(ip);

  try {
    const available = await isLabelAvailable(label);
    if (available) return c.json({ ok: true, data: { available: true } });
    // Return the owner so the client can detect "taken by me" and offer re-link.
    const owner = await getLabelOwner(label);
    // A TAKEN name changes hands rarely, so the edge may answer this for a
    // minute. Deliberately not set on the "available" branch: that one is the
    // claim-field typeahead, where a stale "still free" sends a user into a
    // mint that then fails.
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ ok: true, data: { available: false, owner: owner ?? undefined } });
  } catch (err) {
    console.error("[sub-ens] availability check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }
});

/**
 * GET /api/sub-ens/owned
 * Auth required. Lists every label.woco.eth the authenticated organiser owns,
 * read authoritatively from chain (covers names claimed via any path), so the
 * event + site flows can offer "point an existing name at this". Each entry
 * includes a preview URL when the name currently points at a Swarm site.
 *
 * Response: { names: { label, ensName, contentHash?, previewUrl? }[] }
 */
subEnsRoutes.get("/owned", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const owned = await getOwnedLabels(parentAddress);
    const profileName = profileNameOf(parentAddress);
    const names = owned.map(({ label, contentHash }) => ({
      label,
      ensName: `${label}.woco.eth`,
      // Point E: what this name is FOR, so the event and site pickers can hide
      // the identity name instead of offering it and being refused at 409.
      // "url" means it already points somewhere; "free" means it points nowhere
      // yet — both are bindable, the distinction is only for display.
      role: label === profileName ? "profile" : contentHash ? "url" : "free",
      ...(contentHash ? { contentHash, previewUrl: `${PREVIEW_GATEWAY}/bzz/${contentHash}/` } : {}),
    }));
    return c.json({ ok: true, data: { names } });
  } catch (err) {
    console.error("[sub-ens] owned enumeration failed:", err);
    return c.json({ ok: false, error: "could not list owned names" }, 500);
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

  // Attendee gate: sub-ENS names are unlocked by a purchased ticket (or by
  // being an organiser). UI catches "ticket_required" → gate flow.
  const gate = await checkAttendeeGate(parentAddress as string);
  if (!gate.gated) {
    return c.json({ ok: false, error: "ticket_required" }, 403);
  }

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

  const capped = mintRateCapVerdict(await readMintAllowance(parentAddress as string));
  if (capped) return c.json({ ok: false, ...capped }, 429);

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
      // #464 per-recipient cap. Reachable despite the pre-flight above: the
      // read can race a concurrent mint, and it is skipped when the RPC is
      // unavailable. Report the window rather than a generic failure (#471).
      if (name === "MintRateCapExceeded") {
        const args = (err as { revert?: { args?: unknown[] } }).revert?.args;
        const windowResetsAt = Number(args?.[1] ?? 0);
        return c.json({ ok: false, error: "mint_rate_cap", windowResetsAt }, 429);
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
 * POST /api/sub-ens/permit
 * Auth required. Verifies the authenticated organiser can claim this label, then returns
 * an EIP-712 signed permit. The organiser's wallet submits registerWithPermit() directly
 * (gas covered by ZeroDev paymaster) — no on-chain tx from the server on this path.
 *
 * Body: { label: string }
 * Response: { label, ensName, sig, expiry, registrarAddress, chainId }
 */
subEnsRoutes.post("/permit", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = await c.req.json<{ label: string }>();

  // Same gate as /claim — the permit path is how passkey users mint, so
  // leaving it open would bypass the attendee gate for the main login kind.
  const gate = await checkAttendeeGate(parentAddress as string);
  if (!gate.gated) {
    return c.json({ ok: false, error: "ticket_required" }, 403);
  }

  const label = body.label?.toLowerCase()?.trim();
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);

  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  try {
    const available = await isLabelAvailable(label);
    if (!available) return c.json({ ok: false, error: "label already taken" }, 409);
  } catch (err) {
    console.error("[sub-ens] permit pre-flight check failed:", err);
    return c.json({ ok: false, error: "availability check failed" }, 500);
  }

  // Refuse before signing: a permit for a capped recipient is a signature the
  // organiser pays to submit and watch revert (#471).
  const capped = mintRateCapVerdict(await readMintAllowance(parentAddress as string));
  if (capped) return c.json({ ok: false, ...capped }, 429);

  try {
    const { sig, expiry } = await signSubEnsPermit(label, parentAddress);
    return c.json({
      ok: true,
      data: {
        label,
        ensName: `${label}.woco.eth`,
        sig,
        expiry,
        // Both from the same accessors signSubEnsPermit just used, NOT from the
        // raw env vars: the permit's EIP-712 domain binds the registrar address,
        // so a response naming a different one is a permit the client would
        // submit to a contract that must reject it. Reading env directly also
        // returned `undefined` whenever SUB_ENS_REGISTRAR_ADDRESS was unset —
        // the server signed with the built-in default and told the client
        // nothing, and the client's mismatch guard threw a TypeError instead of
        // refusing cleanly.
        chainId: getSubEnsChainId(),
        registrarAddress: getRegistrarAddress(getSubEnsChainId()),
      },
    });
  } catch (err) {
    console.error("[sub-ens] permit signing failed:", err);
    return c.json({ ok: false, error: "permit signing failed" }, 500);
  }
});

/**
 * POST /api/sub-ens/stamp-event
 * Auth required. Records label.woco.eth on an event feed as a display hint,
 * after verifying ON-CHAIN that the authenticated organiser owns the label.
 * One endpoint covers every claim path (server mint, gasless permit, repoint) —
 * the client calls it once its claim/repoint has succeeded.
 *
 * Body: { label: string, eventId: string }
 */
subEnsRoutes.post("/stamp-event", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req.json<{ label?: string; eventId?: string }>();

  const label = body.label?.toLowerCase()?.trim() ?? "";
  const eventId = body.eventId?.trim() ?? "";
  if (!label) return c.json({ ok: false, error: "label is required" }, 400);
  if (!eventId) return c.json({ ok: false, error: "eventId is required" }, 400);
  const validationError = validateLabel(label);
  if (validationError) return c.json({ ok: false, error: validationError }, 400);

  // Same IDOR guard as set-contenthash: chain ownership is the authority.
  const owner = await getLabelOwner(label);
  if (!owner) return c.json({ ok: false, error: "label not found" }, 404);
  if (owner !== parentAddress) {
    return c.json({ ok: false, error: "not authorised for this label" }, 403);
  }
  // Point A: the caller's own identity name is not a URL to hand to an event.
  if (isProfileName(parentAddress, label)) {
    return c.json({ ok: false, error: "profile_name" }, 409);
  }

  try {
    const updated = await stampEventSubEns(eventId, label, parentAddress);
    // Phase B: for a client-owned feed the server skipped the write — hand the
    // updated feed back so the client re-signs its SOC with the label. Legacy
    // events were already platform-written; eventFeed is harmless there.
    return c.json({ ok: true, data: { label, eventId, ...(updated.creatorFeedSigner ? { eventFeed: updated } : {}) } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stamp failed";
    const status = msg === "Event not found" ? 404 : msg === "Not the event creator" ? 403 : 500;
    if (status === 500) console.error("[sub-ens] stamp-event failed:", err);
    return c.json({ ok: false, error: msg }, status);
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
  // Point C: pointing the identity name at a site would make every later
  // redeploy of that site silently repoint the organiser's identity.
  if (isProfileName(parentAddress as string, label)) {
    return c.json({ ok: false, error: "profile_name" }, 409);
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
