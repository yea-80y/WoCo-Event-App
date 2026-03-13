import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getProfile, updateProfile, uploadAvatar } from "../lib/profile/service.js";

export const profiles = new Hono<AppEnv>();

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

// POST /api/profile — authenticated, updates display name/bio/links
profiles.post("/", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;

  const updates = {
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

  try {
    const profile = await updateProfile(parentAddress, updates);
    return c.json({ ok: true, data: profile });
  } catch (err) {
    console.error("[api] updateProfile error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to update profile: ${msg}` }, 500);
  }
});

// POST /api/profile/avatar — authenticated, uploads avatar image
profiles.post("/avatar", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;

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
    const avatarRef = await uploadAvatar(parentAddress, bytes);
    return c.json({ ok: true, data: { avatarRef } });
  } catch (err) {
    console.error("[api] uploadAvatar error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to upload avatar: ${msg}` }, 500);
  }
});
