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
  if (/iP(?:hone|od)/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "iPad";
  return null;
}


/**
 * What an iPhone or iPad needs before it can save a WoCo passkey, in the order to
 * check them (a friend's iPhone 17, 2026-10-10/11). iOS answers "Create" with
 * "Choose how to manage your passkeys" when no password manager is set up for
 * passkeys. Hers listed only Google Passwords: Apple's Passwords had vanished from
 * AutoFill because its app had been deleted (iOS 18+ ties Apple's provider to that
 * app), and reinstalling it brought it back. Apple's passkeys also need iCloud
 * Keychain and a device passcode, and a managed profile or Screen Time can switch
 * the whole thing off. No page can change any of these.
 */
export function passkeySetupSteps(device: "iPhone" | "iPad"): string {
  return (
    `1) Settings › General › AutoFill & Passwords: turn on AutoFill Passwords and Passkeys and tick Passwords ` +
    `(if Passwords is not listed, install Apple's Passwords app from the App Store - your ${device} only offers it with the app). ` +
    `2) Settings › your name › iCloud › Passwords: turn on Sync this ${device}. ` +
    `3) Settings › Face ID & Passcode: a passcode must be set. ` +
    `4) A work or school profile, or Screen Time limits, can turn passkeys off - ask whoever manages the ${device}.`
  );
}

/**
 * A passkey CREATION on an iPhone or iPad that ended after a sheet was up. With no
 * password manager set up for passkeys, iOS shows "Choose how to manage your
 * passkeys" (Open Settings / More Options) instead of saving one, and closing it
 * rejects the creation exactly as a cancelled save sheet does - the page cannot
 * tell the two apart, so the words cover both.
 *
 * More Options offers a QR code or a security key: a passkey made there lives on
 * the other device or key, not on this one, so the words point at Passwords.
 * (A primary creation does not refuse such an answer today, unlike "Add a
 * passkey" - flagged for the owner, not changed here.)
 */
export function passkeyCreateRefusedAdvice(device: "iPhone" | "iPad", invite: boolean): string {
  const steps =
    `If your ${device} said "Choose how to manage your passkeys", it is not set up for passkeys yet. Check, in this order: ` +
    `${passkeySetupSteps(device)} Then tap Create again ` +
    `(not More Options - that puts the passkey on another device or a security key). If you closed the prompt yourself, just tap Create again.`;
  return invite ? `No passkey was saved. ${steps}` : `No passkey was saved. ${steps} Just buying tickets? Continue with email or Google below.`;
}

/**
 * Before any ceremony (`passkey-readiness.ts`): the device says it cannot save a
 * passkey yet. Advice only - the buttons stay, because the check can be wrong and
 * email and Google never need it.
 */
export function passkeyNotReadyNotice(device: "iPhone" | "iPad", invite: boolean): string {
  const head = `This ${device} isn't set up to save passkeys yet, so Create would stop at an iOS settings sheet. Before you tap it: `;
  return invite ? head + passkeySetupSteps(device) : `${head}${passkeySetupSteps(device)} Just buying tickets? Email and Google work without this.`;
}

/** Before any ceremony: the browser says outright that it has no PRF, so no WoCo passkey can be made in it. */
export function passkeyNoPrfNotice(invite: boolean): string {
  const where = "Open WoCo in Safari on an iPhone, iPad or Mac, or in Chrome, to make one.";
  return invite
    ? `This browser can't make a WoCo passkey, and hosting events needs one. ${where}`
    : `This browser can't make a WoCo passkey. ${where} Just buying tickets? Email and Google work here.`;
}

/**
 * A creation that SAVED a passkey (Face ID done) in a password manager that cannot
 * give WoCo its secret (`PasskeyPrfUnsupportedError` carrying the manager read from
 * the new credential). No account exists, that passkey is useless, and Create again
 * could land in the same manager - so: delete it, and save the next one in Apple's
 * Passwords.
 */
export function passkeyNoSecretAdvice(
  device: "iPhone" | "iPad",
  provider: { id: string; name: string } | null,
  invite: boolean,
): string {
  const tail = invite ? "" : " Just buying tickets? Continue with email or Google below.";
  if (provider?.id === "apple-passwords") {
    // Apple's own manager gives the secret from iOS 18; before that, "save it in
    // Passwords" would send the person round in a circle.
    return (
      `Apple Passwords saved the passkey but this version of iOS can't give WoCo the secret your account is made from, so no account was made. ` +
      `Update to iOS 18 or later (Settings › General › Software Update), delete the "WoCo Account" passkey from Passwords, then tap Create again.` +
      tail
    );
  }
  const providerName = provider?.name ?? null;
  const who = providerName ?? "That password manager";
  const from = providerName ? ` from ${providerName}` : "";
  const s =
    `${who} saved the passkey but can't give WoCo the secret your account is made from, so no account was made. ` +
    `Delete the "WoCo Account" passkey${from}, then tap Create again and save it in Passwords (Apple's). ` +
    `If your ${device} doesn't offer Passwords: ${passkeySetupSteps(device)}`;
  return s + tail;
}
