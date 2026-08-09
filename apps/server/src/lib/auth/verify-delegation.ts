import { verifyMessage, verifyTypedData, getAddress, type TypedDataField } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  AuthErrorCode,
  type SessionDelegation,
  type VerifyDelegationResult,
} from "@woco/shared";
import { isSessionRevoked } from "./revocation.js";
import { verifySmartWalletTypedData } from "./smart-wallet-client.js";
import { isKernelOwner, readKernelOwner } from "./kernel-owner.js";
import { isKernelKnownDeployed } from "./kernel-deployed.js";
import { decideSmartWalletPath } from "./smart-wallet-gate.js";

/**
 * Seam for the two authorities the smart-wallet gate consults (#209).
 *
 * Injected rather than imported at the call site so the gate can be tested
 * without a live chain or a live verifier — including the property that most
 * matters, that a verifier which WOULD accept is never reached for a gated
 * account. Production passes nothing and gets the real implementations.
 */
export interface DelegationVerifyDeps {
  isKernelKnownDeployed: (address: string) => boolean;
  readKernelOwner: (address: string) => Promise<string | null | "error">;
  verifySmartWalletTypedData: typeof verifySmartWalletTypedData;
}

const DEFAULT_DEPS: DelegationVerifyDeps = {
  isKernelKnownDeployed,
  readKernelOwner,
  verifySmartWalletTypedData,
};

/**
 * Verify a session delegation bundle.
 *
 * Checks:
 * 1. Message and signature are present
 * 2. Not expired
 * 3. Not future-dated (1 min clock skew allowed)
 * 4. Host matches allowed list (if provided)
 * 5. Claimed session address matches delegation
 * 6. EIP-712 signature is valid for the claimed parent — one of:
 *    a. EOA (local ecrecover, recovered == parent);
 *    b. Kernel-owner EOA (local ecrecover, recovered OWNS the parent Kernel —
 *       deterministic counterfactual match, or live on-chain owner for rotated
 *       /recovered accounts; see kernel-owner.ts). This is the passkey/web3auth
 *       path since the 2026-07 split-brain fix: the raw owner key signs,
 *       message.parent stays the Kernel identity;
 *    c. ERC-1271 (deployed smart account) or ERC-6492 (counterfactual smart
 *       account) via RPC — smart wallets (CSW) and pre-fix Kernel-signed
 *       delegations.
 * 7. sessionProof was signed by the claimed session key
 * 8. Session not revoked
 */
export async function verifyDelegation(
  delegation: SessionDelegation,
  claimedSession: string,
  allowedHosts?: string[],
  deps: DelegationVerifyDeps = DEFAULT_DEPS,
): Promise<VerifyDelegationResult> {
  try {
    if (!delegation?.message || !delegation?.parentSig) {
      return { valid: false, error: "Missing delegation message or signature" };
    }

    const { message, parentSig } = delegation;

    // Expiration
    const expiresAt = new Date(message.expiresAt).getTime();
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return { valid: false, error: "Session delegation has expired" };
    }

    // Not future-dated. A device clock 61s–300s FAST is the interesting case:
    // it slips through the ±5min request-timestamp window in the middleware,
    // but stamps every freshly minted delegation with issuedAt > server+60s and
    // lands here. That is a clock fault, not a bad delegation — minting another
    // one reproduces it exactly, so it must NOT be reported as SESSION_INVALID
    // or the client's recovery would re-prompt the user for a signature on
    // every action, forever. Classify it as skew and let the client say so.
    const issuedAt = new Date(message.issuedAt).getTime();
    if (isNaN(issuedAt)) {
      return { valid: false, error: "Delegation issuedAt is not a valid date" };
    }
    const futureBy = issuedAt - Date.now();
    if (futureBy > 60_000) {
      return {
        valid: false,
        error: `Delegation issuedAt is ${Math.round(futureBy / 1000)}s in the future — device clock is ahead of server time`,
        code: AuthErrorCode.SESSION_CLOCK_SKEW,
      };
    }

    // Host check
    if (allowedHosts?.length && !allowedHosts.includes(message.host)) {
      return { valid: false, error: `Invalid host: ${message.host}` };
    }

    // Session address match
    if (message.session.toLowerCase() !== claimedSession.toLowerCase()) {
      return {
        valid: false,
        error: `Session address mismatch: delegation has ${message.session}, request claims ${claimedSession}`,
      };
    }

    // EIP-712 signature verification, cheapest-first:
    //  (1) EOA-shaped sig (65 bytes) → local ecrecover. Valid when the
    //      recovered address IS the parent (plain EOA logins), or when it OWNS
    //      the parent Kernel (passkey/web3auth since the 2026-07 fix — raw
    //      owner key signs, parent stays the Kernel; deterministic
    //      counterfactual match is RPC-free, rotated/recovered accounts fall
    //      back to a live owner read).
    //  (2) Anything else (or an ecrecover miss) → viem universal verify:
    //      ERC-1271 (deployed smart account) / ERC-6492 (counterfactual),
    //      eth_call via RPC — CSW and pre-fix Kernel-signed delegations.
    let validSig = false;
    if (parentSig.length === 132) {
      let recovered: string | null = null;
      try {
        recovered = verifyTypedData(
          SESSION_DOMAIN,
          SESSION_TYPES as unknown as Record<string, TypedDataField[]>,
          message,
          parentSig,
        ).toLowerCase();
      } catch {
        recovered = null; // not ecrecover-able — fall through to (2)
      }
      if (recovered) {
        validSig =
          recovered === message.parent.toLowerCase() ||
          (await isKernelOwner(recovered, message.parent));
      }
    }
    if (!validSig) {
      // Both verification paths answer "is this the parent's signature", but not
      // with the same authority — and only this one can be satisfied by
      // simulating a deployment that has since been superseded. Once we can
      // identify the account as one with an on-chain owner, that owner is the
      // only authority that applies, so this path is not offered at all (#209).
      const knownDeployed = deps.isKernelKnownDeployed(message.parent);
      // Short-circuit: the store's memory alone settles it, at no chain cost.
      const liveOwner = knownDeployed ? null : await deps.readKernelOwner(message.parent);
      const gate = decideSmartWalletPath({ knownDeployed, liveOwner });
      if (!gate.attempt) {
        // The only trace a wedged pre-fix client would otherwise leave is an
        // opaque 403 — exactly the diagnosability problem #107 exists to fix.
        console.warn(
          `[auth] smart-wallet verification not offered for ${message.parent}: ${gate.reason}`,
        );
        return { valid: false, error: "Invalid signature", code: AuthErrorCode.SESSION_INVALID };
      }
      try {
        validSig = await deps.verifySmartWalletTypedData({
          address: message.parent as `0x${string}`,
          domain: SESSION_DOMAIN,
          types: SESSION_TYPES,
          primaryType: "AuthorizeSession",
          message: message as unknown as Record<string, unknown>,
          signature: parentSig as `0x${string}`,
        });
      } catch {
        return { valid: false, error: "Signature verification failed" };
      }
    }
    if (!validSig) {
      return { valid: false, error: "Invalid signature" };
    }

    // Verify sessionProof: the session key signed "${host}:${nonce}"
    // Always required — reject delegations without a valid proof-of-possession.
    if (!message.sessionProof) {
      return { valid: false, error: "Missing session proof" };
    }
    try {
      const proofMessage = `${message.host}:${message.nonce}`;
      const proofSigner = verifyMessage(proofMessage, message.sessionProof);
      if (proofSigner.toLowerCase() !== message.session.toLowerCase()) {
        return {
          valid: false,
          error: "Session proof does not match session address",
        };
      }
    } catch {
      return { valid: false, error: "Invalid session proof signature" };
    }

    // Check server-side revocation. Verification proved message.parent signed,
    // so we use it as the authoritative parent address (no separate recovered
    // value — that pattern only existed for the EOA-only ethers flow).
    if (isSessionRevoked(message.nonce, message.parent, message.issuedAt)) {
      return { valid: false, error: "Session has been revoked" };
    }

    return {
      valid: true,
      parentAddress: getAddress(message.parent),
      sessionAddress: getAddress(message.session),
    };
  } catch {
    return { valid: false, error: "Verification failed" };
  }
}

/**
 * Extract delegation from the X-Session-Delegation header (base64-encoded JSON).
 *
 * As of auth v2 (2026-04-09), delegation is header-only — the legacy
 * `body.delegation` path has been removed to keep the signed-challenge
 * surface clean (auth never pollutes request bodies).
 */
export function extractDelegation(req: Request): SessionDelegation | null {
  const header = req.headers.get("x-session-delegation");
  if (!header) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(header, "base64").toString("utf-8"),
    );
    if (decoded?.message && decoded?.parentSig) return decoded as SessionDelegation;
  } catch {
    // invalid header
  }
  return null;
}
