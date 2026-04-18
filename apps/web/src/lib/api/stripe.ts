/**
 * Frontend API client for Stripe Connect integration.
 */

import { authPost, authGet, apiBase } from "./client.js";
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

/** Create a Stripe Checkout Session for an attendee to pay for a ticket */
export async function createCheckoutSession(params: {
  eventId: string;
  seriesId: string;
  claimerEmail?: string;
  claimerAddress?: string;
}): Promise<{ url: string }> {
  const resp = await fetch(`${apiBase}/api/stripe/create-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await resp.json() as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) throw new Error(data.error || "Failed to create checkout session");
  return { url: data.url };
}

/** Save encrypted order data after successful Stripe payment */
export async function saveStripeOrder(params: {
  seriesId: string;
  encryptedOrder: SealedBox;
  claimerEmail?: string;
  claimerAddress?: string;
}): Promise<void> {
  const resp = await fetch(`${apiBase}/api/stripe/save-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await resp.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error || "Failed to save order data");
}
