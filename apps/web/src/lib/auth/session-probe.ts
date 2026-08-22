/**
 * One authenticated round-trip with a freshly minted session (#200, client half).
 *
 * WHY. The server decides Kernel-session authority from the account's live
 * on-chain owner, cached for a few minutes. Its rule is that a cached answer may
 * CONFIRM a signer but never CONDEMN one (#277): when the rotated-IN key's first
 * delegation arrives, the cache still names the rotated-OUT owner, the rejection
 * it would decide is re-read live, and THAT read is what retires the old key on
 * the server. Until the new key makes contact, a retired key coasts on the
 * cached confirmation for up to the TTL.
 *
 * Passkey recovery always made that contact — its finalize uploads the
 * portability envelope, an authenticated write. A web3auth recovery did not: its
 * finalize only minted a session locally, and nothing reached the server until
 * the user's next action. This makes the contact explicit, for both kinds, as
 * the first thing finalize does with the new session.
 *
 * `/api/auth/whoami` is the smallest authenticated endpoint there is; the effect
 * is entirely in the auth middleware. A refusal here means the server will
 * refuse the user's next action too, so callers report it rather than hide it.
 */

import { authPost } from "../api/client.js";

export type SessionProbeResult = { ok: true } | { ok: false; reason: string };

export async function probeSessionWithServer(): Promise<SessionProbeResult> {
  try {
    const r = await authPost<{ parentAddress: string; sessionAddress: string }>("/api/auth/whoami", {});
    return r.ok ? { ok: true } : { ok: false, reason: r.error ?? "server rejected the session" };
  } catch (e) {
    // `authPost` throws only when no session can be established at all
    // ("Not authenticated"); the caller minted one moments ago, so this is the
    // auth store having been torn down under us — report, never rethrow.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
