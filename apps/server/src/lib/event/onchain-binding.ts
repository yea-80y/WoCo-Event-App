/**
 * Does a series' claimed on-chain event actually belong to that series? (#424)
 *
 * `series.onChainEventId` reaches the server from the creator's own
 * client-signed feed, so it is untrusted input. Without a binding check a
 * creator can name ANOTHER organiser's on-chain event: an authorised sponsor
 * may append slots to any event, so every sale would mint out of the victim's
 * supply while the payment lands with the attacker, and the buyer receives a
 * genuine ticket to the victim's event.
 *
 * The anchor is the chain: `manifestRef` is stamped at registration and cannot
 * be edited afterwards. The series carries the digest it was created with
 * (`createEventV2` stamps it — lib/event/service.ts), so the two must name the
 * same event.
 *
 * Pure so it can be tested directly, following the same shape as
 * `checkout-expiry.ts`. The caller supplies the chain value and decides what to
 * do with a verdict.
 */

export type BindingVerdict =
  /** Bound, or not checkable for a reason that is not the series' fault. */
  | { ok: true; checked: boolean }
  | { ok: false; reason: "no-manifest-ref" | "manifest-mismatch"; detail: string };

export interface BindingInput {
  /** The series' own digest, from the feed. OPTIONAL in the schema — see below. */
  seriesManifestRef?: string;
  /**
   * `manifestRef` read from the chain for the claimed event, or null/undefined
   * when the read did not produce one (transport failure, or a version that
   * does not expose it).
   */
  onChainManifestRef?: string | null;
}

/**
 * @returns `ok: true, checked: false` when the chain value is unavailable — the
 * caller should treat that as a transient condition and fail OPEN, since a
 * flaky RPC must not stop every sale. Any `ok: false` is definitive and should
 * fail CLOSED: it is a property of the series, not of the network.
 */
export function checkSeriesOnChainBinding(input: BindingInput): BindingVerdict {
  const { seriesManifestRef, onChainManifestRef } = input;

  // No chain value: nothing to compare against. Not the series' fault.
  if (!onChainManifestRef) return { ok: true, checked: false };

  // A missing series digest is DISQUALIFYING, not "nothing to check".
  //
  // `manifestRef` is optional in the schema and the checkout's registration
  // gate requires `swarmManifestRef` instead, so treating absence as a skip
  // would let the entire binding be bypassed by omitting one field — which is
  // exactly as useful to an attacker as forging it. Every honest on-chain
  // series has it: `createEventV2` stamps it at creation.
  if (!seriesManifestRef) {
    return {
      ok: false,
      reason: "no-manifest-ref",
      detail: "series declares an on-chain event but no manifestRef to bind it to",
    };
  }

  if (seriesManifestRef.toLowerCase() !== onChainManifestRef.toLowerCase()) {
    return {
      ok: false,
      reason: "manifest-mismatch",
      detail:
        `on-chain event carries manifestRef ${onChainManifestRef.slice(0, 10)}… ` +
        `but the series declares ${seriesManifestRef.slice(0, 10)}…`,
    };
  }

  return { ok: true, checked: true };
}
