/**
 * When to offer "install WoCo to your home screen", and how. Pure: the banner
 * passes in what it read from the browser, so every show/hide rule is tested.
 *
 * - `prompt`: a Chromium browser handed us `beforeinstallprompt`; one tap installs.
 * - `ios`: iPhone/iPad Safari (and the other iOS browsers, which share its engine)
 *   has no install API, so we show the steps: Share, then "Add to Home Screen".
 * - `firefox-android`: no install API either; menu, then Install.
 *
 * Never inside a social app's built-in browser (#812): the "Open in Safari/Chrome"
 * notice comes first there, and an install from a web view is not possible anyway.
 */

import { isFirefoxAndroidUserAgent, isIosUserAgent } from "./install-capture.js";

export type InstallOffer = "prompt" | "ios" | "firefox-android";

/**
 * Routes the offer may appear on: the landing page at / (`splitter`, where most
 * people arrive), the attendee home screens and the organiser dashboard. Never
 * sign-in, an event page or checkout.
 */
export const INSTALL_ROUTES: ReadonlySet<string> = new Set(["splitter", "home", "discover", "member-home", "creator-home"]);

/** A dismissal holds this long before the offer may come back once. */
export const DISMISS_GAP_MS = 120 * 24 * 60 * 60 * 1000;

export const INSTALL_MEMORY_KEY = "woco:pwa:install-offer";

export interface InstallMemory {
  /** When the person last said no (our banner's close, or the browser's own dialog). */
  dismissedAt?: number;
  /** They installed from here: never offer again on this browser. */
  installed?: boolean;
}

export interface InstallInputs {
  userAgent: string;
  /** iPadOS reports a desktop Mac; a touch screen says otherwise. */
  touchMac: boolean;
  /** Already running as the installed app (`display-mode: standalone`, `navigator.standalone`). */
  standalone: boolean;
  /** A captured `beforeinstallprompt` is waiting. */
  hasPrompt: boolean;
  /** `detectInAppBrowser(...) !== null`. */
  inAppBrowser: boolean;
  route: string;
  /** A sign-in, signing confirm, account setup or ticket gate is open. */
  busy: boolean;
  memory: InstallMemory;
  now: number;
}

/**
 * How this browser can install, ignoring where and when to offer it: what the
 * permanent "Install the app" row in Profile shows. Null when already installed,
 * inside a social app's browser, or with no install path (desktop Safari/Firefox).
 */
export function installMethod(
  i: Pick<InstallInputs, "userAgent" | "touchMac" | "standalone" | "hasPrompt" | "inAppBrowser"> & { installed?: boolean },
): InstallOffer | null {
  if (i.standalone || i.installed || i.inAppBrowser) return null;
  if (i.hasPrompt) return "prompt";
  if (isIosUserAgent(i.userAgent, i.touchMac)) return "ios";
  if (isFirefoxAndroidUserAgent(i.userAgent)) return "firefox-android";
  return null;
}

/** The banner: an install path, on an offer route, not busy, not recently dismissed. */
export function decideInstallOffer(i: InstallInputs): InstallOffer | null {
  if (i.busy || !INSTALL_ROUTES.has(i.route)) return null;
  if (i.memory.dismissedAt !== undefined && i.now - i.memory.dismissedAt < DISMISS_GAP_MS) return null;
  return installMethod({ ...i, installed: i.memory.installed });
}

/** Storage can be absent or throw (private mode, blocked site data): treat that as "nothing remembered". */
export function readInstallMemory(storage: Pick<Storage, "getItem"> | undefined): InstallMemory {
  try {
    const raw = storage?.getItem(INSTALL_MEMORY_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    const out: InstallMemory = {};
    if (typeof o.dismissedAt === "number" && Number.isFinite(o.dismissedAt)) out.dismissedAt = o.dismissedAt;
    if (o.installed === true) out.installed = true;
    return out;
  } catch {
    return {};
  }
}

export function writeInstallMemory(storage: Pick<Storage, "setItem"> | undefined, memory: InstallMemory): void {
  try {
    storage?.setItem(INSTALL_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* not remembered: the offer may show again next visit, which is harmless */
  }
}
