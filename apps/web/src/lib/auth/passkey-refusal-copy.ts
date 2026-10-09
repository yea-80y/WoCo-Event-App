/**
 * What the sign-in sheet says when the browser refuses passkeys on this host
 * (`PasskeyBrowserRefusedError`). Organising needs a passkey account, so the one
 * person this must stop is a would-be organiser setting up an email account that
 * can never host; anyone buying tickets can carry on with email. An organiser
 * invite offers no email, so there it only says where passkeys work.
 */
export function passkeyRefusalAdvice(host: string, invite: boolean): string {
  const where = "open WoCo in Chrome, Brave, Edge or Safari";
  if (invite) return `This browser can't use passkeys on ${host}, and hosting events needs one - ${where} to continue.`;
  return `This browser can't use passkeys on ${host}. To host events you need a passkey - ${where}. Just buying tickets? Sign in with email below.`;
}
