import type { OrderField } from "../crypto/types.js";

/**
 * Which address a ticket goes to - ONE rule for the main app's checkout and the
 * embed widget (#597). Two copies of this drifted: the embed rendered the order
 * form's email field and then read only its own box, so a buyer who filled the
 * obvious one could not buy.
 *
 * Only the platform's own field counts. An organiser can add any email-typed
 * field ("Guest's email"), and whatever this returns becomes the ticket's
 * delivery address, Stripe's prefill, the masked confirmation and the address
 * a marketing opt-in is recorded against - so a guess here is never safe.
 */
export const ORDER_EMAIL_FIELD_ID = "__email";

/**
 * Is the order form actually on screen? Its answers are sealed to the
 * organiser's encryption key, so without that key neither surface renders the
 * fields - and a field that is not rendered cannot be where the email comes from.
 */
export function orderFormShown(
  fields: readonly OrderField[] | undefined,
  encryptionKey: string | undefined,
): boolean {
  return !!fields?.length && !!encryptionKey;
}

/**
 * Does the shown form collect the ticket address? When true the surface hides
 * its own email box; when false it must show one, or a guest has nowhere to
 * type an address.
 */
export function orderFormCollectsEmail(
  fields: readonly OrderField[] | undefined,
  encryptionKey: string | undefined,
): boolean {
  return orderFormShown(fields, encryptionKey) && fields!.some((f) => f.id === ORDER_EMAIL_FIELD_ID);
}

/**
 * The buyer's address: the form's email field when the form collects one, else
 * the surface's own box. Null when the chosen source holds no plausible
 * address - the two are never mixed, because only one of them is on screen.
 */
export function resolveBuyerEmail(
  formData: Record<string, string>,
  fields: readonly OrderField[] | undefined,
  encryptionKey: string | undefined,
  inlineEmail: string,
): string | null {
  const raw = orderFormCollectsEmail(fields, encryptionKey)
    ? formData[ORDER_EMAIL_FIELD_ID] ?? ""
    : inlineEmail;
  const email = raw.trim();
  return email && email.includes("@") ? email : null;
}
