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
 *  - A name that follows a FEED answers to whoever signs that feed, so it may
 *    follow only a feed this account signs: a platform-authored one would hand
 *    the platform's feed key the say over what the name shows. One rule for
 *    sites and event pages alike (#614). A fixed content hash is safe for any
 *    purpose - no key can change what it shows. The profile name is the one
 *    exception by design: it opens the WoCo app, whose feed WoCo publishes.
 */
export function pointerBlockedReason(
  kind: AuthKind,
  purpose: PointerPurpose,
  feedOwner: SiteFeedOwner | undefined,
  targetIsFeed: boolean,
  name: string,
): string | null {
  if (kind === "coinbase") return `Pointing ${name} from this account arrives soon — the name stays yours.`;
  if (kind !== "web3" && kind !== "passkey" && kind !== "web3auth") return "Sign in to point your name.";
  if (targetIsFeed && purpose !== "profile" && feedOwner !== "client") {
    const what = purpose === "site" ? "site" : "page";
    return `This ${what} isn't published under your own key yet. Publish it again, then point ${name} at it.`;
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
