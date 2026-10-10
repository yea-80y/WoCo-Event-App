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

/** An iPhone or iPad, from what the page can see. iPadOS Safari reports a desktop
 *  Mac, so a Mac user agent with a touch screen is an iPad. */
export function appleTouchDevice(userAgent: string, maxTouchPoints: number): "iPhone" | "iPad" | null {
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "iPad";
  return null;
}

/**
 * A passkey CREATION on an iPhone or iPad that ended after a sheet was up (a
 * friend's iPhone, iOS 26.6.2, 2026-10-10). With no password manager turned on
 * for passkeys, iOS answers "Create" with "Choose how to manage your passkeys"
 * (Open Settings / More Options) instead of saving one, and closing it rejects
 * the creation exactly as a cancelled save sheet does - the page cannot tell the
 * two apart, so the words cover both. No page can turn a password manager on.
 *
 * More Options offers a QR code or a security key: a passkey made there lives on
 * the other device or key, not on this one, so the words point at Passwords.
 * (A primary creation does not refuse such an answer today, unlike "Add a
 * passkey" - flagged for the owner, not changed here.)
 */
export function passkeyCreateRefusedAdvice(device: "iPhone" | "iPad", invite: boolean): string {
  const steps =
    `If your ${device} said "Choose how to manage your passkeys", it has no password manager set up for passkeys: ` +
    `open Settings › General › AutoFill & Passwords, turn on Passwords, then tap Create again ` +
    `(not More Options - that puts the passkey on another device or a security key). If you closed the prompt yourself, just tap Create again.`;
  return invite ? `No passkey was saved. ${steps}` : `No passkey was saved. ${steps} Just buying tickets? Continue with Email below.`;
}
