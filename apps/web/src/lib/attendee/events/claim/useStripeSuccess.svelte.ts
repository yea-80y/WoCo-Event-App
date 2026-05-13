import { initialStripeSuccess } from "./helpers.js";

interface UseStripeSuccessOpts {
  eventId: string;
  seriesId: string;
}

/**
 * Optimistic Stripe-success card state. Initialised SYNCHRONOUSLY at script
 * init from the URL hash (`#stripe=success`) + the form-stash that was written
 * when Pay was clicked, so the modal renders on the very first paint after the
 * Stripe redirect — no polling, no spinner, no waiting on the webhook.
 *
 * `wasReturn` reflects the state at construction so the parent can branch its
 * onMount logic deterministically. `consumeReturnHash()` scrubs the hash so a
 * refresh doesn't re-fire detection.
 */
export function useStripeSuccess(opts: UseStripeSuccessOpts) {
  const initial = initialStripeSuccess(opts.eventId, opts.seriesId);

  let email = $state<string | null>(initial.email);
  let qty = $state<number>(initial.qty);
  let visible = $state<boolean>(initial.visible);

  return {
    get email() { return email; },
    get qty() { return qty; },
    get visible() { return visible; },
    /** True iff this mount detected a fresh Stripe return. Stable for the life
     *  of the component — read once in onMount to branch the status-fetch path. */
    wasReturn: initial.visible,
    /** Strip `stripe=success` + `session_id` from the URL so a refresh won't
     *  re-trigger detection. Safe no-op outside the browser. */
    consumeReturnHash(): void {
      if (typeof window === "undefined") return;
      try {
        const url = new URL(window.location.href);
        const newHash = window.location.hash
          .replace(/[?&]stripe=success/, "")
          .replace(/[?&]session_id=[^&]*/, "");
        window.history.replaceState(null, "", url.pathname + url.search + newHash);
      } catch { /* ignore */ }
    },
    /** User dismissed the success modal. Keeps `claimed=true` upstream so the
     *  reservation $effect stays blocked (alreadyDone). */
    dismiss(): void {
      visible = false;
      email = null;
    },
  };
}
