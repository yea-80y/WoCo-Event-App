/**
 * The prompt count is NOT a property of the call site. It depends on the login
 * kind (passkey and web3auth sign the session silently; web3 and coinbase raise
 * a wallet popup for both signatures) and on what is already on the device. The
 * old call sites hard-coded "(1 of 2)" / "(2 of 2)" and were simply wrong for
 * every Kernel-backed login.
 *
 * `planAccountSetup` is where that decision now lives, and it is a pure function
 * precisely so it can be pinned here — the store and the sheet it feeds are runes
 * modules that this suite cannot load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planAccountSetup,
  hasExplainedAccountSetup,
  markAccountSetupExplained,
  type AccountSetupState,
} from "../src/lib/auth/account-setup-plan.js";

const base: AccountSetupState = {
  kind: "web3",
  hasSession: false,
  hasSeed: false,
  identity: true,
  explainedBefore: false,
};

const plan = (over: Partial<AccountSetupState>) => planAccountSetup({ ...base, ...over });

test("our own dialog is the consent for passkey and web3auth — never a sheet", () => {
  // Their session signature is silent and the seed signature comes through
  // SigningConfirmDialog, which explains itself. A pre-flight sheet would be a
  // screen explaining a screen.
  for (const kind of ["passkey", "web3auth"] as const) {
    for (const hasSession of [true, false]) {
      for (const hasSeed of [true, false]) {
        for (const explainedBefore of [true, false]) {
          const p = plan({ kind, hasSession, hasSeed, explainedBefore });
          assert.equal(p.showSheet, false, `${kind} must never show the sheet`);
        }
      }
    }
  }
  // …and the steps are still planned for them: no sheet is not no setup.
  assert.deepEqual(plan({ kind: "passkey" }).steps, ["session", "identity"]);
});

test("a fresh external wallet gets both steps, in order, behind the sheet", () => {
  const p = plan({ kind: "web3" });
  assert.deepEqual(p.steps, ["session", "identity"]);
  assert.equal(p.showSheet, true);
});

test("a session already on the device drops the session step", () => {
  const p = plan({ kind: "web3", hasSession: true });
  assert.deepEqual(p.steps, ["identity"]);
  assert.equal(p.showSheet, true, "one signature still deserves the warning");
});

test("nothing outstanding means no steps and no sheet", () => {
  const p = plan({ kind: "web3", hasSession: true, hasSeed: true });
  assert.deepEqual(p.steps, []);
  assert.equal(p.showSheet, false, "an empty plan must never raise a sheet");
});

test("explainedBefore suppresses the sheet but NOT the steps", () => {
  // Second time on the same device the wallet's own prompts are readable (they
  // say "WoCo Account Keys" since #529) — but the signatures still have to
  // happen, and dropping them here would silently skip setup.
  const p = plan({ kind: "web3", explainedBefore: true });
  assert.equal(p.showSheet, false);
  assert.deepEqual(p.steps, ["session", "identity"]);
});

test("identity: false never adds the identity step", () => {
  // A read-only action needs a session and nothing else. Asking for the seed
  // would be a signature request with no reason behind it.
  assert.deepEqual(plan({ kind: "web3", identity: false }).steps, ["session"]);
  assert.deepEqual(
    plan({ kind: "web3", identity: false, hasSession: true }).steps,
    [],
    "no session needed and no identity asked for = nothing to do",
  );
  assert.deepEqual(plan({ kind: "passkey", identity: false, hasSeed: false }).steps, ["session"]);
});

test("coinbase behaves exactly like web3", () => {
  // Its login is flag-off today (coinbaseLoginAllowed). It is still an external
  // wallet, and the flag flipping on must not silently take the explanation away.
  for (const over of [
    {},
    { hasSession: true },
    { hasSession: true, hasSeed: true },
    { explainedBefore: true },
    { identity: false },
  ] as Partial<AccountSetupState>[]) {
    assert.deepEqual(
      plan({ ...over, kind: "coinbase" }),
      plan({ ...over, kind: "web3" }),
      `coinbase diverged from web3 for ${JSON.stringify(over)}`,
    );
  }
});

test("an unknown or logged-out kind gets no sheet", () => {
  // `none` and `zupass` are in AuthKind. Neither is an external wallet, and
  // defaulting them into the sheet would raise it over a logged-out screen.
  assert.equal(plan({ kind: "none" }).showSheet, false);
  assert.equal(plan({ kind: "zupass" }).showSheet, false);
});

// ---------------------------------------------------------------------------
// The per-device memory
// ---------------------------------------------------------------------------

function withStorage(store: Map<string, string> | null, fn: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const had = "localStorage" in g;
  const prev = g.localStorage;
  g.localStorage = store
    ? {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }
    : {
        // A private window / blocked site data: every accessor throws.
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); },
      };
  try { fn(); } finally {
    if (had) g.localStorage = prev;
    else delete g.localStorage;
  }
}

test("the explanation is remembered per account and read case-insensitively", () => {
  const store = new Map<string, string>();
  withStorage(store, () => {
    const a = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
    const b = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
    assert.equal(hasExplainedAccountSetup(a), false);
    markAccountSetupExplained(a);
    assert.equal(hasExplainedAccountSetup(a), true);
    // Addresses arrive in mixed case from different wallets; the same account
    // must not be re-explained because one caller checksummed it.
    assert.equal(hasExplainedAccountSetup(a.toLowerCase()), true);
    // A second account on the same browser is a different mental model.
    assert.equal(hasExplainedAccountSetup(b), false);
  });
});

test("unreadable storage fails toward showing the explanation, never toward hiding it", () => {
  withStorage(null, () => {
    assert.equal(hasExplainedAccountSetup("0xabc"), false);
    // And writing must not throw out of the setup flow.
    assert.doesNotThrow(() => markAccountSetupExplained("0xabc"));
  });
});
