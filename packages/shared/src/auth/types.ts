export type AuthKind = "web3" | "zupass" | "none";

/** EIP-712 session delegation message (signed by primary wallet) */
export interface SessionDelegationMessage {
  host: string;
  parent: string;
  session: string;
  purpose: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  sessionProof: string;
  clientCodeHash: string;
  statement: string;
}

/** Session delegation bundle: message + parent's EIP-712 signature */
export interface SessionDelegation {
  message: SessionDelegationMessage;
  parentSig: string;
}

/** EIP-712 POD identity derivation message (deterministic, fixed nonce) */
export interface PodIdentityMessage {
  purpose: string;
  address: string;
  nonce: string;
}

/** Encrypted JSON blob (AES-GCM) */
export interface EncryptedBlob {
  iv: string;
  ct: string;
}

/** Result of verifying a session delegation on the backend */
export interface VerifyDelegationResult {
  valid: boolean;
  parentAddress?: string;
  sessionAddress?: string;
  error?: string;
}
