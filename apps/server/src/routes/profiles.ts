import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getProfile, updateProfile, uploadAvatar } from "../lib/profile/service.js";
import {
  getLabelOwner,
  getLabelContenthash,
  decodeSwarmContenthash,
} from "../lib/chain/sub-ens-contract.js";
import { getApexContenthash } from "../lib/chain/sub-ens-apex.js";
import { bindProfileName, nameChangeStatus, unbindProfileName } from "../lib/profile/name-ledger.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import type { PointerRequest, UpdateProfileRequest } from "@woco/shared";

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
  | {
      ok: true;
      label: string;
      nextChangeAllowedAt: number | null;
      freeCorrectionUsed: boolean;
      warning?: "points_at_site";
      pointer?: PointerRequest;
    }
  | { ok: false; status: 403 | 409 | 502; body: Record<string, unknown> };

/**
 * The chain edges, injectable — the same default-parameter shape
 * `refuseUnlessOwner` uses, because `mock.module` is unavailable under the tsx
 * loader and these decisions are worth testing for real rather than by grep.
 */
export interface ProfileBindDeps {
  readOwner: (label: string) => Promise<string | null>;
  readContenthash: (label: string) => Promise<string | null>;
  apexContenthash: () => string | null;
}

export async function verifyAndBindProfileName(
  parentAddress: string,
  rawLabel: string,
  deps: Partial<ProfileBindDeps> = {},
): Promise<BindOutcome> {
  const {
    readOwner = getLabelOwner,
    readContenthash = getLabelContenthash,
    apexContenthash = getApexContenthash,
  } = deps;
  const label = rawLabel.toLowerCase().trim();
  const parent = parentAddress.toLowerCase();

  let owner: string | null;
  try {
    owner = await readOwner(label);
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

  const bound = {
    ok: true as const,
    label,
    nextChangeAllowedAt: result.status.nextChangeAllowedAt,
    freeCorrectionUsed: result.status.freeCorrectionUsed,
  };

  // Point the name at the app, so typing it into a browser opens this profile.
  // On-chain rather than a gateway special case: every resolver path then agrees,
  // and it survives a profile-names.json loss. The HOLDER signs that pointer
  // (registrar v2.2): the bind only says what to sign, and a bind never waits
  // on it or fails for it.
  const apex = apexContenthash();
  let contenthash: string | null;
  try {
    contenthash = await readContenthash(label);
  } catch (err) {
    // Unreadable is not empty: asking for a signature now could have the holder
    // overwrite a site pointer they chose. The bind stands; the ask can wait.
    console.warn("[api] profile name contenthash read failed:", (err as { shortMessage?: string })?.shortMessage ?? "unspecified");
    return bound;
  }

  if (!contenthash) {
    return apex ? { ...bound, pointer: { status: "awaiting_signature", target: apex } } : bound;
  }

  // Already the app — nothing to sign, and nothing to warn about either.
  if (apex && decodeSwarmContenthash(contenthash) === apex) return bound;

  // Allowed, but worth saying out loud: this name is already a live URL. It
  // keeps resolving to that site. Deliberately NOT offered the apex: a
  // contenthash that is not ours is somewhere the holder pointed the name on
  // purpose.
  return { ...bound, warning: "points_at_site" as const };
}

// POST /api/profile — authenticated, updates display name/bio/links
profiles.post("/", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;
  const body = c.get("body") as Record<string, unknown>;
  console.log(`[api] POST /api/profile parent=${parentAddress} keys=${Object.keys(body).join(",")}`);

  // Attendee gate — the rule is lib/gate/check.ts (#575). The error code predates
  // the wider rule; the UI matches on it to open the unlock flow.
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

  // Only persist a label the caller actually owns on-chain — a profile must not
  // advertise a name it doesn't control. The name is DISPLAY: followers key to
  // the account's ADDRESS, so binding, changing or losing a name moves no
  // audience (see packages/shared/src/social/subject.ts).
  let bindWarning: "points_at_site" | undefined;
  let bindPointer: PointerRequest | undefined;
  let bindStatus: { nextChangeAllowedAt: number | null; freeCorrectionUsed: boolean } | undefined;
  if (body.subEnsLabel === null) {
    // Explicit unbind. Needs no ownership proof — it can only make the profile
    // claim less — and deliberately does not touch the rename clock.
    unbindProfileName(parentAddress);
    updates.subEnsLabel = null;
  } else if (body.subEnsLabel !== undefined) {
    const label = String(body.subEnsLabel).toLowerCase().trim();
    if (label) {
      const outcome = await verifyAndBindProfileName(parentAddress, label);
      if (!outcome.ok) return c.json({ ok: false, ...outcome.body }, outcome.status);
      updates.subEnsLabel = outcome.label;
      bindWarning = outcome.warning;
      bindPointer = outcome.pointer;
      bindStatus = {
        nextChangeAllowedAt: outcome.nextChangeAllowedAt,
        freeCorrectionUsed: outcome.freeCorrectionUsed,
      };
    }
  }

  try {
    const profile = await updateProfile(parentAddress, updates);
    return c.json({
      ok: true,
      data: profile,
      ...(bindWarning ? { warning: bindWarning } : {}),
      ...(bindPointer ? { pointer: bindPointer } : {}),
      ...(bindStatus ?? {}),
    });
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
// returned label in the feed it signs. (Follows are unaffected either way: they
// key to the account's ADDRESS, never to the name.)
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
      ...(outcome.pointer ? { pointer: outcome.pointer } : {}),
    },
  });
});

// POST /api/profile/unbind-name — authenticated. Stop treating this account's
// sub-ENS name as its profile name. Needs no ownership proof: it can only ever
// make the account claim LESS. Deliberately does not touch the rename clock —
// an unbind is not a change, the next different bind is, or unbind-then-bind
// would be a free rename for anyone who noticed.
profiles.post("/unbind-name", requireAuth, (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  unbindProfileName(parentAddress);
  return c.json({ ok: true, data: nameChangeStatus(parentAddress) });
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
