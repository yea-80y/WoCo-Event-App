/**
 * A scripted passkey window for tests of the app side (passkey-account.ts): each
 * ceremony is answered from a queue - a result built from a fixed PRF output exactly as
 * the window derives it, or one of the window's refusals - so what the app does with an
 * answer (pins, errors, provider labels) runs for real while no WebAuthn exists.
 * The window's own ceremonies are tested in auth-window-ceremonies.test.ts.
 */
import {
  passkeyAccountKeys,
  passkeyGuardianKeys,
  type PasskeyWindowAccountResult,
  type PasskeyWindowAction,
  type PasskeyWindowError,
  type PasskeyWindowGuardianResult,
  type PasskeyWindowRequest,
  type PasskeyWindowResult,
} from "@woco/shared";
import { PasskeyWindowErrorReply } from "../src/lib/auth/passkey-window.ts";

/** Minimal in-memory IndexedDB (single object store) for storage/indexeddb.ts. */
export function installFakeIndexedDB(): void {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.has(k) ? data.get(k) : undefined); return req; },
    put: (v: unknown, k: string) => { const req: Record<string, unknown> = {}; data.set(k, v); fire(req); return req; },
    delete: (k: string) => { const req: Record<string, unknown> = {}; data.delete(k); fire(req); return req; },
    clear: () => { const req: Record<string, unknown> = {}; data.clear(); fire(req); return req; },
  });
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.add(n); return {}; },
    transaction: () => ({ objectStore }),
    onclose: null,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = db;
        (req.onupgradeneeded as ((e: unknown) => void) | undefined)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
      });
      return req;
    },
  };
}

export const PRF = (fill = 0xcd) => new Uint8Array(32).fill(fill);

/** An AAGUID Samsung Pass reports (passkey-providers.ts). */
export const SAMSUNG_AAGUID = "53414d53-554e-4700-0000-000000000000";

export function accountResult(over: Partial<PasskeyWindowAccountResult> & { prf?: Uint8Array } = {}): PasskeyWindowAccountResult {
  const { prf = PRF(), ...rest } = over;
  return { credentialId: "AQIDBAUGBwgJCgsMDQ4PEA", attachment: "platform", handleKind: null, aaguid: null, keys: passkeyAccountKeys(prf), ...rest };
}

export function guardianResult(prf: Uint8Array = PRF(0x11)): PasskeyWindowGuardianResult {
  return { keys: passkeyGuardianKeys(prf) };
}

type Answer = PasskeyWindowResult | PasskeyWindowError | Error;

export interface ScriptedWindow {
  run: (action: PasskeyWindowAction, params?: Partial<PasskeyWindowRequest>) => Promise<PasskeyWindowResult>;
  answer(...a: Answer[]): void;
  requests: Array<{ action: PasskeyWindowAction; params: Partial<PasskeyWindowRequest> }>;
}

const isWindowError = (a: Answer): a is PasskeyWindowError => !(a instanceof Error) && typeof (a as { name?: unknown }).name === "string";

export function scriptedWindow(): ScriptedWindow {
  const queue: Answer[] = [];
  const requests: ScriptedWindow["requests"] = [];
  return {
    requests,
    answer: (...a) => queue.push(...a),
    run: async (action, params = {}) => {
      requests.push({ action, params });
      const a = queue.shift();
      if (!a) throw new Error(`no scripted answer for ${action}`);
      if (a instanceof Error) throw a;
      if (isWindowError(a)) throw new PasskeyWindowErrorReply(a);
      return a;
    },
  };
}
