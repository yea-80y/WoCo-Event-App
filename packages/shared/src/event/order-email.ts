import type { OrderField } from "../crypto/types.js";
import { ORDER_EMAIL_FIELD_ID } from "./order-email-id.js";
import { isHealthField } from "./order-field-kinds.js";

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
export { ORDER_EMAIL_FIELD_ID };

/**
 * Is the order form actually on screen? Its answers are sealed to the
 * organiser's encryption key, so without that key neither surface renders the
 * fields - and a field that is not rendered cannot be where the email comes from.
 *
 * `verifiedKey` is the key BYTES a surface fetched and verified against the
 * event's `encryptionKeyRef` (`fetchOrderKey`, #642) — never a string lifted from
 * the feed — so the form can only show when there is a real key to seal to.
 */
export function orderFormShown(
  fields: readonly OrderField[] | undefined,
  verifiedKey: Uint8Array | undefined,
): boolean {
  return !!fields?.length && !!verifiedKey;
}

/**
 * Does the shown form collect the ticket address? When true the surface hides
 * its own email box; when false it must show one, or a guest has nowhere to
 * type an address.
 */
export function orderFormCollectsEmail(
  fields: readonly OrderField[] | undefined,
  verifiedKey: Uint8Array | undefined,
): boolean {
  return orderFormShown(fields, verifiedKey) && fields!.some((f) => f.id === ORDER_EMAIL_FIELD_ID);
}

/**
 * Must the buyer fill this field before paying? The organiser's tick, plus one
 * rule both surfaces share (#639): the platform's email field is required
 * whenever the buyer has no account the ticket can go to instead, because the
 * field is then the only way the ticket can arrive. The embed never has one; the
 * main app has one when the buyer is signed in.
 */
export function orderFieldRequired(field: OrderField, opts: { canUseAccount: boolean }): boolean {
  // A health answer is only explicit consent if giving it was optional - whatever
  // the organiser-signed form says. Never the platform's email field, which is how
  // the ticket arrives.
  if (field.id !== ORDER_EMAIL_FIELD_ID && isHealthField(field)) return false;
  return field.required || (field.id === ORDER_EMAIL_FIELD_ID && !opts.canUseAccount);
}

/**
 * Does the Confirm email box match the ticket address (#982)? A ticket's QR exists
 * only in its email, so a typo loses the ticket. Trimmed and case-insensitive. A
 * blank address is nothing to confirm: the "enter an email" checks own that case.
 */
export function buyerEmailConfirmed(typed: string, confirm: string): boolean {
  const address = typed.trim().toLowerCase();
  return !address || address === confirm.trim().toLowerCase();
}

/**
 * Should "The emails don't match" show? While the buyer is still typing in the
 * confirm box, only once typing more cannot make a match - never on each keystroke.
 * Once they have left it (`settled`), on any mismatch: a correct confirm can be a
 * prefix of a typo'd first box ("bob@gmail.comn"), the very slip this exists for.
 */
export function buyerEmailMismatch(typed: string, confirm: string, settled: boolean): boolean {
  const c = confirm.trim().toLowerCase();
  if (!c || buyerEmailConfirmed(typed, confirm)) return false;
  return settled || !typed.trim().toLowerCase().startsWith(c);
}

/**
 * The buyer's address: the form's email field when the form collects one, else
 * the surface's own box. Null when the chosen source holds no plausible
 * address - the two are never mixed, because only one of them is on screen.
 */
export function resolveBuyerEmail(
  formData: Record<string, string>,
  fields: readonly OrderField[] | undefined,
  verifiedKey: Uint8Array | undefined,
  inlineEmail: string,
): string | null {
  const raw = orderFormCollectsEmail(fields, verifiedKey)
    ? formData[ORDER_EMAIL_FIELD_ID] ?? ""
    : inlineEmail;
  const email = raw.trim();
  return email && email.includes("@") ? email : null;
}
