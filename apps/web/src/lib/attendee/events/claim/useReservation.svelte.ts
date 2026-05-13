import {
  reserveSlots,
  releaseSlots,
  secondsUntil,
  type ReservationData,
} from "../../../api/reservations.js";

interface UseReservationOpts {
  eventId: string;
  seriesId: string;
  /** Reactive getter for the current desired quantity. Read inside $effect
   *  so changes auto-trigger re-reservation. */
  getQuantity: () => number;
  /** Reactive getter: should we currently hold a seat reservation? All
   *  parent state reads (claimed / approvalPending / showOrderForm / etc.)
   *  happen inside this fn so the hook's $effect tracks them transitively. */
  getShouldHold: () => boolean;
}

/**
 * Reservation state hook — manages the ~10min server-side seat hold that
 * gates Stripe checkout. Extracted from ClaimButton.svelte to keep the
 * component focused; behaviour is intentionally identical:
 *
 *  - Hydrates from sessionStorage on construction (resume hold after page
 *    refresh / tab close), dropping if already expired.
 *  - Auto-reserves when the parent's shouldHold predicate flips true.
 *  - Auto-releases when shouldHold flips false (form closed, qty=0, etc.).
 *  - Re-issues with `replaceReservationId` on quantity change so the server
 *    atomically swaps inside the per-series mutex.
 *  - Ticks the live countdown; expiry sets `expired=true` and blocks
 *    auto-re-reserve until the buyer clicks retry or changes qty.
 *  - Persists every state transition to sessionStorage so a back-nav from
 *    Stripe checkout doesn't show a phantom countdown for a consumed hold.
 *
 * Does NOT release on pagehide or component unmount — by design. The 10-min
 * TTL is the buyer's window; closing+reopening must resume the SAME hold
 * with the SAME deadline (server-side clientKey lookup), not restart it.
 */
export function useReservation(opts: UseReservationOpts) {
  const storageKey = `woco:reservation:${opts.eventId}:${opts.seriesId}`;

  function hydrate(): ReservationData | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ReservationData;
      if (secondsUntil(parsed.expiresAt) <= 0) {
        sessionStorage.removeItem(storageKey);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function persist(r: ReservationData | null): void {
    try {
      if (r) sessionStorage.setItem(storageKey, JSON.stringify(r));
      else sessionStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }

  const initial = hydrate();

  let reservation = $state<ReservationData | null>(initial);
  let secsLeft = $state<number | null>(
    initial ? secondsUntil(initial.expiresAt) : null,
  );
  let error = $state<string | null>(null);
  let expired = $state(false);

  // Plain booleans (not $state) — prevent circular reactivity.
  // _justExpired: set by countdown before nulling `reservation` so the main
  //   effect knows not to auto-re-reserve on that specific re-run.
  // _expiredQty: holds the quantity that was reserved when it expired, so we
  //   can detect when the buyer changes qty (= intentional retry).
  let _seq = 0;
  let _justExpired = false;
  let _expiredQty: number | null = null;

  $effect(() => {
    const q = opts.getQuantity();

    // Countdown set this flag synchronously before nulling `reservation`.
    // Catch it on the very first re-run to block auto-re-reserve.
    if (_justExpired) {
      _justExpired = false;
      expired = true;
      return;
    }

    // Hold expired and is waiting for buyer action.
    if (expired) {
      if (q !== _expiredQty) {
        // Buyer changed quantity — treat as intentional retry. Clear flag and
        // return; the next effect run (triggered by expired→false) will
        // compute shouldHold and issue the new reserve call.
        expired = false;
        _expiredQty = null;
      }
      return;
    }

    const shouldHold = opts.getShouldHold();
    if (!shouldHold) {
      if (reservation) {
        releaseSlots(opts.eventId, opts.seriesId, reservation.reservationId);
        reservation = null;
        secsLeft = null;
        error = null;
        persist(null);
      }
      return;
    }
    // Already holding the right quantity — nothing to do.
    if (reservation && reservation.quantity === q) return;

    // New reservation OR quantity change. Pass the prior id (if any) as
    // replaceReservationId so the server releases it atomically inside the
    // per-series mutex, eliminating the self-race where our own old hold
    // would block the new request.
    const replaceId = reservation?.reservationId;
    const mySeq = ++_seq;
    error = null;
    reserveSlots(opts.eventId, opts.seriesId, q, replaceId).then((res) => {
      if (mySeq !== _seq) return;
      if (res.ok) {
        reservation = res.data;
        secsLeft = secondsUntil(res.data.expiresAt);
        expired = false;
        persist(res.data);
      } else {
        // Server already released the prior hold (if replaceId was passed)
        // before failing the new allocation. Mirror that locally.
        reservation = null;
        secsLeft = null;
        persist(null);
        // Distinguish "sold out" from "held by another buyer". When
        // physicalAvailable > 0 but available === 0, all remaining seats
        // are inside someone else's reservation window — telling the buyer
        // to reduce quantity is misleading (qty might already be 1).
        if (typeof res.available === "number") {
          const phys = typeof res.physicalAvailable === "number" ? res.physicalAvailable : -1;
          if (res.available === 0 && phys > 0) {
            error = "All remaining tickets are currently held by other buyers — try again in a few minutes.";
          } else if (res.available === 0) {
            error = "Sold out.";
          } else {
            error = `Only ${res.available} ticket${res.available === 1 ? "" : "s"} available — please reduce quantity.`;
          }
        } else {
          error = res.error;
        }
      }
    }).catch(() => {
      // Network error — let the user click Pay anyway; server will reject if
      // truly out of stock. Keep UI quiet rather than block on a transient.
    });
  });

  /** Tick the reservation countdown once per second. */
  $effect(() => {
    if (!reservation) return;
    const id = setInterval(() => {
      const r = reservation;
      if (!r) return;
      secsLeft = secondsUntil(r.expiresAt);
      if (secsLeft === 0) {
        _expiredQty = r.quantity;
        _justExpired = true;
        reservation = null;
        secsLeft = null;
        persist(null);
      }
    }, 1000);
    return () => clearInterval(id);
  });

  return {
    get reservation() { return reservation; },
    get secsLeft() { return secsLeft; },
    get error() { return error; },
    get expired() { return expired; },
    /**
     * Called from the Stripe handler after the server has stamped
     * reservationId into Stripe metadata; the webhook will consume it.
     * Clears local state (incl. sessionStorage) so back-nav from Stripe
     * doesn't show a phantom countdown for a hold about to be consumed.
     */
    clearForCheckout(): void {
      reservation = null;
      secsLeft = null;
      persist(null);
    },
    /** Buyer clicked "try again" on the expired-hold banner. */
    retry(): void {
      expired = false;
      _expiredQty = null;
    },
  };
}
