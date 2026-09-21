/**
 * Who may sign a name's pointer, and what a profile bind's answer is allowed
 * to ask for (registrar v2.2; Fable sponsor-key consult §2.2, §11.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pointerBlockedReason, profileBindOutcome } from "../src/lib/sub-ens/pointer-policy.js";

const NAME = "punkpub.woco.eth";
const SIGNERS = ["web3", "passkey", "web3auth"] as const;
const REF = "ab".repeat(32);

test("the kinds that sign as the holder may bind a site feed they own", () => {
  for (const kind of SIGNERS) {
    assert.equal(pointerBlockedReason(kind, "site", "client", NAME), null, kind);
  }
});

test("a login with a feed signer never binds a name to a platform-authored feed", () => {
  for (const kind of SIGNERS) {
    for (const owner of ["platform", undefined] as const) {
      assert.match(pointerBlockedReason(kind, "site", owner, NAME) ?? "", /own key/, `${kind}/${owner}`);
    }
  }
});

test("an event page (fixed content hash) and the profile (app) need no feed owner", () => {
  for (const kind of SIGNERS) {
    assert.equal(pointerBlockedReason(kind, "event-page", undefined, NAME), null);
    assert.equal(pointerBlockedReason(kind, "profile", undefined, NAME), null);
  }
});

test("Coinbase Smart Wallet is never asked to sign, for any purpose or feed", () => {
  for (const purpose of ["site", "event-page", "profile"] as const) {
    for (const owner of ["client", "platform", undefined] as const) {
      assert.match(pointerBlockedReason("coinbase", purpose, owner, NAME) ?? "", /stays yours/);
    }
  }
});

test("signed-out and unimplemented kinds are refused", () => {
  assert.match(pointerBlockedReason("none", "profile", undefined, NAME) ?? "", /Sign in/);
  assert.ok(pointerBlockedReason("zupass", "profile", undefined, NAME));
});

test("a bind's pointer is an ask to sign only with a bare 64-hex target", () => {
  assert.deepEqual(profileBindOutcome({ pointer: { status: "awaiting_signature", target: REF } }), {
    pointer: { status: "awaiting_signature", target: REF },
  });
  for (const target of [`0x${REF}`, REF.toUpperCase(), REF.slice(2), `${REF}00`, 42, undefined]) {
    assert.equal(
      profileBindOutcome({ pointer: { status: "awaiting_signature", target } }),
      null,
      `target ${String(target)} must not reach a signature prompt`,
    );
  }
  assert.equal(profileBindOutcome({ pointer: { status: "ok", target: REF } }), null);
});

test("the warning is read on its own, and together with a pointer", () => {
  assert.deepEqual(profileBindOutcome({ warning: "points_at_site" }), { warning: "points_at_site" });
  assert.equal(profileBindOutcome({ warning: "something_else" }), null);
  assert.equal(profileBindOutcome(undefined), null);
  assert.deepEqual(
    profileBindOutcome({ warning: "points_at_site", pointer: { status: "awaiting_signature", target: REF } }),
    { warning: "points_at_site", pointer: { status: "awaiting_signature", target: REF } },
  );
});

test("unknown fields in the answer are not carried through", () => {
  const out = profileBindOutcome({ pointer: { status: "awaiting_signature", target: REF, extra: "x" } } as never);
  assert.deepEqual(out, { pointer: { status: "awaiting_signature", target: REF } });
});
