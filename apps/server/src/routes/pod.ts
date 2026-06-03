import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import type { PodCategory, Hex0x } from "@woco/shared";
import {
  getCreatorPodDirectory,
  setCreatorPodCategories,
} from "../lib/pod/directory.js";
import { getOnChainHolding } from "../lib/pod/holdings.js";

/**
 * POD layer routes (Step 4) — the creator POD manager + the public holdings
 * read. Write surfaces are auth-gated and owner-stamped from the verified
 * parentAddress (same trust model as events/sites/shops). Issuance of POD
 * types still flows through event creation; the directory is populated by a
 * fire-and-forget upsert there (no dedicated create endpoint yet).
 */
export const podRouter = new Hono<AppEnv>();

/** GET /api/pod/mine — the caller's POD directory (types + categories). */
podRouter.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const directory = await getCreatorPodDirectory(parentAddress);
    return c.json({ ok: true, data: directory });
  } catch (err) {
    console.error("[pod] GET /mine failed:", err);
    return c.json({ ok: false, error: "Failed to read POD directory" }, 500);
  }
});

/** PUT /api/pod/categories — replace the caller's POD category list. */
podRouter.put("/categories", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const raw = (body as { categories?: unknown })?.categories;
  if (!Array.isArray(raw)) {
    return c.json({ ok: false, error: "categories must be an array" }, 400);
  }
  const categories: PodCategory[] = [];
  for (const item of raw) {
    const cat = item as Partial<PodCategory>;
    if (typeof cat?.id !== "string" || typeof cat?.label !== "string") {
      return c.json({ ok: false, error: "each category needs id + label" }, 400);
    }
    categories.push({
      id: cat.id,
      label: cat.label,
      sortIndex: typeof cat.sortIndex === "number" ? cat.sortIndex : 0,
    });
  }

  try {
    await setCreatorPodCategories(parentAddress, categories);
    return c.json({ ok: true, data: { categories } });
  } catch (err) {
    console.error("[pod] PUT /categories failed:", err);
    return c.json({ ok: false, error: "Failed to write categories" }, 500);
  }
});

/**
 * GET /api/pod/holdings — public read of a wallet's trustless on-chain holding
 * of one POD type. Used by the client to preview "you hold N" / whether a gate
 * passes. Holdings are public on-chain, so no auth; all params required.
 *   ?holder=0x..&onChainEventId=0x..&chainId=421614&manifestRef=0x..
 */
podRouter.get("/holdings", async (c) => {
  const holder = c.req.query("holder");
  const onChainEventId = c.req.query("onChainEventId");
  const manifestRef = c.req.query("manifestRef");
  const chainIdRaw = c.req.query("chainId");
  const chainId = chainIdRaw ? Number(chainIdRaw) : NaN;

  if (!holder || !onChainEventId || !manifestRef || !Number.isFinite(chainId)) {
    return c.json(
      { ok: false, error: "holder, onChainEventId, manifestRef, chainId required" },
      400,
    );
  }

  try {
    const holding = await getOnChainHolding({
      holder: holder as Hex0x,
      onChainEventId,
      chainId,
      manifestRef,
    });
    return c.json({ ok: true, data: holding });
  } catch (err) {
    console.error("[pod] GET /holdings failed:", err);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});
