/**
 * The two client-side decisions around a holder-signed pointer, pure so they
 * are tested rather than trusted (registrar v2.2; Fable sponsor-key consult
 * §2.2, §11.1).
 */

import type { AuthKind, PointerRequest, SiteFeedOwner } from "@woco/shared";

export type PointerPurpose = "site" | "event-page" | "profile";

/**
 * Why this login may not sign this pointer, as a sentence — or null when it may.
 *
 *  - Coinbase Smart Wallet signs for Base whatever the domain says, so no
 *    signature of its verifies on the names' chain; its holder acts by its own
 *    transaction, which is not built yet.
 *  - A login that HAS a feed signer (every kind that can sign here) binds a
 *    site name only to a feed it owns: a platform-authored feed would hand the
 *    platform's feed key the say over what the name shows.
 */
export function pointerBlockedReason(
  kind: AuthKind,
  purpose: PointerPurpose,
  feedOwner: SiteFeedOwner | undefined,
  name: string,
): string | null {
  if (kind === "coinbase") return `Pointing ${name} from this account arrives soon — the name stays yours.`;
  if (kind !== "web3" && kind !== "passkey" && kind !== "web3auth") return "Sign in to point your name.";
  if (purpose === "site" && feedOwner !== "client") {
    return `This site isn't published under your own key yet. Publish it again, then point ${name} at it.`;
  }
  return null;
}

export type ProfileBindWarning = "points_at_site";

/** What a successful profile bind has to say beyond "done". */
export interface ProfileBindOutcome {
  warning?: ProfileBindWarning;
  pointer?: PointerRequest;
}

/**
 * Read a bind's `warning` / `pointer` from a response body, trusting nothing:
 * a `pointer` is only an ask to sign when its target is a bare 64-hex Swarm
 * reference, since that is what the holder will be shown and sign.
 */
export function profileBindOutcome(src: { warning?: unknown; pointer?: unknown } | undefined): ProfileBindOutcome | null {
  const warning = src?.warning === "points_at_site" ? ("points_at_site" as const) : undefined;
  const p = src?.pointer as Partial<PointerRequest> | undefined;
  const pointer =
    p?.status === "awaiting_signature" && typeof p.target === "string" && /^[0-9a-f]{64}$/.test(p.target)
      ? { status: p.status, target: p.target }
      : undefined;
  return warning || pointer ? { ...(warning ? { warning } : {}), ...(pointer ? { pointer } : {}) } : null;
}
