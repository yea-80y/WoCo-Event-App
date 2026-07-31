/**
 * Connect embedded components — the loader's failure behaviour.
 *
 * These components are the organiser's ONLY route to their bank details under
 * `stripe_dashboard.type = "none"`, so the interesting cases are all failures:
 * a blocked script has to say "a blocker may be doing this" rather than
 * "something went wrong", and a failed load must not poison the retry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectAppearance,
  connectFailure,
  loadConnectScript,
  __resetConnectScriptForTests,
} from "../src/lib/creator/payouts/connect-embed.js";

// ---------------------------------------------------------------------------
// Failure messages
// ---------------------------------------------------------------------------

test("a blocked script names the likely cause and the fix", () => {
  const failure = connectFailure("blocked", "connect.js failed to load");
  assert.equal(failure.kind, "blocked");
  // An organiser staring at an empty box needs to know it is probably their
  // extension — "something went wrong" sends them to support instead.
  assert.match(failure.message, /ad blocker|privacy extension/i);
  assert.match(failure.message, /stripe\.com/);
  assert.equal(failure.detail, "connect.js failed to load");
});

test("failure detail is kept out of the organiser-facing message", () => {
  const failure = connectFailure("unknown", "TypeError: undefined is not a function");
  assert.doesNotMatch(failure.message, /TypeError/);
  assert.equal(failure.detail, "TypeError: undefined is not a function");
});

test("every failure kind produces a non-empty message", () => {
  for (const kind of ["blocked", "session", "unknown"] as const) {
    assert.ok(connectFailure(kind, "x").message.length > 0, `${kind} has no message`);
  }
});

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

test("maps WoCo tokens onto Stripe appearance variables", () => {
  const tokens: Record<string, string> = {
    "--accent": "#C7F23A",
    "--bg-surface": "#14140F",
    "--text": "#F2EBE0",
    "--text-secondary": "#B5AC9D",
    "--border": "#2B2A23",
    "--error": "#FF5B2C",
    "--accent-ink": "#0B0B09",
  };
  const appearance = buildConnectAppearance((name) => tokens[name] ?? null);

  assert.equal(appearance.colorPrimary, "#C7F23A");
  assert.equal(appearance.colorBackground, "#14140F");
  assert.equal(appearance.colorDanger, "#FF5B2C");
  assert.equal(appearance.buttonPrimaryColorText, "#0B0B09");
});

test("a missing token is omitted, never sent as an empty string", () => {
  // Stripe rejects empty colour values; its own default is a better outcome
  // than a rejected appearance block taking the whole panel down.
  const appearance = buildConnectAppearance((name) => (name === "--accent" ? "#C7F23A" : null));

  assert.equal(appearance.colorPrimary, "#C7F23A");
  assert.equal("colorBackground" in appearance, false);
  for (const value of Object.values(appearance)) {
    assert.notEqual(value, "");
  }
});

test("appearance survives a stylesheet that resolves nothing", () => {
  assert.deepEqual(buildConnectAppearance(() => null), {});
});

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

/**
 * Minimal DOM stand-in. The suite runs on bare node (no jsdom dependency —
 * see the light-and-modular convention), and the loader only touches
 * querySelector / createElement / head.appendChild.
 */
function withFakeDom(behaviour: "error" | "load-without-global" | "load-with-global"): {
  restore: () => void;
} {
  const listeners = new Map<string, () => void>();
  const script: Record<string, unknown> = {
    addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
  };

  const fakeWindow: Record<string, unknown> = {};
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => script,
    head: {
      appendChild: () => {
        // Fire asynchronously, as a real script load would.
        queueMicrotask(() => {
          if (behaviour === "error") listeners.get("error")?.();
          else {
            if (behaviour === "load-with-global") fakeWindow.StripeConnect = { init: () => ({}) };
            listeners.get("load")?.();
          }
        });
      },
    },
  };

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  g.window = fakeWindow;
  g.document = fakeDocument;
  __resetConnectScriptForTests();

  return {
    restore: () => {
      g.window = prevWindow;
      g.document = prevDocument;
      __resetConnectScriptForTests();
    },
  };
}

test("a script error rejects as 'blocked'", async () => {
  const dom = withFakeDom("error");
  try {
    await assert.rejects(loadConnectScript(), (err: { kind: string }) => err.kind === "blocked");
  } finally {
    dom.restore();
  }
});

test("a script that loads without defining the global is treated as blocked", async () => {
  // Some blockers answer with an empty 200 rather than failing the request,
  // which fires `load` and leaves StripeConnect undefined.
  const dom = withFakeDom("load-without-global");
  try {
    await assert.rejects(loadConnectScript(), (err: { kind: string; detail: string }) => {
      assert.equal(err.kind, "blocked");
      assert.match(err.detail, /StripeConnect\.init is missing/);
      return true;
    });
  } finally {
    dom.restore();
  }
});

test("a failed load does not poison the retry", async () => {
  // The memoised promise exists to avoid re-fetching ~880KB. If a rejection
  // were memoised too, "Try again" could never succeed for the life of the tab.
  const failing = withFakeDom("error");
  try {
    await assert.rejects(loadConnectScript());
  } finally {
    failing.restore();
  }

  const succeeding = withFakeDom("load-with-global");
  try {
    await loadConnectScript();
  } finally {
    succeeding.restore();
  }
});

test("a successful load resolves and is reused without re-injecting", async () => {
  const dom = withFakeDom("load-with-global");
  try {
    await loadConnectScript();
    // Second call short-circuits on the global rather than appending again.
    await loadConnectScript();
  } finally {
    dom.restore();
  }
});
