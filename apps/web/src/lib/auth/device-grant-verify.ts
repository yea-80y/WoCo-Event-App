/**
 * Check the account's device-grant list in the browser (#746 step 3), so the
 * "Your passkeys" screen shows only passkeys the account's owner actually signed
 * for: every grant must recover to the current owner and name this account. A
 * record from a previous owner (before a recovery or a make-main) is left out - it
 * no longer opens anything. A removal is shown as the server records it: the server
 * is where a removal takes effect, and showing one too many as removed is the safe
 * side - the person can add it again.
 */

import { verifyTypedData, type TypedDataField } from "ethers";
import { DEVICE_GRANT_DOMAIN, DEVICE_GRANT_TYPES, parseDeviceGrant } from "@woco/shared";

export interface DeviceGrantRecordWire {
  grant: unknown;
  grantSig: unknown;
  revokedAt?: unknown;
}

export interface VerifiedPasskey {
  grantee: string;
  credentialTag: string;
  /** Unix seconds, as the owner's device stamped it. Display only. */
  issuedAt: number;
  removedAt: number | null;
}

const types = (t: object) => t as unknown as Record<string, TypedDataField[]>;

function grantSigner(message: object, sig: unknown): string | null {
  if (typeof sig !== "string") return null;
  try {
    return verifyTypedData(DEVICE_GRANT_DOMAIN, types(DEVICE_GRANT_TYPES), message, sig).toLowerCase();
  } catch {
    return null;
  }
}

export function verifyDeviceGrantList(
  records: readonly DeviceGrantRecordWire[],
  expected: { parent: string; owner: string } | { parent: string; signers: readonly string[] },
): VerifiedPasskey[] {
  const parent = expected.parent.toLowerCase();
  // A co-owned account (#746): a record is good when ANY of its passkeys signed it.
  const allowed = new Set(("owner" in expected ? [expected.owner] : expected.signers).map((s) => s.toLowerCase()));
  const out: VerifiedPasskey[] = [];
  for (const r of records) {
    const grant = parseDeviceGrant(r.grant);
    if (!grant || grant.parent !== parent) continue;
    const signer = grantSigner(grant, r.grantSig);
    if (!signer || !allowed.has(signer)) continue;
    const removedAt = typeof r.revokedAt === "number" ? r.revokedAt : null;
    out.push({ grantee: grant.grantee, credentialTag: grant.credentialTag, issuedAt: grant.issuedAt, removedAt });
  }
  return out;
}

/** On an ADDED passkey: the owner is whoever signed this device's own live grant -
 *  the grant the server just accepted its session under. Null when absent. */
export function ownerFromOwnGrant(records: readonly DeviceGrantRecordWire[], self: string): string | null {
  const me = self.toLowerCase();
  for (const r of records) {
    const grant = parseDeviceGrant(r.grant);
    if (grant && grant.grantee === me && typeof r.revokedAt !== "number") return grantSigner(grant, r.grantSig);
  }
  return null;
}
