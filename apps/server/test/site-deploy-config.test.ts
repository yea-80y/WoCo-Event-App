/**
 * The deploy path bakes a config object into an inline `<script>` and uploads the
 * result to Swarm, where it is immutable and publicly addressed. Two properties
 * have to hold before that happens (#180, #193):
 *
 *   1. NOTHING organiser-authored can escape the script's string context. The
 *      config carries page titles, nav labels, section copy and the event id, all
 *      free text.
 *   2. The three URLs the config carries are ALLOWLISTED, not merely sanitised.
 *      `apiUrl` becomes the base for every authenticated request the deployed
 *      page makes, so an arbitrary https host is not "clean" — it is the attack.
 *
 * The escape table's last two entries are literal U+2028/U+2029, invisible in an
 * editor. These assertions are what stops a reformat silently dropping them, so
 * they build those characters by code point rather than pasting them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedAppUrls,
  allowedGatewayUrls,
  isAllowedAppUrl,
  isAllowedGatewayUrl,
  isSafeIdParam,
  jsonForInlineScript,
  resolveDeployApiUrl,
  resolveDeployUrls,
} from "../src/lib/site/deploy-config.js";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Restore the env this suite mutates, so ordering never decides an outcome. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Inline-script escaping ───────────────────────────────────────────────────

test("a </script> in organiser text cannot close the tag", () => {
  const payload = { site: { title: "</script><script>alert(1)</script>" } };
  const out = jsonForInlineScript(payload);

  assert.ok(!out.includes("</script>"), "closing tag survived into the script body");
  assert.ok(!out.includes("<"), "raw < survived");
  assert.ok(!out.includes(">"), "raw > survived");
  assert.ok(out.includes("\\u003c"), "< was not escaped to its \\u form");
});

test("escaping is transparent — the parsed value is identical to the input", () => {
  // The whole approach rests on this: < is a valid JSON string escape that
  // parses back to "<". If it were not, escaping would corrupt site content.
  const payload = {
    title: "</script><script>alert(1)</script>",
    amp: "Rock & Roll",
    arrow: "a > b < c",
    sep: `line${LINE_SEPARATOR}break${PARAGRAPH_SEPARATOR}here`,
  };
  assert.deepEqual(JSON.parse(jsonForInlineScript(payload)), payload);
});

test("U+2028 and U+2029 are escaped — they terminate a line in JS source", () => {
  const out = jsonForInlineScript({ s: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` });
  assert.ok(!out.includes(LINE_SEPARATOR), "literal U+2028 survived into the script body");
  assert.ok(!out.includes(PARAGRAPH_SEPARATOR), "literal U+2029 survived into the script body");
  assert.ok(out.includes("\\u2028"), "U+2028 was not escaped");
  assert.ok(out.includes("\\u2029"), "U+2029 was not escaped");
});

test("HTML entities in the payload are escaped so & cannot start one", () => {
  const out = jsonForInlineScript({ s: "&lt;script&gt;" });
  assert.ok(!out.includes("&"), "raw & survived");
  assert.equal(JSON.parse(out).s, "&lt;script&gt;");
});

test("a value JSON.stringify cannot represent yields null, never undefined", () => {
  // `undefined` interpolated into `window.SITE_CONFIG=` would be a syntax error
  // in the deployed page rather than a config.
  assert.equal(jsonForInlineScript(undefined), "null");
});

// ── Id shape ─────────────────────────────────────────────────────────────────

test("id guard admits the ids we mint and rejects anything that could break out", () => {
  assert.ok(isSafeIdParam("0f9c2a44-6b1e-4d2a-9f77-2a3b4c5d6e7f"), "randomUUID event id");
  assert.ok(isSafeIdParam("01J8ZK9QK7MZ0P6R3W2V5X8Y1A"), "ULID-ish site id");
  assert.ok(isSafeIdParam(`0x${"a".repeat(64)}`), "0x-prefixed on-chain id");

  assert.ok(!isSafeIdParam("</script><script>alert(1)</script>"));
  assert.ok(!isSafeIdParam('a"bcdefgh'));
  assert.ok(!isSafeIdParam("abcd/efgh"));
  assert.ok(!isSafeIdParam("short"), "under the length floor");
  assert.ok(!isSafeIdParam("a".repeat(101)), "over the length ceiling");
});

// ── URL allowlists ───────────────────────────────────────────────────────────

test("apiUrl comes from the server, so an attacker host cannot be supplied", () =>
  withEnv({ PUBLIC_API_BASE: "https://events-api.woco-net.com" }, () => {
    // The point of discarding rather than comparing: it does not matter what the
    // client sent, only what the server knows about itself.
    assert.equal(resolveDeployApiUrl("https://mallory.example"), "https://events-api.woco-net.com");
    assert.equal(resolveDeployApiUrl("https://events-api.woco-net.com/"), "https://events-api.woco-net.com");
  }));

test("an https host is not enough — this is the gap sanitisePublicApiUrl left", () =>
  withEnv({ PUBLIC_API_BASE: "", NODE_ENV: "production" }, () => {
    // Without a PUBLIC_API_BASE the server has no public identity to bake in, and
    // the client's https value is exactly what must not be trusted.
    assert.equal(resolveDeployApiUrl("https://mallory.example"), null);
  }));

test("gatewayUrl is matched on exact origin, never on host suffix", () =>
  withEnv({ ETHERNA_GATEWAY_URL: "", NODE_ENV: "production" }, () => {
    assert.ok(isAllowedGatewayUrl("https://gateway.woco-net.com"));
    assert.ok(isAllowedGatewayUrl("https://gateway.woco-net.com/"));
    assert.ok(isAllowedGatewayUrl("https://gateway.etherna.io"));

    // `host.endsWith("gateway.woco-net.com")` — the batch router's shape —
    // accepts this. It is a registrable host, so exact origin equality is the
    // requirement.
    assert.ok(!isAllowedGatewayUrl("https://evilgateway.woco-net.com"));
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com.mallory.example"));
    assert.ok(!isAllowedGatewayUrl("https://mallory.example"));
    assert.ok(!isAllowedGatewayUrl("not a url"));
  }));

test("wocoAppUrl rejects javascript: — it is interpolated into an href", () =>
  withEnv({ FRONTEND_URL: "", NODE_ENV: "production" }, () => {
    assert.ok(isAllowedAppUrl("https://woco.eth.limo"));
    assert.ok(!isAllowedAppUrl("javascript:alert(1)"));
    assert.ok(!isAllowedAppUrl("https://mallory.example"));
  }));

test("FRONTEND_URL widens the app allowlist without displacing the default", () =>
  withEnv({ FRONTEND_URL: "https://app.example.org" }, () => {
    assert.deepEqual(allowedAppUrls(), ["https://app.example.org", "https://woco.eth.limo"]);
    assert.ok(isAllowedAppUrl("https://app.example.org"));
    assert.ok(isAllowedAppUrl("https://woco.eth.limo"));
  }));

test("ETHERNA_GATEWAY_URL overrides the etherna entry", () =>
  withEnv({ ETHERNA_GATEWAY_URL: "https://gateway.staging.etherna.io", NODE_ENV: "production" }, () => {
    assert.deepEqual(allowedGatewayUrls(), [
      "https://gateway.woco-net.com",
      "https://gateway.staging.etherna.io",
    ]);
    assert.ok(isAllowedGatewayUrl("https://gateway.staging.etherna.io"));
    assert.ok(!isAllowedGatewayUrl("https://gateway.etherna.io"));
  }));

test("loopback is a dev affordance and is refused in production", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    assert.ok(isAllowedGatewayUrl("http://localhost:1633"));
    assert.ok(isAllowedAppUrl("http://localhost:5173"));
  });
  withEnv({ NODE_ENV: "production" }, () => {
    assert.ok(!isAllowedGatewayUrl("http://localhost:1633"));
    assert.ok(!isAllowedAppUrl("http://localhost:5173"));
  });
});

test("the composite resolver fails closed and names the field that failed", () =>
  withEnv(
    { PUBLIC_API_BASE: "https://events-api.woco-net.com", FRONTEND_URL: "", ETHERNA_GATEWAY_URL: "", NODE_ENV: "production" },
    () => {
      const good = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com",
        wocoAppUrl: "https://woco.eth.limo",
      });
      assert.equal(good.ok, true);
      assert.deepEqual(good.ok && good.urls, {
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com",
        wocoAppUrl: "https://woco.eth.limo",
      });

      const badGateway = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://mallory.example",
        wocoAppUrl: "https://woco.eth.limo",
      });
      assert.equal(badGateway.ok, false);
      assert.match(badGateway.ok === false ? badGateway.error : "", /gatewayUrl/);

      const badApp = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com",
        wocoAppUrl: "javascript:alert(1)",
      });
      assert.equal(badApp.ok, false);
      assert.match(badApp.ok === false ? badApp.error : "", /wocoAppUrl/);
    },
  ));
