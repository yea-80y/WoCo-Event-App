export type AuthKind = "web3" | "local" | "passkey" | "zupass" | "none";

/** Callback that signs EIP-712 typed data — used by session delegation + POD identity */
export type EIP712Signer = (
  domain: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
  value: Record<string, unknown>,
) => Promise<string>;

/** Info shown to users before signing (local account confirmation dialog) */
export interface SigningRequestInfo {
  action: string;
  domainName: string;
  fields: Array<{ label: string; value: string }>;
}

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
