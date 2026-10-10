/**
 * Catches Chromium's `beforeinstallprompt` (Chrome, Edge, Samsung Internet, Opera)
 * the moment it fires, so the install offer can call `prompt()` later. The event
 * fires once, early, and is not repeated: a listener added by the lazily loaded
 * banner would usually miss it. So this is imported at boot by main.ts and,
 * like manifest-link.ts, imports nothing.
 *
 * `preventDefault()` keeps the browser's own install bar off the page: it would
 * otherwise appear anywhere, sign-in and checkout included. The browser menu's
 * "Install app" stays available whatever happens to our offer.
 */

/** The parts of Chromium's BeforeInstallPromptEvent we use (not in lib.dom). */
export interface DeferredInstallPrompt {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: DeferredInstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

/** The captured prompt, or null when the browser has not offered one (or it was used). */
export function deferredInstallPrompt(): DeferredInstallPrompt | null {
  return deferred;
}

/** True once the browser reported `appinstalled` in this tab. */
export function installedThisSession(): boolean {
  return installed;
}

/** A prompt can be used once; after `prompt()` it is spent. */
export function consumeInstallPrompt(): DeferredInstallPrompt | null {
  const p = deferred;
  deferred = null;
  if (p) changed();
  return p;
}

/** Called whenever the captured prompt or the installed state changes. Returns an unsubscribe. */
export function onInstallStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Running as the installed app: Chromium/Firefox display mode, or iOS home-screen Safari. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.matchMedia?.("(display-mode: minimal-ui)").matches) return true;
  } catch {
    /* matchMedia unavailable */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as unknown as DeferredInstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    changed();
  });
}
