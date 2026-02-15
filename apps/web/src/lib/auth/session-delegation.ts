import { Wallet, ZeroHash, verifyTypedData } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  StorageKeys,
  type SessionDelegation,
  type SessionDelegationMessage,
  type EncryptedBlob,
} from "@woco/shared";
import { requireProvider } from "../wallet/provider.js";
import { ensureDeviceKey, encrypt, decrypt } from "./storage/encryption.js";
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
 * 3. Parent wallet signs EIP-712 AuthorizeSession
 * 4. Encrypt & store session key + delegation in IndexedDB
 */
export async function requestSessionDelegation(
  parentAddress: string,
): Promise<{ sessionAddress: string; delegation: SessionDelegation }> {
  const provider = requireProvider();

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

  // 3. Parent signs EIP-712
  const payload = {
    domain: SESSION_DOMAIN,
    types: { ...SESSION_TYPES },
    primaryType: "AuthorizeSession" as const,
    message,
  };

  const parentSig = (await provider.request({
    method: "eth_signTypedData_v4",
    params: [parentAddress, JSON.stringify(payload)],
  })) as string;

  // 4. Verify locally before storing
  const recovered = verifyTypedData(
    SESSION_DOMAIN,
    { ...SESSION_TYPES },
    message,
    parentSig,
  );
  if (recovered.toLowerCase() !== parentAddress.toLowerCase()) {
    throw new Error("Session delegation signature verification failed");
  }

  const delegation: SessionDelegation = { message, parentSig };

  // 5. Encrypt and store
  const deviceKey = await ensureDeviceKey();

  // Store session private key bytes directly (no Wallet.encrypt layer)
  const encSessionKey = await encrypt(deviceKey, {
    privateKey: sessionWallet.privateKey,
    address: sessionAddress,
  });
  await putKV(StorageKeys.SESSION_KEY, encSessionKey);

  const encDelegation = await encrypt(deviceKey, delegation);
  await putKV(StorageKeys.SESSION_DELEGATION, encDelegation);

  return { sessionAddress, delegation };
}

/**
 * Restore an existing session from IndexedDB.
 * Returns null if no session exists or it has expired.
 */
export async function restoreSession(): Promise<{
  sessionWallet: Wallet;
  delegation: SessionDelegation;
} | null> {
  const encKey = await getKV<EncryptedBlob>(StorageKeys.SESSION_KEY);
  const encDel = await getKV<EncryptedBlob>(StorageKeys.SESSION_DELEGATION);
  if (!encKey || !encDel) return null;

  const deviceKey = await ensureDeviceKey();

  const { privateKey, address } = await decrypt<{
    privateKey: string;
    address: string;
  }>(deviceKey, encKey);

  const delegation = await decrypt<SessionDelegation>(deviceKey, encDel);

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
): Promise<{ signature: string; sessionAddress: string } | null> {
  const session = await restoreSession();
  if (!session) return null;

  const message =
    typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  const signature = await session.sessionWallet.signMessage(message);
  return { signature, sessionAddress: session.sessionWallet.address };
}

/**
 * Get the current session delegation bundle for API requests.
 */
export async function getSessionDelegation(): Promise<SessionDelegation | null> {
  const encDel = await getKV<EncryptedBlob>(StorageKeys.SESSION_DELEGATION);
  if (!encDel) return null;

  const deviceKey = await ensureDeviceKey();
  return decrypt<SessionDelegation>(deviceKey, encDel);
}

export async function clearSession(): Promise<void> {
  await delKV(StorageKeys.SESSION_KEY);
  await delKV(StorageKeys.SESSION_DELEGATION);
}
