/// <reference types="vite-plugin-pwa/vanillajs" />
/**
 * Keeps the door scanner on its newest version with nobody pressing reload.
 *
 * Until 2026-10-14 the scanner's service worker was registered by the plugin's
 * injected script, which never reloads an open page: a phone that installed a
 * newer worker kept running the old code until someone reloaded by hand - the
 * owner's phone ran July's scanner against a September server, which refused
 * it as outdated.
 *
 * The worker still takes over as soon as it is installed (skipWaiting +
 * clientsClaim), so a phone heals on its next load even if this page never gets
 * to act. This module is the page's side: it asks for updates, notices when a
 * newer worker controls the page, and says so. The store decides when to reload.
 */
import { registerSW } from "virtual:pwa-register";

const CHECK_EVERY_MS = 30 * 60_000;
/** Coming back to the scanner checks again once this much has passed. */
const CHECK_ON_RETURN_MS = 5 * 60_000;

let registration: Promise<ServiceWorkerRegistration | undefined> = Promise.resolve(undefined);
let tookOver = false;
let lastCheckAt = 0;
const waiters = new Set<() => void>();
let notify: () => void = () => {};

function newVersionActive(): void {
  tookOver = true;
  for (const resolve of waiters) resolve();
  waiters.clear();
  notify();
}

/** Resolves undefined after `ms`; a rejection still rejects. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function startScannerUpdates(onNewVersion: () => void): void {
  notify = onNewVersion;
  if (!("serviceWorker" in navigator)) return;

  // The first worker to claim a page that loaded without one is not a new version.
  let controlled = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (controlled) newVersionActive();
    controlled = true;
  });

  registration = new Promise((resolve) => {
    registerSW({
      immediate: true,
      onNeedReload: newVersionActive,
      onRegisteredSW: (_url, reg) => resolve(reg),
      onRegisterError: () => resolve(undefined),
    });
  });

  setInterval(() => void takeoverIfNewer().catch(() => false), CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastCheckAt >= CHECK_ON_RETURN_MS) {
      void takeoverIfNewer().catch(() => false);
    }
  });
}

/**
 * Ask for a newer scanner now. True once a newer one has taken over this page,
 * and a reload must follow; false when there is none, or it could not be asked.
 */
export async function takeoverIfNewer(timeoutMs = 6_000): Promise<boolean> {
  if (tookOver) return true;
  // No worker controls this page, so its code came from the network, not a cache.
  // The worker installing now is the first one, not a newer version: waiting for
  // it to "take over" would only delay a first-time door phone by the timeout.
  if (!("serviceWorker" in navigator) || navigator.serviceWorker.controller === null) return false;
  const reg = await within(registration, 2_000);
  if (!reg) return false;

  let arrive!: () => void;
  const arrived = new Promise<true>((resolve) => (arrive = () => resolve(true)));
  waiters.add(arrive);
  try {
    lastCheckAt = Date.now();
    try {
      await within(reg.update(), timeoutMs);
    } catch {
      // Offline, or no worker script to fetch: nothing newer can be found now.
      return tookOver;
    }
    if (!tookOver && !reg.installing && !reg.waiting) return false;
    return (await within(arrived, timeoutMs)) === true;
  } finally {
    waiters.delete(arrive);
  }
}
