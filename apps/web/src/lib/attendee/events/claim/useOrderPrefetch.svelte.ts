import { sealJson } from "@woco/shared";

interface UseOrderPrefetchOpts {
  /** Series ID — baked into the SealedBox payload. */
  seriesId: string;
  /** Organizer's X25519 public key. When undefined the hook does nothing. */
  encryptionKey: string | undefined;
  /** Reactive: should we currently be pre-uploading? Typically `showOrderForm
   *  && stripeAfterForm && !!encryptionKey && formValid()`. Read inside the
   *  $effect so any dep change re-evaluates. */
  getShouldPrefetch: () => boolean;
  /** Reactive: cheap stable identifier for the current form payload. When this
   *  string changes the existing `ref` is treated as stale and re-uploaded. */
  getSnapshot: () => string;
  /** Reactive accessor for the form values to seal. */
  getFormData: () => Record<string, string>;
  /** Reactive: claimer email (may be empty string if no email yet). */
  getEmail: () => string;
  /** Reactive: claimer address lowercased (may be empty string). */
  getAddress: () => string;
  /** Quantity getter — included so changes invalidate the in-flight upload. */
  getQuantity: () => number;
  /** Bumped by Pay-button hover/focus/touchstart to fast-track the upload past
   *  the 1500ms idle debounce. Read inside the $effect. */
  getPayHoverTick: () => number;
}

/**
 * Order-prefetch state hook — uploads the SealedBox encrypted-order payload
 * to Swarm in the background while the buyer is still filling the form, so
 * that Pay-click can ship the ref to Stripe with no upload latency.
 *
 *  - 1500ms idle debounce after typing, 0ms on first-fire and on hover
 *    accelerator so the cold path (fill+click fast) doesn't wait.
 *  - Snapshot dedup: if the payload hasn't changed, skip the upload.
 *  - Sequence number cancels stale uploads when a newer trigger fires.
 *  - Returns the in-flight Promise so the Pay handler can `await` an upload
 *    that hasn't resolved yet instead of starting a duplicate inline upload.
 *  - All state clears when shouldPrefetch flips false (form closes, becomes
 *    invalid). `firstFired` resets only on form close so re-validating an
 *    open form keeps the typing debounce active.
 */
export function useOrderPrefetch(opts: UseOrderPrefetchOpts) {
  let ref = $state<string | null>(null);
  let refSnapshot: string | null = null;
  let uploading = $state(false);

  let _timer: ReturnType<typeof setTimeout> | null = null;
  let _seq = 0;
  let _inflight: Promise<{ ref: string | null; snapshot: string | null }> | null = null;
  let _firstFired = false;

  $effect(() => {
    // Capture reactive dependencies at the top so Svelte tracks them.
    const shouldPrefetch = opts.getShouldPrefetch();
    const snapshot = opts.getSnapshot();
    const accelerated = opts.getPayHoverTick() > 0;
    // Touch quantity so any change re-runs the effect (matches prior behaviour).
    const _q = opts.getQuantity();
    void _q;

    if (!shouldPrefetch) {
      ref = null;
      refSnapshot = null;
      _inflight = null;
      // Reset first-fire so the next time the form opens/validates we eager-fire.
      _firstFired = false;
      return;
    }

    const email = opts.getEmail();
    const address = opts.getAddress();
    if (!email && !address) return;

    // Fresh ref for this exact snapshot — skip redundant upload.
    if (ref && refSnapshot === snapshot && !accelerated) return;

    // Snapshot diverged → existing ref is stale. Drop it so a Pay-click
    // mid-typing falls back to the inline upload (which uses live form data)
    // rather than shipping the outdated ref to Stripe.
    if (refSnapshot !== snapshot) {
      ref = null;
      refSnapshot = null;
    }

    if (_timer) clearTimeout(_timer);
    const mySeq = ++_seq;
    const capturedSnapshot = snapshot;
    const formData = opts.getFormData();
    const encryptionKey = opts.encryptionKey;
    if (!encryptionKey) return;
    // 0ms on first fire (form just became valid) and on Pay accelerator;
    // otherwise 1500ms idle so typing doesn't spam orphan SealedBoxes.
    const delay = accelerated || !_firstFired ? 0 : 1500;
    _firstFired = true;
    _timer = setTimeout(() => {
      uploading = true;
      const work = (async (): Promise<{ ref: string | null; snapshot: string | null }> => {
        try {
          const sealed = await sealJson(encryptionKey, {
            fields: formData,
            seriesId: opts.seriesId,
            ...(address ? { claimerAddress: address } : {}),
            ...(email ? { claimerEmail: email } : {}),
          });
          const { prepareStripeOrder } = await import("../../../api/stripe.js");
          const uploadedRef = await prepareStripeOrder(sealed);
          // A later trigger may have superseded us — drop stale result silently.
          if (mySeq === _seq) {
            ref = uploadedRef;
            refSnapshot = capturedSnapshot;
          }
          return { ref: uploadedRef, snapshot: capturedSnapshot };
        } catch (err) {
          console.warn("[ClaimButton] pre-upload failed, will fall back on Pay click:", err);
          if (mySeq === _seq) {
            ref = null;
            refSnapshot = null;
          }
          return { ref: null, snapshot: null };
        } finally {
          if (mySeq === _seq) {
            uploading = false;
            _inflight = null;
          }
        }
      })();
      _inflight = work;
    }, delay);
  });

  return {
    /** Latest uploaded ref, or null if nothing fresh is available. */
    get ref() { return ref; },
    /** True while the background upload is mid-flight (drives Pay shimmer). */
    get uploading() { return uploading; },
    /** Snapshot string that produced `ref`. Pay-click compares to live
     *  snapshot to reject a stale ref. */
    get refSnapshot() { return refSnapshot; },
    /** In-flight upload Promise — Pay handler awaits this instead of starting
     *  a duplicate inline upload. Null when no upload is pending. */
    get inflight() { return _inflight; },
  };
}
