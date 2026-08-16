/**
 * "A Web3Auth session was established on this device and has not been
 * deterministically ended" — the durable flag behind #182's unconditional
 * sign-out.
 *
 * Sign-out must end Web3Auth's stored session regardless of what `_kind`
 * says (a cleared or mismatched kind must not leave the previous user's
 * session for the next "Continue with Email" click to resume). But making
 * every sign-out build the Web3Auth SDK just to check would pull its large
 * chunk for users who never touched email login. This flag is the cheap
 * middle: set the moment a session key is actually extracted, cleared only
 * when the session is known ended (deterministic logout, or a restore that
 * definitively reported it expired), consulted before the SDK is built.
 *
 * Storage is injectable for tests; a throwing storage reads as "no flag" —
 * safe, because a storage that cannot hold our flag cannot hold Web3Auth's
 * session either, so there is nothing to end.
 */

const FLAG_KEY = "woco:web3auth-session-established";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): FlagStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function markWeb3AuthSessionEstablished(storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(FLAG_KEY, "1");
  } catch {
    /* see module note: no storage ⇒ no stored session to end */
  }
}

export function clearWeb3AuthSessionFlag(storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(FLAG_KEY);
  } catch {
    /* ignore */
  }
}

export function hasWeb3AuthSessionFlag(storage: FlagStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
