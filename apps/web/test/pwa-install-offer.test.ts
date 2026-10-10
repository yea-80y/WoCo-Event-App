/**
 * Home-screen install offer, stage 2. Who sees which offer, and every rule that
 * keeps it away: already installed, a social app's built-in browser, sign-in or
 * checkout, a recent "not now", and storage that is missing or throws.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideInstallOffer,
  installMethod,
  showInstallCard,
  readInstallMemory,
  writeInstallMemory,
  DISMISS_GAP_MS,
  INSTALL_MEMORY_KEY,
  INSTALL_ROUTES,
  type InstallInputs,
} from "../src/lib/pwa/install-offer.js";
import { detectInAppBrowser } from "../src/lib/browser/in-app-browser.js";

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const GOOGLE_APP_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/359.0.812345678 Mobile/15E148 Safari/604.1";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0";
const FIREFOX_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const NOW = 1_800_000_000_000;

function inputs(over: Partial<InstallInputs> = {}): InstallInputs {
  return {
    userAgent: ANDROID_CHROME,
    touchMac: false,
    standalone: false,
    hasPrompt: false,
    inAppBrowser: false,
    route: "home",
    busy: false,
    memory: {},
    now: NOW,
    ...over,
  };
}

test("each browser gets its own offer", () => {
  assert.equal(decideInstallOffer(inputs({ userAgent: ANDROID_CHROME, hasPrompt: true })), "prompt");
  assert.equal(decideInstallOffer(inputs({ userAgent: SAMSUNG, hasPrompt: true })), "prompt");
  assert.equal(decideInstallOffer(inputs({ userAgent: DESKTOP_CHROME, hasPrompt: true })), "prompt");
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI })), "ios");
  assert.equal(decideInstallOffer(inputs({ userAgent: IPAD_DESKTOP_UA, touchMac: true })), "ios");
  assert.equal(decideInstallOffer(inputs({ userAgent: IOS_CHROME })), "ios", "iOS Chrome adds to the home screen from its share sheet too");
  assert.equal(decideInstallOffer(inputs({ userAgent: FIREFOX_ANDROID })), "firefox-android");
});

test("no install path, no offer: Chromium before (or without) its prompt, desktop Firefox, desktop Safari", () => {
  assert.equal(decideInstallOffer(inputs({ userAgent: ANDROID_CHROME, hasPrompt: false })), null);
  assert.equal(decideInstallOffer(inputs({ userAgent: FIREFOX_DESKTOP })), null);
  assert.equal(decideInstallOffer(inputs({ userAgent: IPAD_DESKTOP_UA, touchMac: false })), null);
});

test("never when already installed", () => {
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, standalone: true })), null);
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI, standalone: true })), null);
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, memory: { installed: true } })), null);
});

test("never inside a social app's built-in browser - the open-in-browser notice comes first", () => {
  assert.ok(detectInAppBrowser(GOOGLE_APP_IOS), "fixture: the Google app is detected as an in-app browser");
  assert.equal(detectInAppBrowser(IPHONE_SAFARI), null, "fixture: real Safari is not");
  assert.equal(decideInstallOffer(inputs({ userAgent: GOOGLE_APP_IOS, inAppBrowser: true })), null);
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, inAppBrowser: true })), null);
});

test("only on the landing page and the home screens, never during sign-in, signing or checkout", () => {
  for (const route of ["splitter", "home", "discover", "member-home", "creator-home"]) assert.ok(INSTALL_ROUTES.has(route), route);
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI, route: "splitter" })), "ios", "the landing page at / is where most people arrive");
  for (const route of INSTALL_ROUTES) assert.equal(decideInstallOffer(inputs({ hasPrompt: true, route })), "prompt", route);
  for (const route of ["event", "event-purchased", "signup", "profile", "protect", "passkeys", "link", "recover", "legal", "about", "invite"]) {
    assert.equal(decideInstallOffer(inputs({ hasPrompt: true, route })), null, route);
  }
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, busy: true })), null);
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI, busy: true })), null);
});

test("a dismissal holds for the long gap, then the offer may come back", () => {
  const justNow = { dismissedAt: NOW - 1000 };
  const almost = { dismissedAt: NOW - DISMISS_GAP_MS + 1 };
  const past = { dismissedAt: NOW - DISMISS_GAP_MS };
  assert.equal(DISMISS_GAP_MS, 14 * 24 * 60 * 60 * 1000, "a closed banner asks once more after two weeks; the bottom card covers the gap");
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, memory: justNow })), null);
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI, memory: almost })), null);
  assert.equal(decideInstallOffer(inputs({ hasPrompt: true, memory: past })), "prompt");
});

test("the memory survives storage that is missing, throws or holds junk", () => {
  const throwing = {
    getItem(): string | null {
      throw new Error("SecurityError");
    },
    setItem(): void {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual(readInstallMemory(undefined), {});
  assert.deepEqual(readInstallMemory(throwing), {});
  assert.doesNotThrow(() => writeInstallMemory(throwing, { dismissedAt: NOW }));
  assert.doesNotThrow(() => writeInstallMemory(undefined, { dismissedAt: NOW }));
  for (const junk of ["not json", "null", "42", '{"dismissedAt":"yesterday","installed":"yes"}']) {
    assert.deepEqual(readInstallMemory({ getItem: () => junk }), {}, junk);
  }

  const map = new Map<string, string>();
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  writeInstallMemory(store, { dismissedAt: NOW, installed: true });
  assert.ok(map.has(INSTALL_MEMORY_KEY));
  assert.deepEqual(readInstallMemory(store), { dismissedAt: NOW, installed: true });
});

test("the prompt is captured at boot; the banner itself stays out of the first load", () => {
  const mainTs = readFileSync(new URL("../src/main.ts", import.meta.url), "utf-8");
  const capture = readFileSync(new URL("../src/lib/pwa/install-capture.ts", import.meta.url), "utf-8");
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");
  const slot = read("../src/lib/pwa/InstallSlot.svelte");
  assert.match(mainTs, /import '\.\/lib\/pwa\/install-capture'/, "beforeinstallprompt fires once, early: it must be heard at boot");
  assert.ok(!/^\s*import\s/m.test(capture), "install-capture.ts imports nothing, so it adds nothing to boot");
  // Every placement goes through the one slot, which fetches the banner lazily and only where an install is possible.
  assert.match(slot, /\{#if installable && INSTALL_ROUTES\.has\(router\.route\)\}\s*\{#await import\("\.\/InstallBanner\.svelte"\)/);
  for (const host of [
    "../src/AttendeeApp.svelte",
    "../src/lib/layouts/CreatorShell.svelte",
    "../src/lib/landing/Splitter.svelte",
    "../src/lib/pwa/InstallSlot.svelte",
    "../src/lib/components/profile/ProfilePage.svelte",
  ]) {
    const src = read(host);
    assert.ok(!/import\s+InstallBanner\s+from/.test(src), `${host}: the banner component is loaded lazily, never statically`);
  }
  assert.match(read("../src/AttendeeApp.svelte"), /<InstallSlot \/>/);
  assert.match(read("../src/lib/landing/Splitter.svelte"), /<InstallSlot \/>/, "the landing page at / offers the install too");
  assert.match(read("../src/lib/layouts/CreatorShell.svelte"), /<InstallSlot \/>/, "the organiser dashboard offers it too");
  // The bottom card on the landing page, attendee home and organiser dashboard, lazily loaded.
  assert.match(read("../src/lib/pwa/InstallCardSlot.svelte"), /\{#if installable && INSTALL_ROUTES\.has\(router\.route\)\}\s*\{#await import\("\.\/InstallAppRow\.svelte"\)/);
  for (const host of ["../src/AttendeeApp.svelte", "../src/lib/layouts/CreatorShell.svelte", "../src/lib/landing/Splitter.svelte"]) {
    assert.match(read(host), /<InstallCardSlot \/>/, host);
  }
  // The permanent entry: Profile's Account card, shared by both portals, lazily loaded.
  assert.match(read("../src/lib/components/profile/ProfilePage.svelte"), /\{#await import\("\.\.\/\.\.\/pwa\/InstallAppRow\.svelte"\)/);
});

test("the boot capture holds the prompt once, hides the browser's own bar, and knows the installed app", async () => {
  const handlers = new Map<string, (e: unknown) => void>();
  let standalone = false;
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  g.window = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    matchMedia: (q: string) => ({ matches: standalone && q === "(display-mode: standalone)" }),
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: DESKTOP_CHROME, maxTouchPoints: 0 },
    configurable: true,
  });
  try {
    // A fresh instance, so its top level runs with the stubbed window above.
    const cap = await import(`../src/lib/pwa/install-capture.ts?boot=${Date.now()}`);
    assert.ok(handlers.has("beforeinstallprompt") && handlers.has("appinstalled"));
    assert.equal(cap.installPathExists(), false, "desktop Chrome before its prompt: the banner chunk is not fetched");

    let changes = 0;
    cap.onInstallStateChange(() => changes++);
    let prevented = false;
    const event = { preventDefault: () => (prevented = true), prompt: async () => {}, userChoice: Promise.resolve({ outcome: "accepted" }) };
    handlers.get("beforeinstallprompt")!(event);
    assert.ok(prevented, "the browser's own install bar would otherwise show anywhere, checkout included");
    assert.equal(cap.deferredInstallPrompt(), event);
    assert.equal(cap.installPathExists(), true);
    assert.equal(changes, 1);

    assert.equal(cap.consumeInstallPrompt(), event);
    assert.equal(cap.consumeInstallPrompt(), null, "a prompt can be used once");
    assert.equal(cap.installPathExists(), false);

    handlers.get("appinstalled")!({});
    assert.equal(cap.installedThisSession(), true);

    standalone = true;
    assert.equal(cap.isStandalone(), true);
    handlers.get("beforeinstallprompt")!(event);
    assert.equal(cap.installPathExists(), false, "never offered inside the installed app");

    standalone = false;
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: IPHONE_SAFARI, standalone: true, maxTouchPoints: 5 }, configurable: true });
    assert.equal(cap.isStandalone(), true, "iOS home-screen Safari reports navigator.standalone");
  } finally {
    g.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
});

test("the permanent Profile row ignores route and dismissal, never the installed app", () => {
  const base = { userAgent: IPHONE_SAFARI, touchMac: false, standalone: false, hasPrompt: false, inAppBrowser: false };
  assert.equal(installMethod(base), "ios", "iOS gets the Add to Home Screen steps");
  assert.equal(installMethod({ ...base, userAgent: ANDROID_CHROME, hasPrompt: true }), "prompt");
  assert.equal(installMethod({ ...base, userAgent: FIREFOX_ANDROID }), "firefox-android");
  assert.equal(installMethod({ ...base, standalone: true }), null, "hidden inside the installed app");
  assert.equal(installMethod({ ...base, installed: true }), null);
  assert.equal(installMethod({ ...base, inAppBrowser: true }), null);
  assert.equal(installMethod({ ...base, userAgent: FIREFOX_DESKTOP }), null, "no install path: no row");
  // A banner dismissal does not hide the permanent row.
  assert.equal(decideInstallOffer(inputs({ userAgent: IPHONE_SAFARI, memory: { dismissedAt: NOW } })), null);
});

test("the bottom card waits while the banner asks, then stays until installed", () => {
  const base = { userAgent: IPHONE_SAFARI, touchMac: false, standalone: false, hasPrompt: false, inAppBrowser: false, now: NOW };
  assert.equal(showInstallCard({ ...base, memory: {} }), false, "the banner is asking: one ask per screen");
  assert.equal(showInstallCard({ ...base, memory: { dismissedAt: NOW - 1 } }), true, "banner closed: the card takes over");
  assert.equal(showInstallCard({ ...base, memory: { dismissedAt: NOW - DISMISS_GAP_MS } }), false, "the banner is back, so the card steps aside");
  assert.equal(showInstallCard({ ...base, memory: { dismissedAt: NOW - 1, installed: true } }), false);
  assert.equal(showInstallCard({ ...base, standalone: true, memory: { dismissedAt: NOW - 1 } }), false);
  assert.equal(showInstallCard({ ...base, userAgent: FIREFOX_DESKTOP, memory: { dismissedAt: NOW - 1 } }), false);
});
