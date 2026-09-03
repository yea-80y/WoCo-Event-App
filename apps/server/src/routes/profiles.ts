import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getProfile, updateProfile, uploadAvatar } from "../lib/profile/service.js";
import { getLabelOwner, getLabelContenthash } from "../lib/chain/sub-ens-contract.js";
import { bindProfileName, nameChangeStatus } from "../lib/profile/name-ledger.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import type { UpdateProfileRequest } from "@woco/shared";

export const profiles = new Hono<AppEnv>();

// GET /api/profile/name-status — authenticated. When may this account change
// its profile name, and has the one free early correction been spent? The UI
// asks before offering a rename so it can refuse with a date instead of letting
// the user mint a name they then cannot bind.
//
// MUST stay above `/:address`: Hono matches in registration order, so a
// parameter route registered first would swallow "name-status" and answer
// "Invalid address" (same trap as GET /api/sites/mine vs /:id).
profiles.get("/name-status", requireAuth, (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  return c.json({ ok: true, data: nameChangeStatus(parentAddress) });
});

// GET /api/profile/:address — public, returns profile data
profiles.get("/:address", async (c) => {
  const address = c.req.param("address");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ ok: false, error: "Invalid address" }, 400);
  }

  try {
    const profile = await getProfile(address);
    if (!profile) {
      return c.json({ ok: true, data: null });
    }
    return c.json({ ok: true, data: profile });
  } catch (err) {
    console.error("[api] getProfile error:", err);
    return c.json({ ok: false, error: "Failed to load profile" }, 500);
  }
});

/**
 * Verify + record a profile-name bind. Shared by the two paths that can set one
 * (Phase B `/verify-label`, legacy `POST /api/profile`) so the ownership check,
 * the cooldown and the ledger write cannot drift apart between them.
 *
 * Order matters: ownership FIRST (chain is the authority and the ledger must
 * never record a name the caller does not hold), then the cooldown, then the
 * write. A refused bind writes nothing at all.
 */
type BindOutcome =
  | { ok: true; label: string; nextChangeAllowedAt: number | null; freeCorrectionUsed: boolean; warning?: "points_at_site" }
  | { ok: false; status: 403 | 409 | 502; body: Record<string, unknown> };

async function verifyAndBindProfileName(parentAddress: string, rawLabel: string): Promise<BindOutcome> {
  const label = rawLabel.toLowerCase().trim();
  const parent = parentAddress.toLowerCase();

  let owner: string | null;
  try {
    owner = await getLabelOwner(label);
  } catch (err) {
    console.error("[api] profile name ownership check failed:", err);
    return { ok: false, status: 502, body: { error: "Could not verify name ownership — try again" } };
  }
  if (owner !== parent) {
    return { ok: false, status: 403, body: { error: "You do not own that name" } };
  }

  const result = bindProfileName(parent, label);
  if (!result.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "name_change_cooldown",
        nextChangeAllowedAt: result.status.nextChangeAllowedAt,
        label: result.status.label,
      },
    };
  }

  // Allowed, but worth saying out loud: this name is already a live URL. It
  // keeps resolving to that site — the binding points protect it from being
  // repointed from here on, and clearing it on-chain is a holder action we do
  // not offer yet.
  const contenthash = await getLabelContenthash(label);
  return {
    ok: true,
    label,
    nextChangeAllowedAt: result.status.nextChangeAllowedAt,
    freeCorrectionUsed: result.status.freeCorrectionUsed,
    ...(contenthash ? { warning: "points_at_site" as const } : {}),
  };
}

// POST /api/profile — authenticated, updates display name/bio/links
profiles.post("/", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;
  console.log(`[api] POST /api/profile parent=${parentAddress} keys=${Object.keys(body).join(",")}`);

  // Attendee gate: profiles are unlocked by a purchased ticket (or by being
  // an organiser). UI catches "ticket_required" and routes to the gate flow.
  const gate = await checkAttendeeGate(parentAddress);
  if (!gate.gated) {
    return c.json({ ok: false, error: "ticket_required" }, 403);
  }

  const updates: UpdateProfileRequest = {
    displayName: body.displayName as string | undefined,
    bio: body.bio as string | undefined,
    website: body.website as string | undefined,
    twitterHandle: body.twitterHandle as string | undefined,
    farcasterHandle: body.farcasterHandle as string | undefined,
  };

  // Validate lengths
  if (updates.displayName && updates.displayName.length > 50) {
    return c.json({ ok: false, error: "Display name too long (max 50)" }, 400);
  }
  if (updates.bio && updates.bio.length > 280) {
    return c.json({ ok: false, error: "Bio too long (max 280)" }, 400);
  }

  // Binding a sub-ENS name to the profile makes it a like-subject (its namehash).
  // Only persist a label the caller actually owns on-chain — a profile must not
  // advertise a name it doesn't control. (The likes themselves stay safe either
  // way: the subject is the namehash and the owner is resolved live from chain.)
  let bindWarning: "points_at_site" | undefined;
  let bindStatus: { nextChangeAllowedAt: number | null; freeCorrectionUsed: boolean } | undefined;
  if (body.subEnsLabel !== undefined && body.subEnsLabel !== null) {
    const label = String(body.subEnsLabel).toLowerCase().trim();
    if (label) {
      const outcome = await verifyAndBindProfileName(parentAddress, label);
      if (!outcome.ok) return c.json({ ok: false, ...outcome.body }, outcome.status);
      updates.subEnsLabel = outcome.label;
      bindWarning = outcome.warning;
      bindStatus = {
        nextChangeAllowedAt: outcome.nextChangeAllowedAt,
        freeCorrectionUsed: outcome.freeCorrectionUsed,
      };
    }
  }

  try {
    const profile = await updateProfile(parentAddress, updates);
    return c.json({ ok: true, data: profile, ...(bindWarning ? { warning: bindWarning } : {}), ...(bindStatus ?? {}) });
  } catch (err) {
    console.error("[api] updateProfile error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to update profile: ${msg}` }, 500);
  }
});

// POST /api/profile/verify-label — authenticated. Verifies the caller owns
// {label}.woco.eth on-chain and returns the normalized label. Phase B: a
// client-owned profile signs its own data feed SOC, so the server no longer
// gates the write — but the sub-ENS binding stays server-verified here so a
// profile cannot advertise a name it doesn't control. The client includes the
// returned label in the feed it signs. (Likes stay safe regardless: the subject
// is the namehash and the owner is resolved live from chain.)
profiles.post("/verify-label", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;

  const label = String(body.subEnsLabel ?? "").toLowerCase().trim();
  if (!label) return c.json({ ok: false, error: "Missing label" }, 400);

  const outcome = await verifyAndBindProfileName(parentAddress, label);
  if (!outcome.ok) return c.json({ ok: false, ...outcome.body }, outcome.status);
  return c.json({
    ok: true,
    data: {
      label: outcome.label,
      nextChangeAllowedAt: outcome.nextChangeAllowedAt,
      freeCorrectionUsed: outcome.freeCorrectionUsed,
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    },
  });
});

// POST /api/profile/avatar — authenticated, uploads avatar image. Phase B: when
// the client owns its profile feed (clientOwned:true) the server only stamps the
// image bytes and returns the ref — the client signs the avatar feed SOC itself.
profiles.post("/avatar", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;

  const gate = await checkAttendeeGate(parentAddress);
  if (!gate.gated) {
    return c.json({ ok: false, error: "ticket_required" }, 403);
  }

  const imageB64 = body.image as string;
  if (!imageB64 || typeof imageB64 !== "string") {
    return c.json({ ok: false, error: "Missing image data" }, 400);
  }

  // Decode base64 to bytes
  const raw = imageB64.includes(",") ? imageB64.split(",")[1] : imageB64;
  const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));

  // Limit to 2MB
  if (bytes.length > 2 * 1024 * 1024) {
    return c.json({ ok: false, error: "Image too large (max 2MB)" }, 400);
  }

  try {
    const avatarRef = await uploadAvatar(parentAddress, bytes, { writeFeed: body.clientOwned !== true });
    return c.json({ ok: true, data: { avatarRef } });
  } catch (err) {
    console.error("[api] uploadAvatar error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to upload avatar: ${msg}` }, 500);
  }
});
