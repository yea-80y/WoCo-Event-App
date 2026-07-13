import { verifyMessage, verifyTypedData, getAddress, type TypedDataField } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  type SessionDelegation,
  type VerifyDelegationResult,
} from "@woco/shared";
import { isSessionRevoked } from "./revocation.js";
import { verifySmartWalletTypedData } from "./smart-wallet-client.js";
import { isKernelOwner } from "./kernel-owner.js";

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

    // Not future-dated
    const issuedAt = new Date(message.issuedAt).getTime();
    if (isNaN(issuedAt) || issuedAt > Date.now() + 60_000) {
      return { valid: false, error: "Delegation issuedAt is in the future" };
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
      try {
        validSig = await verifySmartWalletTypedData({
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
