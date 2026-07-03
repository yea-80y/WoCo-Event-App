/**
 * Fire-and-forget hooks that keep the user manifest's ACTIVE-FEED LOG in step
 * with publish actions (profile save, avatar upload, event publish, site
 * deploy). One narrow seam over `inventory.upsertFeedEntry` so every publish
 * surface logs identically, and the store/prompt plumbing stays out of the API
 * modules: the feed signer resolves PROMPT-FREE post-login (device store /
 * escrow) or not at all — accounts without a client feed signer have nothing
 * client-owned to log, and the hook is a silent no-op.
 *
 * ALWAYS best-effort: the manifest is a comfort layer (the batch-migration
 * keep-list), never a gate on the publish that triggered it.
 */

import type { ManifestFeedEntry, ManifestFeedKind } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";
import { upsertFeedEntry, trashFeedEntryOnManifest } from "./inventory.js";

/** Log (upsert) an active client-owned feed. Silent no-op without a feed signer. */
export async function logFeedToManifest(entry: Omit<ManifestFeedEntry, "updatedAt">): Promise<void> {
  try {
    const signer = await auth.getContentFeedSigner();
    const parent = auth.parent?.toLowerCase();
    if (!signer || !parent) return;
    await upsertFeedEntry({
      signer: { privKey: signer.privKey, address: signer.address },
      parentAddress: parent,
      entry: { ...entry, updatedAt: Date.now() },
    });
  } catch (err) {
    console.warn("[manifest] feed log failed (non-fatal):", err);
  }
}

/** Move a feed's manifest entry to trash (deletion-by-omission bookkeeping). */
export async function trashFeedOnManifest(kind: ManifestFeedKind, topic: string): Promise<void> {
  try {
    const signer = await auth.getContentFeedSigner();
    const parent = auth.parent?.toLowerCase();
    if (!signer || !parent) return;
    await trashFeedEntryOnManifest({
      signer: { privKey: signer.privKey, address: signer.address },
      parentAddress: parent,
      kind,
      topic,
    });
  } catch (err) {
    console.warn("[manifest] feed trash failed (non-fatal):", err);
  }
}
