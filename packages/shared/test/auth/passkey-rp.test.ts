/**
 * RP-ID resolution (#175). The property that matters: which hostnames share
 * the production credential scope, and — just as load-bearing — which do NOT.
 * A host outside the canonical suffix resolving to itself is what makes an
 * embed-minted passkey a separate identity; these tests pin that boundary so
 * a future "helpful" broadening (e.g. matching woco-net.com) is a deliberate
 * decision, not a drive-by.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePasskeyRpId, PASSKEY_PRODUCTION_RP_ID } from "../../src/auth/passkey-rp.js";

test("the canonical origin and its subdomains share the production RP ID", () => {
  assert.equal(resolvePasskeyRpId("woco.eth.limo"), PASSKEY_PRODUCTION_RP_ID);
  assert.equal(resolvePasskeyRpId("app.woco.eth.limo"), PASSKEY_PRODUCTION_RP_ID);
  assert.equal(resolvePasskeyRpId("a.b.woco.eth.limo"), PASSKEY_PRODUCTION_RP_ID);
});

test("localhost dev resolves to itself", () => {
  assert.equal(resolvePasskeyRpId("localhost"), "localhost");
  assert.equal(resolvePasskeyRpId("127.0.0.1"), "127.0.0.1");
});

test("every non-canonical host resolves to itself — a separate credential scope", () => {
  assert.equal(resolvePasskeyRpId("gateway.woco-net.com"), "gateway.woco-net.com");
  assert.equal(resolvePasskeyRpId("organiser-site.com"), "organiser-site.com");
  assert.equal(resolvePasskeyRpId("woco-net.com"), "woco-net.com");
});

test("a lookalike suffix does not capture the production scope", () => {
  // ".woco.eth.limo" must match as a label boundary, not a substring.
  assert.equal(resolvePasskeyRpId("evilwoco.eth.limo"), "evilwoco.eth.limo");
  assert.equal(resolvePasskeyRpId("woco.eth.limo.attacker.com"), "woco.eth.limo.attacker.com");
});
