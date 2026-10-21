/**
 * The app's side of the passkey sign-in window: open it, send it one request, hear its
 * answer. Every passkey ceremony runs in that window on the passkey host, so the app
 * never calls WebAuthn and never holds the PRF output - only the keys the window
 * derives from it (`@woco/shared` auth/passkey-window-protocol.ts).
 *
 * OPENING NEEDS THE TAP ITSELF. `window.open` is allowed only inside the click that
 * asked for it (Safari is strictest), and the ceremonies are reached from deep async
 * code. So a click that will certainly need one calls `primePasskeyWindow()` as its
 * FIRST statement, and any request that finds no primed window asks for one through
 * the "Continue with your passkey" sheet, whose button opens it.
 *
 * The flow itself (`runPasskeyWindow`) is a pure state machine over an injected handle,
 * so the tests drive every branch - ready, answer, close, silence, refusal - without a
 * browser.
 */

import {
  PASSKEY_DEV_APP_ORIGIN,
  PASSKEY_DEV_WINDOW_ORIGIN,
  PASSKEY_WINDOW_ORIGIN,
  WOCO_APP_ORIGIN,
  acceptPasskeyWindowReply,
  newPasskeyWindowNonce,
  type PasskeyWindowAction,
  type PasskeyWindowError,
  type PasskeyWindowRequest,
  type PasskeyWindowResult,
} from "@woco/shared";
import { buildEnv } from "../build-env.js";

const DEV = buildEnv(() => import.meta.env.DEV) === true;

/** A literal per build, never a setting: this origin decides who is handed account keys. */
export const PASSKEY_WINDOW = DEV ? PASSKEY_DEV_WINDOW_ORIGIN : PASSKEY_WINDOW_ORIGIN;
/** The one page the window answers. Anywhere else, passkeys send people here. */
export const PASSKEY_APP = DEV ? PASSKEY_DEV_APP_ORIGIN : WOCO_APP_ORIGIN;

/** eth.limo takes 3-6 s to serve the window; a slow phone network much longer. */
export const READY_MS = 30_000;
/** A primed window unused for this long was opened for nothing, and is closed. */
export const PRIME_MS = 20_000;
const POLL_MS = 400;

/** The window opened but never answered, or answered in a way this app does not know. */
export class PasskeyWindowNoAnswerError extends Error {
  readonly outOfStep: boolean;
  constructor(outOfStep = false) {
    super(
      outOfStep
        ? "The passkey window and this page are out of step. Reload WoCo and try again."
        : "The passkey window didn't connect. Close it and try again.",
    );
    this.name = "PasskeyWindowNoAnswerError";
    this.outOfStep = outOfStep;
  }
}

/** What the app needs of the opened window. */
export interface WindowHandle {
  readonly closed: boolean;
  close(): void;
  postMessage(data: unknown, targetOrigin: string): void;
}

export interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface WindowHost {
  /** `window.open` - synchronous, inside a click. Null when blocked. */
  open(): WindowHandle | null;
  listen(fn: (ev: MessageLike) => void): () => void;
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
}

/** A window opened in a click, listening from the moment it exists - its `ready` can
 *  arrive before any request does. */
export interface OpenedWindow {
  win: WindowHandle;
  ready: boolean;
  /** Called on every message from the window while no request owns it. */
  onMessage: ((ev: MessageLike) => void) | null;
  stop(): void;
}

export function openPasskeyWindow(host: WindowHost): OpenedWindow | null {
  const win = host.open();
  if (!win) return null;
  const opened: OpenedWindow = { win, ready: false, onMessage: null, stop: () => {} };
  // Every message goes through the protocol's own check, which hears only this window
  // at its exact origin; anything else is null there and ignored here.
  const unlisten = host.listen((ev) => {
    if (!opened.ready && acceptPasskeyWindowReply(ev, { win, windowOrigin: PASSKEY_WINDOW, nonce: "", action: "signin" })?.kind === "ready") {
      opened.ready = true;
    }
    opened.onMessage?.(ev);
  });
  opened.stop = unlisten;
  return opened;
}

/** A DOMException the in-page ceremony code would have seen: the window was closed or
 *  the ceremony declined. Callers already read NotAllowedError as "no passkey used". */
export function windowRefusal(error: PasskeyWindowError): DOMException {
  return new DOMException(error.quick ? "The passkey prompt didn't open." : "The passkey prompt was closed.", "NotAllowedError");
}

/**
 * Send one request to an opened window and wait for its one answer. Rejects with the
 * window's error (`PasskeyWindowErrorReply`), a NotAllowedError when the window closes
 * unanswered, or `PasskeyWindowNoAnswerError` when it never says ready or speaks a
 * version this app does not know.
 */
export function runPasskeyWindow(
  host: WindowHost,
  opened: OpenedWindow,
  request: PasskeyWindowRequest,
): Promise<PasskeyWindowResult> {
  return new Promise<PasskeyWindowResult>((resolve, reject) => {
    const { win } = opened;
    let sent = false;
    let settled = false;
    const cleanups: Array<() => void> = [];
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      opened.onMessage = null;
      opened.stop();
      fn();
    };
    const send = () => {
      if (sent || settled) return;
      sent = true;
      win.postMessage(request, PASSKEY_WINDOW);
    };
    opened.onMessage = (ev) => {
      const heard = acceptPasskeyWindowReply(ev, { win, windowOrigin: PASSKEY_WINDOW, nonce: request.nonce, action: request.action });
      if (!heard) return;
      if (heard.kind === "ready") return send();
      if (heard.kind === "unknown") return settle(() => reject(new PasskeyWindowNoAnswerError(true)));
      if (heard.kind === "error") return settle(() => reject(new PasskeyWindowErrorReply(heard.error)));
      settle(() => {
        try {
          if (!win.closed) win.close();
        } catch {
          // The window closes itself; this is only a tidy-up.
        }
        resolve(heard.result);
      });
    };
    cleanups.push(
      host.every(POLL_MS, () => {
        if (win.closed) settle(() => reject(windowRefusal({ name: "NotAllowedError", quick: false })));
      }),
      host.after(READY_MS, () => {
        if (opened.ready) return;
        settle(() => {
          try {
            win.close();
          } catch {
            // Nothing to tidy.
          }
          reject(new PasskeyWindowNoAnswerError());
        });
      }),
    );
    if (opened.ready) send();
  });
}

/** The window's own refusal, carried to the code that turns it into copy. */
export class PasskeyWindowErrorReply extends Error {
  constructor(readonly reply: PasskeyWindowError) {
    super(`passkey window: ${reply.name}`);
    this.name = "PasskeyWindowErrorReply";
  }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const NAME = "woco-passkey";

/** A small window on a desktop; phones open a tab whatever the features say. */
function features(): string {
  const w = 440;
  const h = 620;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 3));
  return `popup,width=${w},height=${h},left=${left},top=${top}`;
}

export const browserHost: WindowHost = {
  open: () => window.open(`${PASSKEY_WINDOW}/`, NAME, features()),
  listen: (fn) => {
    const h = (ev: MessageEvent) => fn({ origin: ev.origin, source: ev.source, data: ev.data });
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  },
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** Passkeys run from the app's own page only: the window answers no other. */
export function passkeyHostRefusal(origin: string): Error | null {
  return origin === PASSKEY_APP
    ? null
    : new Error(`Passkeys work on ${new URL(PASSKEY_APP).host} only - open WoCo there to continue.`);
}

let primed: { opened: OpenedWindow; expire: () => void } | null = null;

/**
 * Open the window NOW, inside the click, for the ceremony this click is about to ask
 * for. Call it as the click handler's first statement, and only where a ceremony is
 * certain - a window opened for nothing closes itself after `PRIME_MS`. Never throws.
 */
export function primePasskeyWindow(host: WindowHost = browserHost, origin: string = location.origin): void {
  if (passkeyHostRefusal(origin)) return;
  if (primed && !primed.opened.win.closed) return;
  const opened = openPasskeyWindow(host);
  if (!opened) return; // blocked: the sheet asks again, with a tap of its own
  const expire = host.after(PRIME_MS, () => {
    if (primed?.opened !== opened) return;
    primed = null;
    opened.stop();
    if (!opened.win.closed) opened.win.close();
  });
  primed = { opened, expire };
}

function takePrimed(): OpenedWindow | null {
  const p = primed;
  primed = null;
  if (!p) return null;
  p.expire();
  if (p.opened.win.closed) {
    p.opened.stop();
    return null;
  }
  return p.opened;
}

/**
 * Run one passkey ceremony in the window and return what it derived. Uses the window
 * this click primed, or asks for a tap through the sheet. Rejects as `runPasskeyWindow`
 * does, plus NotAllowedError when the sheet is dismissed.
 */
/** The "Continue with your passkey" sheet (passkey-window-sheet.svelte.ts). */
export interface PasskeySheet {
  request(action: PasskeyWindowAction, open: () => OpenedWindow | null): Promise<OpenedWindow | null>;
}

export async function passkeyWindow(
  action: PasskeyWindowAction,
  params: Pick<PasskeyWindowRequest, "credentialId" | "fallback" | "exclude" | "createdOn"> = {},
  deps: { host?: WindowHost; sheet?: PasskeySheet; origin?: string } = {},
): Promise<PasskeyWindowResult> {
  const host = deps.host ?? browserHost;
  const refusal = passkeyHostRefusal(deps.origin ?? location.origin);
  if (refusal) throw refusal;
  const sheet = deps.sheet ?? (await import("./passkey-window-sheet.svelte.js")).passkeyWindowSheet;
  const opened = takePrimed() ?? (await sheet.request(action, () => openPasskeyWindow(host)));
  if (!opened) throw windowRefusal({ name: "NotAllowedError", quick: false });
  const request = { v: 1, type: "request", nonce: newPasskeyWindowNonce(), action, ...params } as PasskeyWindowRequest;
  return runPasskeyWindow(host, opened, request);
}
