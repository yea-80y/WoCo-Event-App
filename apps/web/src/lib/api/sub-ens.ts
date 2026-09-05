import { authPost, authGet } from "./client.js";
import type { EventFeed } from "@woco/shared";
import type { ContentFeedSigner } from "../swarm/content-feed.js";
import {
  claimSubEnsViaPermitWith,
  type SubEnsClaimResult,
  type SubEnsPermitClaimOpts,
  type SubEnsPermitDeps,
  type SubEnsPermitResponse,
} from "./sub-ens-permit.js";

const BASE =
  (typeof window !== "undefined" && (window as unknown as { SITE_CONFIG?: { apiUrl?: string } }).SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

export interface SubEnsCheckResult {
  available: boolean;
  reason?: string;
  owner?: string;
}

/** The permit path's orchestration lives in `sub-ens-permit.ts` — runes-free and
 *  fetch-free so it can be tested under node, like `sub-ens-resolve.ts`. */
export type { SubEnsClaimResult } from "./sub-ens-permit.js";
export { isAccountAbstractionFailure } from "./sub-ens-permit.js";

export async function checkSubEnsLabel(label: string) {
  const resp = await fetch(`${BASE}/api/sub-ens/check/${encodeURIComponent(label)}`);
  const json = await resp.json() as { ok: boolean; data?: SubEnsCheckResult; error?: string };
  return json;
}

/**
 * Forward-resolve a WoCo name to its owner address. Accepts `label` or
 * `label.woco.eth`. Used by recovery's manual fallback so a user can type
 * their name instead of a hex address. Thin wrapper: the three-state
 * classification ("none" is definitive, an unanswered lookup is "error",
 * never absence — #177) lives in `sub-ens-resolve.ts`, runes-free and tested.
 */
export type { SubEnsResolve } from "./sub-ens-resolve.js";

export async function resolveSubEnsAddress(input: string) {
  const { resolveSubEnsWith } = await import("./sub-ens-resolve.js");
  return resolveSubEnsWith(checkSubEnsLabel, input);
}

export async function claimSubEnsLabel(opts: {
  label: string;
  description?: string;
  avatar?: string;
  /** 64-char hex Swarm hash (no 0x) to set as the label's contenthash in the mint tx. */
  swarmHash?: string;
}) {
  return authPost<SubEnsClaimResult>("/api/sub-ens/claim", opts);
}

export interface OwnedSubEnsName {
  label: string;
  ensName: string;
  /** 64-hex Swarm hash the name currently points at (absent if unset). */
  contentHash?: string;
  /** Gateway URL to preview the name's current content (absent if it points nowhere). */
  previewUrl?: string;
}

/** Labels the authenticated organiser owns (reconciled against on-chain ownerOf). */
export async function getOwnedSubEns() {
  return authGet<{ names: OwnedSubEnsName[] }>("/api/sub-ens/owned");
}

/** Point an already-owned label's contenthash at a new Swarm hash (server checks ownership). */
export async function setSubEnsContenthash(label: string, swarmHash: string) {
  return authPost<{ label: string; txHash: string }>("/api/sub-ens/set-contenthash", { label, swarmHash });
}

/** Record an owned label on an event feed as a display hint (server verifies
 *  on-chain label ownership + event creatorship). Call after a successful
 *  claim/repoint so event pages can show the name.
 *
 *  Phase B: for a client-owned event feed the server can't write the label —
 *  it returns the updated feed and the OWNER re-signs the SOC here. Pass the
 *  organiser's content-feed signer so the label persists. */
export async function stampEventSubEns(label: string, eventId: string, signer?: ContentFeedSigner | null) {
  const resp = await authPost<{ label: string; eventId: string; eventFeed?: EventFeed }>(
    "/api/sub-ens/stamp-event", { label, eventId },
  );
  if (resp.ok && resp.data?.eventFeed && signer) {
    const { signEventFeedSoc } = await import("./events.js");
    await signEventFeedSoc(resp.data.eventFeed, signer);
  }
  return resp;
}

/**
 * Passkey/Kernel path: fetch an EIP-712 permit from the server, then submit
 * `registerWithPermit` as a gasless userOp signed by the scoped ZeroDev session
 * key — the user pays no gas and the name is owned by their smart account.
 *
 * `kernelAddress` MUST come from `auth.ensureWocoSessionKey()` (it is the
 * permit's `owner` and the session-key owner). Falls back to the sponsor path
 * (`claimSubEnsLabel`) for non-passkey organisers.
 */
export async function claimSubEnsViaPermit(
  opts: SubEnsPermitClaimOpts,
  deps: Partial<SubEnsPermitDeps> = {},
): Promise<{ ok: boolean; data?: SubEnsClaimResult; error?: string }> {
  return claimSubEnsViaPermitWith(opts, {
    fetchPermit: (label) => authPost<SubEnsPermitResponse>("/api/sub-ens/permit", { label }),
    // Imported HERE, not at module load: the Kernel module is large and only
    // passkey organisers ever reach it.
    register: async (args) => (await import("../auth/kernel-account.js")).registerSubEnsViaPermit(args),
    sponsorClaim: claimSubEnsLabel,
    ...deps,
  });
}
