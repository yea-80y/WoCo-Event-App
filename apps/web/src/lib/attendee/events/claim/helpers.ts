/**
 * Synchronously compute the initial Stripe-success state at script-init time
 * (BEFORE the first render). The URL hash is the canonical signal of a fresh
 * return; once onMount strips it, a refresh will not re-trigger the modal.
 * Email + qty are read from the form stash that was written when Pay was clicked.
 */
export function initialStripeSuccess(
  eventId: string,
  seriesId: string,
): { email: string | null; qty: number; visible: boolean } {
  if (typeof window === "undefined") return { email: null, qty: 1, visible: false };
  const hash = window.location.hash;
  if (!hash.includes("stripe=success")) return { email: null, qty: 1, visible: false };

  const formKey = `woco:stripe-form:${eventId}:${seriesId}`;
  let email: string | null = null;
  let qty = 1;
  try {
    const raw = sessionStorage.getItem(formKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { claimerEmail?: string; quantity?: number };
      email = parsed.claimerEmail ?? null;
      if (parsed.quantity && Number.isInteger(parsed.quantity)) qty = parsed.quantity;
    }
  } catch { /* ignore */ }
  return { email, qty, visible: true };
}


/**
 * Build the snapshot string identifying the encrypted-order payload. The
 * pre-uploaded ref is only reused when the current snapshot still matches
 * the snapshot the ref was built from.
 */
export function buildOrderSnapshot(
  formData: Record<string, string>,
  email: string,
  address: string,
): string {
  return JSON.stringify({ formData, email, address });
}
