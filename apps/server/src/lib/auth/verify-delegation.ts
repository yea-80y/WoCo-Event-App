import { verifyTypedData, getAddress, type TypedDataField } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  type SessionDelegation,
  type VerifyDelegationResult,
} from "@woco/shared";

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
 * Extract delegation from request body or X-Session-Delegation header.
 */
export function extractDelegation(
  req: Request,
  body?: { delegation?: SessionDelegation },
): SessionDelegation | null {
  if (body?.delegation?.message && body?.delegation?.parentSig) {
    return body.delegation;
  }

  const header = req.headers.get("x-session-delegation");
  if (header) {
    try {
      const decoded = JSON.parse(
        Buffer.from(header, "base64").toString("utf-8"),
      );
      if (decoded?.message && decoded?.parentSig) return decoded;
    } catch {
      // invalid header
    }
  }

  return null;
}
