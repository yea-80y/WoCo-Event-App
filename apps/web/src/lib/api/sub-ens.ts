import { authPost, authGet } from "./client.js";
import type { EventFeed } from "@woco/shared";
import type { ContentFeedSigner } from "../swarm/content-feed.js";

const BASE =
  (typeof window !== "undefined" && (window as unknown as { SITE_CONFIG?: { apiUrl?: string } }).SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

export interface SubEnsCheckResult {
  available: boolean;
  reason?: string;
  owner?: string;
}

export interface SubEnsClaimResult {
  label: string;
  ensName: string;
  txHash: string;
}

export async function checkSubEnsLabel(label: string) {
  const resp = await fetch(`${BASE}/api/sub-ens/check/${encodeURIComponent(label)}`);
  const json = await resp.json() as { ok: boolean; data?: SubEnsCheckResult; error?: string };
  return json;
}

/**
 * Forward-resolve a WoCo name to its owner address. Accepts `label` or
 * `label.woco.eth`. A TAKEN label's `owner` is the resolved account; an available
 * (unregistered) one resolves to nothing. Used by recovery's manual fallback so a
 * user can type their name instead of a hex address.
 */
export async function resolveSubEnsAddress(input: string): Promise<string | null> {
  const label = input.trim().toLowerCase().replace(/\.woco\.eth$/, "");
  if (!/^[a-z0-9-]{1,63}$/.test(label)) return null;
  const res = await checkSubEnsLabel(label);
  // owner is present only when the label is registered (i.e. "not available").
  const owner = res.ok && res.data && !res.data.available ? res.data.owner : undefined;
  return owner && /^0x[a-fA-F0-9]{40}$/.test(owner) ? owner.toLowerCase() : null;
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

interface SubEnsPermitResponse {
  label: string;
  ensName: string;
  sig: string;
  expiry: number;
  chainId: number;
  registrarAddress: string;
}

function isAccountAbstractionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return [
    "AA",
    "User Operation",
    "UserOperation",
    "verificationGasLimit",
    "paymaster",
    "bundler",
    "sponsorUserOperation",
    "signature error",
  ].some((needle) => msg.toLowerCase().includes(needle.toLowerCase()));
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
export async function claimSubEnsViaPermit(opts: {
  label: string;
  kernelAddress: string;
  description?: string;
  avatar?: string;
  swarmHash?: string;
}): Promise<{ ok: boolean; data?: SubEnsClaimResult; error?: string }> {
  const permit = await authPost<SubEnsPermitResponse>("/api/sub-ens/permit", {
    label: opts.label,
  });
  if (!permit.ok || !permit.data) {
    return { ok: false, error: permit.error ?? "permit request failed" };
  }

  const textKeys: string[] = [];
  const textValues: string[] = [];
  if (opts.description?.trim()) { textKeys.push("description"); textValues.push(opts.description.trim()); }
  if (opts.avatar?.trim())      { textKeys.push("avatar");      textValues.push(opts.avatar.trim()); }

  try {
    const { registerSubEnsViaPermit } = await import("../auth/kernel-account.js");
    const { txHash } = await registerSubEnsViaPermit({
      kernelAddress: opts.kernelAddress,
      registrarAddress: permit.data.registrarAddress,
      label: permit.data.label,
      expiry: permit.data.expiry,
      sig: permit.data.sig,
      swarmHash: opts.swarmHash,
      textKeys,
      textValues,
    });
    return { ok: true, data: { label: permit.data.label, ensName: permit.data.ensName, txHash } };
  } catch (err) {
    if (isAccountAbstractionFailure(err)) {
      // Deliberate stopgap while the Kernel session-key paymaster rail is down:
      // the server-sponsored path mints the SAME name to the SAME owner
      // (parentAddress), so ownership is identical — only the gas payer/sender
      // differs. Gasless stays the primary path and runs first; this only fires
      // on a paymaster/AA failure. Remove once the paymaster is confirmed fixed.
      console.warn("[sub-ens] gasless claim failed; falling back to server-sponsored claim:", err);
      return claimSubEnsLabel({
        label: opts.label,
        description: opts.description,
        avatar: opts.avatar,
      });
    }
    return { ok: false, error: err instanceof Error ? err.message : "on-chain registration failed" };
  }
}
