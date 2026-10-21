/**
 * The app's side of the passkey window (src/lib/auth/passkey-window.ts), driven
 * through a fake window host: open, ready, one request, one answer - and every way it
 * can go wrong (blocked, closed, silent, out of step, someone else talking).
 *
 * MUTATIONS (each turns this file red):
 *  - send before `ready` -> "the request waits for ready";
 *  - post to "*" or the event's origin -> "the request goes to the window's literal origin";
 *  - drop `source === win` or the origin check -> "only its own window is heard";
 *  - drop the closed poll -> "a window closed unanswered is a cancel";
 *  - drop the ready deadline -> "a window that never says ready is named";
 *  - keep listening after settling -> "settling stops listening and every timer";
 *  - open a primed window again, or never expire it -> the prime tests;
 *  - run from another origin -> "passkeys run from the app's own page only".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSKEY_APP,
  PASSKEY_WINDOW,
  PRIME_MS,
  READY_MS,
  PasskeyWindowErrorReply,
  PasskeyWindowNoAnswerError,
  openPasskeyWindow,
  passkeyWindow,
  primePasskeyWindow,
  runPasskeyWindow,
  type MessageLike,
  type OpenedWindow,
  type WindowHost,
} from "../src/lib/auth/passkey-window.ts";
import { accountResult } from "./fake-passkey-window.ts";

function fakeHost(opts: { blocked?: boolean } = {}) {
  const posted: Array<{ data: any; target: string }> = [];
  const listeners = new Set<(ev: MessageLike) => void>();
  const timers: Array<{ ms: number; fn: () => void; every: boolean; live: boolean }> = [];
  let opens = 0;
  const win = {
    closed: false,
    close() {
      this.closed = true;
    },
    postMessage: (data: unknown, target: string) => posted.push({ data, target }),
  };
  const host: WindowHost = {
    open: () => {
      opens++;
      return opts.blocked ? null : win;
    },
    listen: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    every: (ms, fn) => {
      const t = { ms, fn, every: true, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    after: (ms, fn) => {
      const t = { ms, fn, every: false, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
  };
  const say = (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
    [...listeners].forEach((f) => f({ origin: from.origin ?? PASSKEY_WINDOW, source: from.source ?? win, data }));
  const fire = (kind: "every" | "after", ms?: number) =>
    timers.filter((t) => t.live && (kind === "every" ? t.every : !t.every) && (ms === undefined || t.ms === ms)).forEach((t) => t.fn());
  return { host, win, posted, listeners, timers, say, fire, opens: () => opens };
}

const NONCE = "N".repeat(22);
const request = { v: 1 as const, type: "request" as const, nonce: NONCE, action: "signin" as const };
const READY = { v: 1, type: "ready" };
const result = (nonce = NONCE) => ({ v: 1, type: "result", nonce, ok: true, result: accountResult() });
const settled = async <T>(p: Promise<T>) => {
  let state: "pending" | "ok" | "err" = "pending";
  p.then(() => (state = "ok"), () => (state = "err"));
  await new Promise((r) => setImmediate(r));
  return state;
};

test("a blocked window is null; an opened one listens from the start, so an early ready counts", () => {
  assert.equal(openPasskeyWindow(fakeHost({ blocked: true }).host), null);
  const f = fakeHost();
  const opened = openPasskeyWindow(f.host)!;
  assert.equal(f.listeners.size, 1);
  f.say(READY, { origin: "https://evil.example" });
  f.say(READY, { source: {} });
  assert.equal(opened.ready, false, "only its own window, at its own origin, is ready");
  f.say(READY);
  assert.equal(opened.ready, true);
});

test("the request waits for ready, then goes to the window's literal origin, once", async () => {
  const f = fakeHost();
  const opened = openPasskeyWindow(f.host)!;
  const p = runPasskeyWindow(f.host, opened, request);
  assert.equal(f.posted.length, 0, "nothing before ready");
  f.say(READY);
  f.say(READY);
  assert.deepEqual(f.posted, [{ data: request, target: PASSKEY_WINDOW }]);
  f.say(result());
  assert.equal((await p as { credentialId: string }).credentialId, accountResult().credentialId);
  assert.equal(f.win.closed, true, "tidied up after the answer");
});

test("a window that said ready before the request gets it at once", () => {
  const f = fakeHost();
  const opened = openPasskeyWindow(f.host)!;
  f.say(READY);
  void runPasskeyWindow(f.host, opened, request);
  assert.equal(f.posted.length, 1);
});

test("only its own window is heard, and only for its nonce", async () => {
  const f = fakeHost();
  const opened = openPasskeyWindow(f.host)!;
  const p = runPasskeyWindow(f.host, opened, request);
  f.say(READY);
  f.say(result(), { origin: "https://evil.example" });
  f.say(result(), { source: {} });
  f.say(result("M".repeat(22)));
  assert.equal(await settled(p), "pending");
  f.say(result());
  assert.equal(await settled(p), "ok");
});

test("the window's refusal arrives as itself; a message this app does not know is out of step", async () => {
  const f = fakeHost();
  const p = runPasskeyWindow(f.host, openPasskeyWindow(f.host)!, request);
  f.say(READY);
  f.say({ v: 1, type: "result", nonce: NONCE, ok: false, error: { name: "IsBackup" } });
  await assert.rejects(p, (e: unknown) => e instanceof PasskeyWindowErrorReply && e.reply.name === "IsBackup");

  const g = fakeHost();
  const q = runPasskeyWindow(g.host, openPasskeyWindow(g.host)!, request);
  g.say({ v: 2, type: "ready" });
  await assert.rejects(q, (e: unknown) => e instanceof PasskeyWindowNoAnswerError && e.outOfStep);
});

test("a window closed unanswered is a cancel, read like a cancelled sheet", async () => {
  const f = fakeHost();
  const p = runPasskeyWindow(f.host, openPasskeyWindow(f.host)!, request);
  f.say(READY);
  f.fire("every");
  assert.equal(await settled(p), "pending", "open: nothing yet");
  f.win.closed = true;
  f.fire("every");
  await assert.rejects(p, (e: unknown) => e instanceof DOMException && e.name === "NotAllowedError");
});

test("a window that never says ready is named, and closed", async () => {
  const f = fakeHost();
  const p = runPasskeyWindow(f.host, openPasskeyWindow(f.host)!, request);
  f.fire("after", READY_MS);
  await assert.rejects(p, (e: unknown) => e instanceof PasskeyWindowNoAnswerError && !e.outOfStep);
  assert.equal(f.win.closed, true);
  const g = fakeHost();
  const ready = openPasskeyWindow(g.host)!;
  g.say(READY);
  const q = runPasskeyWindow(g.host, ready, request);
  g.fire("after", READY_MS);
  assert.equal(await settled(q), "pending", "the deadline is for ready, not for the person");
});

test("settling stops listening and every timer", async () => {
  const f = fakeHost();
  const p = runPasskeyWindow(f.host, openPasskeyWindow(f.host)!, request);
  f.say(READY);
  f.say(result());
  await p;
  assert.equal(f.listeners.size, 0);
  assert.ok(f.timers.every((t) => !t.live));
});

test("passkeys run from the app's own page only", async () => {
  const f = fakeHost();
  await assert.rejects(passkeyWindow("signin", {}, { host: f.host, origin: "https://gateway.woco-net.com", sheet: { request: async () => null } }), /Passkeys work on woco\.eth\.limo only/);
  primePasskeyWindow(f.host, "https://nabil.woco.eth.limo");
  assert.equal(f.opens(), 0);
});

test("without a primed window the sheet is asked for a tap; dismissing it is a cancel", async () => {
  const f = fakeHost();
  let asked = 0;
  await assert.rejects(
    passkeyWindow("signin", {}, { host: f.host, origin: PASSKEY_APP, sheet: { request: async () => (asked++, null) } }),
    (e: unknown) => e instanceof DOMException && e.name === "NotAllowedError",
  );
  assert.equal(asked, 1);
  let opened: OpenedWindow | null = null;
  const p = passkeyWindow("create", {}, { host: f.host, origin: PASSKEY_APP, sheet: { request: async (_a, open) => (opened = open()) } });
  await new Promise((r) => setImmediate(r));
  assert.ok(opened);
  f.say(READY);
  assert.equal(f.posted[0]!.data.action, "create");
  f.say({ v: 1, type: "result", nonce: f.posted[0]!.data.nonce, ok: true, result: accountResult() });
  await p;
});

test("a primed window is used once, never opened twice, and closes itself unused", async () => {
  const f = fakeHost();
  primePasskeyWindow(f.host, PASSKEY_APP);
  primePasskeyWindow(f.host, PASSKEY_APP);
  assert.equal(f.opens(), 1, "a second tap reuses the open window");
  let asked = 0;
  const p = passkeyWindow("signin", {}, { host: f.host, origin: PASSKEY_APP, sheet: { request: async () => (asked++, null) } });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 0, "the primed window, not the sheet");
  f.say(READY);
  f.say({ v: 1, type: "result", nonce: f.posted[0]!.data.nonce, ok: true, result: accountResult() });
  await p;

  const g = fakeHost();
  primePasskeyWindow(g.host, PASSKEY_APP);
  g.fire("after", PRIME_MS);
  assert.equal(g.win.closed, true, "opened for nothing, closed again");
  assert.equal(g.listeners.size, 0);
  const asks: string[] = [];
  await assert.rejects(passkeyWindow("signin", {}, { host: g.host, origin: PASSKEY_APP, sheet: { request: async (a) => (asks.push(a), null) } }));
  assert.deepEqual(asks, ["signin"], "an expired prime is gone: the sheet asks");
});
