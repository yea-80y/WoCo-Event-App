import { verifyTypedData, verifyMessage, getAddress, type TypedDataField } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  type SessionDelegation,
  type VerifyDelegationResult,
} from "@woco/shared";
import { isSessionRevoked } from "./revocation.js";

/**
 * Verify a session delegation bundle.
 *
 * Checks:
 * 1. Message and signature are present
 * 2. Not expired
 * 3. Not future-dated (1 min clock skew allowed)
 * 4. Host matches allowed list (if provided)
 * 5. Claimed session address matches delegation
 * 6. EIP-712 signature recovers to the claimed parent
 * 7. sessionProof was signed by the claimed session key
 * 8. Session not revoked
 */
export function verifyDelegation(
  delegation: SessionDelegation,
  claimedSession: string,
  allowedHosts?: string[],
): VerifyDelegationResult {
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

    // EIP-712 signature verification
    let recovered: string;
    try {
      recovered = verifyTypedData(
        SESSION_DOMAIN,
        SESSION_TYPES as unknown as Record<string, TypedDataField[]>,
        message,
        parentSig,
      );
    } catch {
      return { valid: false, error: "Invalid signature" };
    }

    // Recovered must match claimed parent
    if (recovered.toLowerCase() !== message.parent.toLowerCase()) {
      return {
        valid: false,
        error: "Signature does not match claimed parent",
      };
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

    // Check server-side revocation
    if (isSessionRevoked(message.nonce, recovered, message.issuedAt)) {
      return { valid: false, error: "Session has been revoked" };
    }

    return {
      valid: true,
      parentAddress: getAddress(recovered),
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
