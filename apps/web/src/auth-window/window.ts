/**
 * The passkey sign-in window: the page on the passkey host (`PASSKEY_WINDOW_ORIGIN`) that
 * runs every WoCo passkey ceremony. Built into ONE self-contained file under a hash CSP
 * with `connect-src 'none'` (vite.auth.config.ts), pinned on L1 by the owner's Safe.
 *
 * What it guarantees: account keys leave this window only (i) to the window that opened
 * it, captured once at load, (ii) whose origin is exactly an allowed opener, (iii) by
 * postMessage to that literal origin, (iv) once, (v) after a tap here, and the PRF
 * output never at all. No storage, no network, no URL data: nothing else to leak into.
 *
 * Its three settings are injected by the build and are the ONLY inputs it trusts:
 * production is the default output, the dev window is an explicit mode.
 */

import {
  PASSKEY_WINDOW_REQUEST_MS,
  PASSKEY_WINDOW_VERSION,
  acceptPasskeyWindowRequest,
  type PasskeyWindowError,
  type PasskeyWindowReply,
  type PasskeyWindowRequest,
} from "@woco/shared/auth/passkey-window-protocol";
import { WindowCeremonyError, runCeremony } from "./ceremonies";

declare const __AUTH_SELF_ORIGIN__: string;
declare const __AUTH_RP_ID__: string;
declare const __AUTH_OPENERS__: readonly string[];

const COPY: Record<PasskeyWindowRequest["action"], { title: string; line: string }> = {
  signin: { title: "Sign in to WoCo", line: "wants you to sign in with your passkey." },
  restore: { title: "Sign in to WoCo", line: "wants you to confirm it's you with your passkey." },
  create: { title: "Create your WoCo passkey", line: "wants to create a passkey for your account." },
  add: { title: "Add a passkey", line: "wants to add a passkey for your account on this device." },
  "backup-create": { title: "Create a backup passkey", line: "wants to create a backup passkey for your account." },
  "backup-get": { title: "Use your backup passkey", line: "wants your backup passkey to recover your account." },
};

const el = (id: string) => document.getElementById(id) as HTMLElement;
const title = el("title");
const asker = el("asker");
const line = el("line");
const go = el("go") as HTMLButtonElement;
const cancel = el("cancel") as HTMLButtonElement;
const note = el("note");
const home = el("home");

const loadedAt = Date.now();
// Captured ONCE: a later `window.opener` could be a page the opener navigated to.
const opener: Window | null = window.opener;

function say(text: string, opts: { title?: string; buttons?: boolean } = {}): void {
  if (opts.title) title.textContent = opts.title;
  asker.textContent = "";
  line.textContent = text;
  go.hidden = !opts.buttons;
  cancel.hidden = !opts.buttons;
}

/** Close, or - where a script cannot close this tab - say how to get back. */
function finish(text: string): void {
  window.close();
  setTimeout(() => {
    say(text, { title: "Return to WoCo" });
    note.hidden = true;
  }, 300);
}

let accepted: PasskeyWindowRequest | null = null;
let target: string | null = null;
let running = false;

function reply(nonce: string, body: { ok: true; result: unknown } | { ok: false; error: PasskeyWindowError }): void {
  if (!opener || !target) return;
  const message = { v: PASSKEY_WINDOW_VERSION, type: "result", nonce, ...body } as PasskeyWindowReply;
  opener.postMessage(message, target);
}

/** Zero every key buffer once it has been handed over (postMessage copies). */
function zero(result: unknown): void {
  const keys = (result as { keys?: Record<string, Uint8Array> } | null)?.keys;
  if (keys) for (const k of Object.values(keys)) k.fill(0);
}

function onMessage(ev: MessageEvent): void {
  const r = acceptPasskeyWindowRequest(
    { origin: ev.origin, source: ev.source, data: ev.data },
    { opener, allowedOrigins: __AUTH_OPENERS__, accepted: accepted !== null, loadedAt, now: Date.now() },
  );
  if (!r) return;
  // The literal from the list, never the event's own string, is where answers go.
  target = __AUTH_OPENERS__.find((o) => o === ev.origin) ?? null;
  if ("refused" in r) {
    accepted = { v: PASSKEY_WINDOW_VERSION, type: "request", nonce: r.nonce ?? "", action: "signin" };
    if (r.nonce) reply(r.nonce, { ok: false, error: { name: "UnsupportedRequest", detail: r.refused } });
    say("This sign-in page and WoCo are out of step. Reload WoCo and try again.", { title: "Can't continue" });
    return;
  }
  accepted = r;
  const copy = COPY[r.action];
  title.textContent = copy.title;
  asker.textContent = new URL(target!).host;
  line.textContent = ` ${copy.line}`;
  // Only a sign-in can be a newcomer's wrong turn (iOS answers it with its own "no
  // passkeys" sheet); every other action names an account already there.
  if (r.action === "signin") note.textContent = "New to WoCo? Cancel, then create an account.";
  go.hidden = false;
  go.focus();
}

/** The follow-up tap after a creation that gave no PRF value. */
function tapAgain(): Promise<void> {
  return new Promise((resolve, reject) => {
    say("Your passkey is saved. Tap Continue once more to finish setting it up.", { title: "One more step", buttons: true });
    go.disabled = false;
    cancel.disabled = false;
    const done = (ok: boolean) => () => {
      go.onclick = cancel.onclick = null;
      go.disabled = cancel.disabled = true;
      say("Follow your device's prompt.");
      if (ok) resolve();
      else reject(new Error("cancelled"));
    };
    go.onclick = done(true);
    cancel.onclick = done(false);
  });
}

async function onContinue(): Promise<void> {
  const req = accepted;
  if (!req || running || !target) return;
  running = true;
  go.disabled = cancel.disabled = true;
  say("Follow your device's prompt.");
  try {
    const result = await runCeremony(req, { credentials: navigator.credentials, rpId: __AUTH_RP_ID__, tapAgain, now: () => performance.now() });
    try {
      reply(req.nonce, { ok: true, result });
    } finally {
      zero(result);
    }
    finish("You're signed in. Go back to the WoCo tab to carry on.");
  } catch (e) {
    const error: PasskeyWindowError =
      e instanceof WindowCeremonyError ? e.reply : { name: "Unexpected", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    reply(req.nonce, { ok: false, error });
    finish("Go back to the WoCo tab to try again.");
  }
}

function onCancel(): void {
  if (running) return;
  if (accepted && accepted.nonce) reply(accepted.nonce, { ok: false, error: { name: "NotAllowedError", quick: false } });
  finish("Cancelled. Go back to the WoCo tab.");
}

if (location.origin !== __AUTH_SELF_ORIGIN__ || window.top !== window || !opener) {
  say("This page only works when WoCo opens it. Go to WoCo and tap Sign in.", { title: "Open WoCo to sign in" });
  note.hidden = true;
  // A bookmark or a restored tab: no WoCo tab opened this one, so there is none to go back to.
  home.hidden = false;
} else {
  window.addEventListener("message", onMessage);
  go.addEventListener("click", () => void onContinue());
  cancel.addEventListener("click", onCancel);
  cancel.hidden = false;
  // The browser drops this unless the opener IS at that origin, so it names no one else.
  for (const origin of __AUTH_OPENERS__) opener.postMessage({ v: PASSKEY_WINDOW_VERSION, type: "ready" }, origin);
  setTimeout(() => {
    if (!accepted) say("This window waited too long. Close it and try again from WoCo.", { title: "Sign in to WoCo" });
  }, PASSKEY_WINDOW_REQUEST_MS);
}
