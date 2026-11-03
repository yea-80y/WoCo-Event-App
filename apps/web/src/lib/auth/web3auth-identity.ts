/**
 * A returning email/social user is never silently given a different account (#1051).
 *
 * WHY. An email account is the Kernel counterfactual of ONE key: the `privKey` Web3Auth
 * hands us through the key-only route (web3auth-config.ts). If a Web3Auth change ever
 * moved that key - a client ID, network, login connection or client-secret change, or an
 * SDK that picks another of the keys its login returns - the same person would sign in
 * to a fresh, empty account, and everything bound to the old one (sealed orders, issuer
 * identity, content feeds) would be out of reach with nothing on screen. Every device
 * store we had (the kaddr cache, recovery bindings, tombstones) is keyed BY THE KEY'S
 * ADDRESS, the very thing that moved, so none of them could notice.
 *
 * WHAT. One record per person per device, keyed by WHO signed in rather than by the key:
 * `tag = SHA-256(clientId, network, authConnection, userId)` -> the key and account they
 * had. A new key for a known tag is refused before any account is opened or anything is
 * written. The connection ID is kept in the record, not the tag: it is itself a key
 * input, so a renamed connection would move key and tag together and slip past.
 *
 * WHAT IT IS NOT. Device-local by design: the server must not hold a link between a
 * login (an email) and an account unless the person opts in (#1052), and a hash of an
 * email is no protection anyone could not brute-force. So a NEW device cannot notice;
 * a key change is platform-wide, though, so the first returning device to refuse is the
 * alarm for everyone. Hashing the tag keeps a raw email out of localStorage; it is not a
 * secret from anything that can read this origin's storage.
 *
 * CORRUPT READS AS ABSENT, like the tombstone: a refusal must rest on a well-formed record.
 */

export interface Web3AuthIdentity {
  /** The login's own user id (the email for email/passwordless), as Web3Auth reports it. */
  userId: string;
  /** The login method: "email_passwordless", "google", ... */
  authConnection: string;
  /** The dashboard connection behind it. A key input, kept for the message only. */
  authConnectionId?: string;
}

export interface IdentityRecord {
  /** The Web3Auth key address this person signed in with, lowercase. */
  eoa: string;
  /** The account it opened, lowercase. */
  kernel: string;
  authConnection: string;
  authConnectionId?: string;
  /** Epoch ms of the last write. Forensics only. */
  at: number;
}

/** The two storage ops this module needs, so tests need no DOM. */
export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = "woco:w3aid:";
const ADDR = /^0x[0-9a-f]{40}$/;
const TAG = /^[0-9a-f]{64}$/;

/** Shown when a known person's key changed. Says what happened and what we do. */
export const KEY_CHANGED_MESSAGE =
  "This sign-in gave a different account key than last time, so we stopped before opening an empty account. " +
  "Your account and tickets are untouched. This is on our side and we're putting it right - please try again later.";

/**
 * The person behind a Web3Auth session, from whatever user info the SDK gives: v11 names
 * them `userId`/`authConnection`/`authConnectionId`, v10 `verifierId`/`typeOfLogin`/`verifier`.
 * null when it names no one.
 */
export function identityFromUserInfo(info: unknown): Web3AuthIdentity | null {
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const userId = str(i.userId) ?? str(i.verifierId);
  const authConnection = str(i.authConnection) ?? str(i.typeOfLogin);
  if (!userId || !authConnection) return null;
  const authConnectionId = str(i.authConnectionId) ?? str(i.verifier);
  return { userId, authConnection, ...(authConnectionId ? { authConnectionId } : {}) };
}

/** The same person whatever case the identifier arrives in (the login form lower-cases emails). */
export function normaliseUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

export async function identityTag(id: Web3AuthIdentity, project: { clientId: string; network: string }): Promise<string> {
  const material = JSON.stringify(["woco/w3aid/v1", project.clientId, project.network, id.authConnection, normaliseUserId(id.userId)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function readIdentityRecord(
  tag: string,
  store: IdentityStorage | undefined = globalThis.localStorage,
): IdentityRecord | null {
  try {
    if (!TAG.test(tag)) return null;
    const raw = store?.getItem(PREFIX + tag);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<IdentityRecord>;
    if (typeof p.eoa !== "string" || !ADDR.test(p.eoa)) return null;
    if (typeof p.kernel !== "string" || !ADDR.test(p.kernel)) return null;
    if (typeof p.authConnection !== "string") return null;
    return {
      eoa: p.eoa,
      kernel: p.kernel,
      authConnection: p.authConnection,
      ...(typeof p.authConnectionId === "string" ? { authConnectionId: p.authConnectionId } : {}),
      at: typeof p.at === "number" ? p.at : 0,
    };
  } catch {
    return null;
  }
}

export function writeIdentityRecord(
  tag: string,
  fact: { eoa: string; kernel: string; identity: Web3AuthIdentity },
  store: IdentityStorage | undefined = globalThis.localStorage,
  now: number = Date.now(),
): void {
  if (!TAG.test(tag)) return;
  const record: IdentityRecord = {
    eoa: fact.eoa.toLowerCase(),
    kernel: fact.kernel.toLowerCase(),
    authConnection: fact.identity.authConnection,
    ...(fact.identity.authConnectionId ? { authConnectionId: fact.identity.authConnectionId } : {}),
    at: now,
  };
  try {
    store?.setItem(PREFIX + tag, JSON.stringify(record));
  } catch {
    /* a full or blocked store only loses the reference, never a sign-in */
  }
}

/** True when this person is known here with a DIFFERENT key: refuse, write nothing. */
export function keyChanged(record: IdentityRecord | null, eoa: string): boolean {
  return record !== null && record.eoa !== eoa.toLowerCase();
}
