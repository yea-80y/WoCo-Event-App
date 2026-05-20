/**
 * Frontend API client for Stripe Connect integration.
 */

import { authPost, authGet, apiBase } from "./client.js";
import { auth } from "../auth/auth-store.svelte.js";
import type { SealedBox } from "@woco/shared";

export interface RequirementCategory {
  label: string;
  status: "done" | "pending" | "needed";
}

export interface StripeAccountStatus {
  ok: boolean;
  connected: boolean;
  stripeAccountId?: string;
  onboardingComplete?: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  requirements?: {
    currentlyDue: string[];
    eventuallyDue: string[];
    pendingVerification: string[];
    disabledReason: string | null;
    categories: RequirementCategory[];
  };
}

/** Create a Stripe Connected Account for the authenticated organiser */
export async function connectStripe(): Promise<void> {
  const resp = await authPost("/api/stripe/connect", {});
  if (!resp.ok) throw new Error((resp as any).error || "Failed to create Stripe account");
}

/** Get a hosted onboarding URL (redirects organiser to Stripe) */
export async function getOnboardingLink(): Promise<{ url?: string; alreadyComplete?: boolean }> {
  const resp = await authPost("/api/stripe/onboarding-link", {});
  if (!resp.ok) throw new Error((resp as any).error || "Failed to get onboarding link");
  return resp as any;
}

/** Check the organiser's Stripe account status */
export async function getStripeAccountStatus(): Promise<StripeAccountStatus> {
  const resp = await authGet("/api/stripe/account-status");
  return resp as any as StripeAccountStatus;
}

export async function removeStripeAccount(): Promise<void> {
  const { buildAuthHeaders } = await import("./client.js");
  const path = "/api/stripe/account";
  const authHeaders = await buildAuthHeaders("DELETE", path, "");
  const resp = await fetch(`${apiBase}${path}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}));
    throw new Error((json as any).error ?? "Failed to remove Stripe account");
  }
}

/**
 * Pre-upload the encrypted order payload to Swarm and return the ref.
 *
 * Called BEFORE createCheckoutSession — the returned ref is passed in the
 * checkout body, stored in Stripe session metadata, and attached by the
 * webhook to every ticket in the batch. This eliminates the post-return
 * save-order race that was leaving multi-ticket purchases without attendee
 * data on the dashboard.
 */
export async function prepareStripeOrder(encryptedOrder: SealedBox): Promise<string> {
  const resp = await fetch(`${apiBase}/api/stripe/prepare-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptedOrder }),
  });
  const data = await resp.json() as { ok: boolean; orderRef?: string; error?: string };
  if (!data.ok || !data.orderRef) throw new Error(data.error || "Failed to prepare order");
  return data.orderRef;
}

/**
 * Create a Stripe Checkout Session for an attendee to pay for a ticket.
 *
 * When the user is logged in (any auth kind), the request is signed so the
 * server can bind the claim to the VERIFIED parent wallet — this is what lets
 * us record both wallet + email on Stripe claims. The body never carries the
 * claimer address; the server reads it from the session.
 *
 * Anonymous (no session) flow: email-only. Requires `claimerEmail`.
 */
export async function createCheckoutSession(params: {
  eventId: string;
  seriesId: string;
  claimerEmail?: string;
  quantity?: number;
  orderRef?: string;
  /** Raw encrypted order — server uploads in parallel with Stripe session
   *  creation when no pre-uploaded ref is available. */
  encryptedOrder?: SealedBox;
  /** Slot reservation id from POST /reserve. Server validates + stamps into
   *  Stripe session metadata; webhook consumes on successful claim. */
  reservationId?: string;
}): Promise<{ url: string }> {
  // Browsers strip the Referer path cross-origin (strict-origin-when-cross-origin),
  // so the server can't derive our full base. Pass it explicitly; server validates
  // the host against ALLOWED_HOSTS before using it as the redirect base.
  const returnUrl =
    typeof window !== "undefined"
      ? window.location.href.split("#")[0].split("?")[0]
      : undefined;
  // Full current URL (including hash) so Stripe's cancel button returns the
  // buyer to exactly this page — including standalone ENS event sites.
  const cancelUrl =
    typeof window !== "undefined" ? window.location.href : undefined;

  // If we're on a deployed organiser site, pass the siteId so the server can
  // theme the ticket email + PNG card with the organiser's brand palette.
  const siteId = typeof window !== "undefined"
    ? (window as typeof window & { SITE_CONFIG?: { site?: { siteId?: string } } }).SITE_CONFIG?.site?.siteId
    : undefined;

  const body = {
    eventId: params.eventId,
    seriesId: params.seriesId,
    ...(params.claimerEmail ? { claimerEmail: params.claimerEmail } : {}),
    ...(params.quantity && params.quantity > 1 ? { quantity: params.quantity } : {}),
    ...(params.orderRef ? { orderRef: params.orderRef } : {}),
    ...(params.encryptedOrder ? { encryptedOrder: params.encryptedOrder } : {}),
    ...(params.reservationId ? { reservationId: params.reservationId } : {}),
    ...(siteId ? { siteId } : {}),
    ...(returnUrl ? { returnUrl } : {}),
    ...(cancelUrl ? { cancelUrl } : {}),
  };

  if (auth.isConnected) {
    const resp = await authPost<{ url: string }>("/api/stripe/create-checkout", body);
    const data = resp as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) throw new Error(data.error || "Failed to create checkout session");
    return { url: data.url };
  }

  const resp = await fetch(`${apiBase}/api/stripe/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json() as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) throw new Error(data.error || "Failed to create checkout session");
  return { url: data.url };
}

/** Save encrypted order data after successful Stripe payment.
 *
 * `expectedEditions` is the number of tickets the user paid for. The server
 * uses it to wait until ALL claims for this batch have been written to the
 * claimers feed before attaching the orderRef — otherwise the post-Stripe
 * webhook may still be mid-way through a multi-ticket claim and save-order
 * would attach orderRef only to the already-written entries. */
export async function saveStripeOrder(params: {
  seriesId: string;
  encryptedOrder: SealedBox;
  claimerEmail?: string;
  claimerAddress?: string;
  expectedEditions?: number;
}): Promise<void> {
  const resp = await fetch(`${apiBase}/api/stripe/save-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await resp.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error || "Failed to save order data");
}
