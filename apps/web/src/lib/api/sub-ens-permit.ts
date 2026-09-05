/**
 * The gasless (permit) name claim and its sponsor fallback — pure orchestration
 * with every I/O dependency injected, so it is testable under node.
 *
 * Split out of `sub-ens.ts` for the reason `sub-ens-resolve.ts` was: that module
 * statically imports the API client, which reaches the runes-based auth store
 * and `import.meta.env`, and neither runs under the plain tsx test runner. What
 * lives here is exactly the part that got #487 wrong — WHICH arguments the
 * fallback carries over, and WHEN it fires at all.
 */

import type { SubEnsPermitArgs } from "../auth/kernel-account.js";

export interface SubEnsClaimResult {
  label: string;
  ensName: string;
  txHash: string;
}

export interface SubEnsPermitResponse {
  label: string;
  ensName: string;
  sig: string;
  expiry: number;
  chainId: number;
  registrarAddress: string;
}

/** What `claimSubEnsViaPermit` is called with; also the exact shape the sponsor
 *  fallback derives its own arguments from, minus `kernelAddress`. */
export interface SubEnsPermitClaimOpts {
  label: string;
  kernelAddress: string;
  description?: string;
  avatar?: string;
  swarmHash?: string;
}

export type SubEnsClaimEnvelope = { ok: boolean; data?: SubEnsClaimResult; error?: string };

export interface SubEnsPermitDeps {
  fetchPermit: (label: string) => Promise<{ ok: boolean; data?: SubEnsPermitResponse; error?: string }>;
  register: (args: SubEnsPermitArgs) => Promise<{ txHash: string }>;
  sponsorClaim: (opts: Omit<SubEnsPermitClaimOpts, "kernelAddress">) => Promise<SubEnsClaimEnvelope>;
}

/**
 * An ERC-4337 EntryPoint failure code: AA10–AA95, always two digits, matched
 * against the RAW message so case is meaningful.
 *
 * The bare two-letter form used to sit in the needle list below, lowercased and
 * substring-matched — which any message carrying a tx hash or an address hits by
 * chance ("execution reverted: 0x8aa3…aa91"). That routed failures which have
 * nothing to do with account abstraction into the sponsor fallback, minting a
 * name for a user whose actual error was something else entirely.
 */
const AA_CODE = /\bAA\d{2}\b/;

export function isAccountAbstractionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (AA_CODE.test(msg)) return true;
  return [
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
 * Fetch an EIP-712 permit, submit `registerWithPermit` as a gasless userOp, and
 * fall back to the server-sponsored mint if — and only if — that failed for an
 * account-abstraction reason.
 */
export async function claimSubEnsViaPermitWith(
  opts: SubEnsPermitClaimOpts,
  deps: SubEnsPermitDeps,
): Promise<SubEnsClaimEnvelope> {
  const permit = await deps.fetchPermit(opts.label);
  if (!permit.ok || !permit.data) {
    return { ok: false, error: permit.error ?? "permit request failed" };
  }

  const textKeys: string[] = [];
  const textValues: string[] = [];
  if (opts.description?.trim()) { textKeys.push("description"); textValues.push(opts.description.trim()); }
  if (opts.avatar?.trim())      { textKeys.push("avatar");      textValues.push(opts.avatar.trim()); }

  try {
    const { txHash } = await deps.register({
      kernelAddress: opts.kernelAddress,
      registrarAddress: permit.data.registrarAddress,
      chainId: permit.data.chainId,
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
      // differs. The CONTENT has to be identical too: listing the fields by hand
      // dropped `swarmHash`, and a passkey organiser's site deploy then minted a
      // name pointing nowhere (#487). Deriving the arguments instead means a
      // field added to the claim cannot be silently lost on this path.
      // `kernelAddress` is the one field removed on purpose — it is the gasless
      // sender, and the sponsor mints to the verified parent instead. Gasless
      // stays the primary path and runs first; this only fires on a paymaster/AA
      // failure. Remove once the paymaster is confirmed fixed.
      console.warn("[sub-ens] gasless claim failed; falling back to server-sponsored claim:", err);
      const { kernelAddress: _kernel, ...sponsorArgs } = opts;
      return deps.sponsorClaim(sponsorArgs);
    }
    return { ok: false, error: err instanceof Error ? err.message : "on-chain registration failed" };
  }
}
