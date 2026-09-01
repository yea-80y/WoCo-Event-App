/**
 * Ratchets for the issuer-curve producers (PR 4): the fail-loud issuing-key
 * rule, and the proof-of-possession binding both create payloads must carry.
 *
 * Ratchets, not unit tests, for the same reason as `cert-mint-binding.test.ts`:
 * every value here is produced inside a Svelte component or a module that
 * imports the auth store (a runes module — not importable under node:test), and
 * nothing downstream can catch the mistakes. A create payload that silently
 * dropped `issuerBinding` would still publish today and be refused only when
 * the server starts pinning the binding (5a) — or worse, be pinned WITHOUT
 * proof if the server-side check regressed with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const ISSUING = strip(read("../src/lib/auth/issuing-key.ts"));
const PUBLISH = strip(read("../src/lib/creator/events/PublishButton.svelte"));
const MINT = strip(read("../src/lib/components/pod/PodCreateModal.svelte"));

// ---------------------------------------------------------------------------
// ensureIssuingKey — FAIL LOUD, never fall through to another signer
// ---------------------------------------------------------------------------

test("ensureIssuingKey throws the prescribed no-seed error", () => {
  // The one legitimate no-seed state is a recovered account whose escrow
  // restore has not run; the message must say so, verbatim (handover rule).
  assert.match(ISSUING, /throw new Error\("issuing key unavailable — restore from recovery escrow"\)/);
});

test("ensureIssuingKey can reach NO other signer", () => {
  // Every alternative signer "works" at signing time and produces credentials
  // that verify against nothing, discovered at a door. The module must not
  // even import one.
  assert.doesNotMatch(ISSUING, /getContentFeedSigner|feedPrivKey|sessionKey|randomBytes|getPodSigner/);
  assert.match(ISSUING, /deriveIssuingKey\(seed, gen\)/, "the seed-derived key is the only exit");
});

// ---------------------------------------------------------------------------
// The proof of possession — both create payloads, parent lowercased, gen 0
// ---------------------------------------------------------------------------

/**
 * The exact call shape matters, not just presence: the server (5a) rebuilds
 * the message from its LOWERCASED verified parentAddress and generation 0, so
 * a payload signed over anything else verifies against nothing — and the
 * builder REFUSES a non-canonical parent, which would turn every publish into
 * a throw. `auth.parent` arrives checksummed from wallet providers.
 */
const BINDING_CALL = /buildIssuerBindingMessage\(\(auth\.parent as string\)\.toLowerCase\(\), 0\)/;

test("the event-create payload carries the issuing key's parent binding", () => {
  assert.match(PUBLISH, /issuerBinding:\s*\{/, "PublishButton must send issuerBinding");
  assert.match(PUBLISH, BINDING_CALL);
  assert.match(PUBLISH, /issuer:\s*issuing\.address/, "the claimed issuer is the derived address");
});

test("the badge-mint payload carries the same binding", () => {
  assert.match(MINT, /issuerBinding:\s*\{/, "PodCreateModal must send issuerBinding");
  assert.match(MINT, BINDING_CALL);
  assert.match(MINT, /issuer:\s*issuing\.address/);
});

test("both payloads sign the binding with the ISSUING key, nothing else", () => {
  for (const [name, src] of [["PublishButton", PUBLISH], ["PodCreateModal", MINT]] as const) {
    const at = src.indexOf("issuerBinding:");
    assert.ok(at > 0);
    const block = src.slice(at, at + 400);
    assert.match(
      block,
      /signPersonalMessage\([\s\S]*?issuing\.privateKey/,
      `${name}: the PoP must be signed by the issuing key — any other key proves possession of nothing`,
    );
  }
});
