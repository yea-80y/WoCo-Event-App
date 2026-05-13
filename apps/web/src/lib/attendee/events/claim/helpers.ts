import type { OrderField, PaymentChainId, ClaimMode } from "@woco/shared";
import { CHAIN_INFO } from "../../../payment/chains.js";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "\u00a3",
  EUR: "\u20ac",
};

export const CHAIN_COLORS: Record<number, string> = {
  1: "#627eea",
  8453: "#0052ff",
  10: "#ff0420",
  11155111: "#888",
};

export function explorerUrl(chainId: PaymentChainId, txHash: string): string {
  return `${CHAIN_INFO[chainId].blockExplorer}/tx/${txHash}`;
}

export function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}\u2026${h.slice(-6)}` : h;
}

export async function copyToClipboard(text: string | null | undefined): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

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

/** Resolve the buyer's email from form fields or the inline input. */
export function getEmailFromForm(
  formData: Record<string, string>,
  orderFields: OrderField[] | undefined,
  inlineEmail: string,
): string | null {
  const email = formData["__email"]?.trim();
  if (email && email.includes("@")) return email;
  if (orderFields) {
    for (const f of orderFields) {
      if (f.type === "email") {
        const val = formData[f.id]?.trim();
        if (val && val.includes("@")) return val;
      }
    }
  }
  const inline = inlineEmail.trim();
  if (inline && inline.includes("@")) return inline;
  return null;
}

/** Determine the effective claim method for this click. */
export function effectiveMethod(
  claimMode: ClaimMode,
  chosenMethod: "wallet" | "email" | null,
  authConnected: boolean,
): "wallet" | "email" {
  if (claimMode === "wallet") return "wallet";
  if (claimMode === "email") return "email";
  if (chosenMethod) return chosenMethod;
  return authConnected ? "wallet" : "email";
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
