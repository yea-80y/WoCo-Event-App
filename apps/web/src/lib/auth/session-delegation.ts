// ethers is imported lazily inside each function — this module is statically
// reachable from auth-store at boot, and a top-level ethers import would drag
// ~640KB into the first-paint bundle.
import type { Wallet } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  StorageKeys,
  type SessionDelegation,
  type SessionDelegationMessage,
  type EncryptedBlob,
  type EIP712Signer,
} from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

function getHost(): string {
  if (typeof window === "undefined") return "localhost";
  return window.location.host || "localhost";
}

/**
 * Request a new session delegation from the primary wallet.
 *
 * 1. Generate random session key
 * 2. Session key signs proof-of-possession
 * 3. Parent wallet signs EIP-712 AuthorizeSession (via ethers BrowserProvider)
 * 4. Encrypt & store session key + delegation in IndexedDB
 */
export async function requestSessionDelegation(
  parentAddress: string,
  signTypedData: EIP712Signer,
): Promise<{ sessionAddress: string; delegation: SessionDelegation }> {
  const { Wallet, ZeroHash, verifyTypedData } = await import("ethers");

  // 1. Random session key
  const sessionWallet = Wallet.createRandom();
  const sessionAddress = sessionWallet.address;

  // 2. Build delegation message
  const host = getHost();
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
  const sessionProof = await sessionWallet.signMessage(`${host}:${nonce}`);

  const message: SessionDelegationMessage = {
    host,
    parent: parentAddress,
    session: sessionAddress,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt,
    expiresAt,
    sessionProof,
    clientCodeHash: ZeroHash,
    statement: `Authorize ${sessionAddress} as session key for ${host}`,
  };

  // 3. Sign via provided signer (web3 wallet or local account)
  const parentSig = await signTypedData(
    { ...SESSION_DOMAIN },
    SESSION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message as unknown as Record<string, unknown>,
  );

  // 4. Local sanity check (defence in depth — server re-verifies via viem
  //    with 1271/6492 awareness). ethers can only ecrecover EOA-shaped sigs,
  //    so smart-account signatures (CSW / Safe — ERC-1271 or ERC-6492
  //    wrapped) will throw here. Treat that as "not an EOA, skip" rather
  //    than as a verification failure.
  if (parentSig.length === 132) {
    try {
      const recovered = verifyTypedData(
        SESSION_DOMAIN,
        SESSION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
        message,
        parentSig,
      );
      if (recovered.toLowerCase() !== parentAddress.toLowerCase()) {
        throw new Error("Session delegation signature verification failed");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Session delegation")) throw err;
      // ethers rejected the sig shape — treat as smart-account, let server verify.
    }
  }

  const delegation: SessionDelegation = { message, parentSig };

  // 5. Encrypt and store
  const deviceKey = await ensureDeviceKey();

  // AAD binds both blobs to the parent address. A stale session left in
  // IndexedDB after an account switch cannot be decrypted by a different
  // identity on the same browser even if clear-on-switch is missed — the
  // AES-GCM auth tag fails. See encryption.ts.
  const encSessionKey = await encrypt(deviceKey, AAD.SESSION_KEY(parentAddress), {
    privateKey: sessionWallet.privateKey,
    address: sessionAddress,
  });
  await putKV(StorageKeys.SESSION_KEY, encSessionKey);

  const encDelegation = await encrypt(deviceKey, AAD.SESSION_DELEGATION(parentAddress), delegation);
  await putKV(StorageKeys.SESSION_DELEGATION, encDelegation);

  return { sessionAddress, delegation };
}

/**
 * Restore an existing session from IndexedDB.
 * Returns null if no session exists, has expired, or was encrypted for a
 * different parent (AAD auth tag fails → blob is wiped).
 *
 * `expectedParent` is REQUIRED — the AAD commits to it, so without it the
 * blob cannot be decrypted. A delegation signed by one wallet can never be
 * re-attached to a different active identity: the AES-GCM auth tag fails
 * before the plaintext-level guard below ever runs (defence in depth).
 */
export async function restoreSession(expectedParent: string): Promise<{
  sessionWallet: Wallet;
  delegation: SessionDelegation;
} | null> {
  const encKey = await getKV<EncryptedBlob>(StorageKeys.SESSION_KEY);
  const encDel = await getKV<EncryptedBlob>(StorageKeys.SESSION_DELEGATION);
  if (!encKey || !encDel) return null;

  const deviceKey = await ensureDeviceKey();

  let privateKey: string;
  let address: string;
  let delegation: SessionDelegation;
  try {
    ({ privateKey, address } = await decrypt<{
      privateKey: string;
      address: string;
    }>(deviceKey, AAD.SESSION_KEY(expectedParent), encKey));

    delegation = await decrypt<SessionDelegation>(
      deviceKey,
      AAD.SESSION_DELEGATION(expectedParent),
      encDel,
    );
  } catch {
    // Wrong AAD (different parent / legacy pre-hardening blob), tampered
    // ciphertext, or corrupt store. The blobs are unusable — wipe so the
    // next ensureSession() cleanly re-derives.
    await clearSession();
    return null;
  }

  // Check expiration
  if (new Date(delegation.message.expiresAt).getTime() < Date.now()) {
    await clearSession();
    return null;
  }

  // Check host matches
  if (delegation.message.host !== getHost()) {
    await clearSession();
    return null;
  }

  // Plaintext cross-identity guard (defence in depth — AAD already enforced).
  if (delegation.message.parent.toLowerCase() !== expectedParent.toLowerCase()) {
    await clearSession();
    return null;
  }

  const { Wallet } = await import("ethers");
  const sessionWallet = new Wallet(privateKey);
  if (sessionWallet.address !== address) {
    await clearSession();
    return null;
  }

  return { sessionWallet, delegation };
}

/**
 * Sign an arbitrary message with the session key.
 * Used to authenticate API requests.
 */
export async function signWithSession(
  payload: string | Uint8Array,
  expectedParent: string,
): Promise<{ signature: string; sessionAddress: string } | null> {
  const session = await restoreSession(expectedParent);
  if (!session) return null;

  const message =
    typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  const signature = await session.sessionWallet.signMessage(message);
  return { signature, sessionAddress: session.sessionWallet.address };
}

/**
 * Get the current session delegation bundle for API requests.
 * `expectedParent` is REQUIRED — AAD commits to it. A delegation belonging
 * to a different parent fails the AES-GCM auth tag and is wiped.
 */
export async function getSessionDelegation(
  expectedParent: string,
): Promise<SessionDelegation | null> {
  const encDel = await getKV<EncryptedBlob>(StorageKeys.SESSION_DELEGATION);
  if (!encDel) return null;

  const deviceKey = await ensureDeviceKey();
  let delegation: SessionDelegation;
  try {
    delegation = await decrypt<SessionDelegation>(
      deviceKey,
      AAD.SESSION_DELEGATION(expectedParent),
      encDel,
    );
  } catch {
    await clearSession();
    return null;
  }

  if (delegation.message.parent.toLowerCase() !== expectedParent.toLowerCase()) {
    await clearSession();
    return null;
  }

  return delegation;
}

export async function clearSession(): Promise<void> {
  await delKV(StorageKeys.SESSION_KEY);
  await delKV(StorageKeys.SESSION_DELEGATION);
}
