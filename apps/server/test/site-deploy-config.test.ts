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
 *      page makes, so an arbitrary https host is not "clean" — it is the whole problem.
 *
 * The escape table's last two entries are literal U+2028/U+2029, invisible in an
 * editor. These assertions are what stops a reformat silently dropping them, so
 * they build those characters by code point rather than pasting them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedAppUrls,
  canonicalOrigin,
  siteConfigScript,
  escapeHtmlAttribute,
  injectBeforeHeadClose,
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
  const payload = { site: { title: "</script><script>MARKER</script>" } };
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
    title: "</script><script>MARKER</script>",
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

  assert.ok(!isSafeIdParam("</script><script>MARKER</script>"));
  assert.ok(!isSafeIdParam('a"bcdefgh'));
  assert.ok(!isSafeIdParam("abcd/efgh"));
  assert.ok(!isSafeIdParam("short"), "under the length floor");
  assert.ok(!isSafeIdParam("a".repeat(101)), "over the length ceiling");
});

test("every id the builder can mint passes the guard, including its degenerate ones", () => {
  // #213 puts this guard in front of `sitesRouter`'s id params. That only
  // improves things if REAL ids pass it — a guard that refuses every live site
  // is a worse outage than the asymmetry it closes, and it would refuse them at
  // read routes too, so nobody could even load a site to diagnose it.
  //
  // Mirrors `uid()` in MultiSiteBuilder.svelte:31 and PagesTab.svelte:21:
  //   `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  const uid = (rnd: number, now: number) =>
    `${now.toString(36)}-${rnd.toString(36).slice(2, 9)}`;

  for (let i = 0; i < 500; i++) {
    const id = uid(Math.random(), Date.now());
    assert.ok(isSafeIdParam(id), `builder-minted id rejected: ${JSON.stringify(id)}`);
  }

  // The two ends of the random suffix, which are what a length floor can trip on.
  // `Math.random()` returning 0 yields "0" — `slice(2, 9)` is then EMPTY, so the
  // id is the timestamp plus a trailing hyphen and nothing else. That is the
  // shortest id this generator can produce.
  assert.equal(uid(0, 1787668185643), "mt8rhc17-");
  assert.ok(isSafeIdParam(uid(0, 1787668185643)), "shortest possible builder id");
  assert.ok(isSafeIdParam(uid(0.9999999999999999, 1787668185643)), "longest possible builder id");

  // The timestamp half is 8 base36 chars from 2010 until 2059, so the floor of 8
  // is not being met by the suffix alone at any point we care about.
  assert.equal(new Date(parseInt("100000000", 36)).getUTCFullYear(), 2059);
});

// ── URL allowlists ───────────────────────────────────────────────────────────

test("apiUrl comes from the server, so a caller-chosen host cannot be supplied", () =>
  withEnv({ PUBLIC_API_BASE: "https://events-api.woco-net.com" }, () => {
    // The point of discarding rather than comparing: it does not matter what the
    // client sent, only what the server knows about itself.
    assert.equal(resolveDeployApiUrl("https://not-our-host.example"), "https://events-api.woco-net.com");
    assert.equal(resolveDeployApiUrl("https://events-api.woco-net.com/"), "https://events-api.woco-net.com");
  }));

test("an https host is not enough — this is the gap sanitisePublicApiUrl left", () =>
  withEnv({ PUBLIC_API_BASE: "", NODE_ENV: "production" }, () => {
    // Without a PUBLIC_API_BASE the server has no public identity to bake in, and
    // the client's https value is exactly what must not be trusted.
    assert.equal(resolveDeployApiUrl("https://not-our-host.example"), null);
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
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com.not-our-host.example"));
    assert.ok(!isAllowedGatewayUrl("https://not-our-host.example"));
    assert.ok(!isAllowedGatewayUrl("not a url"));
  }));

test("wocoAppUrl rejects javascript: — it is interpolated into an href", () =>
  withEnv({ FRONTEND_URL: "", NODE_ENV: "production" }, () => {
    assert.ok(isAllowedAppUrl("https://woco.eth.limo"));
    assert.ok(!isAllowedAppUrl("javascript:MARKER"));
    assert.ok(!isAllowedAppUrl("https://not-our-host.example"));
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
        gatewayUrl: "https://not-our-host.example",
        wocoAppUrl: "https://woco.eth.limo",
      });
      assert.equal(badGateway.ok, false);
      assert.match(badGateway.ok === false ? badGateway.error : "", /gatewayUrl/);

      const badApp = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com",
        wocoAppUrl: "javascript:MARKER",
      });
      assert.equal(badApp.ok, false);
      assert.match(badApp.ok === false ? badApp.error : "", /wocoAppUrl/);
    },
  ));

// ── Head injection ───────────────────────────────────────────────────────────
//
// Every case below was found by a review of the first cut of this
// fix, which closed the inline-script hole and left three other routes to the
// same outcome open.

test("$ patterns in the payload are not expanded by the replacement", () => {
  // String.replace expands $$, $&, $` and $' inside a STRING replacement. The
  // snippet carries organiser free text, so a brand name was enough to reach it.
  const html = "<head>\nBEFORE\n</head>\nAFTER";

  const dollars = injectBeforeHeadClose(html, `  <script>x=${jsonForInlineScript({ n: "$$" })};</script>`);
  assert.ok(dollars.includes('{"n":"$$"}'), `$$ was collapsed: ${dollars}`);

  const backtick = injectBeforeHeadClose(html, `  <script>x=${jsonForInlineScript({ n: "$`" })};</script>`);
  assert.ok(!backtick.includes("BEFORE\n  <script>x={\"n\":\"<head>"), "document was spliced into the payload");
  assert.ok(backtick.includes('{"n":"$`"}'), `$\` was expanded: ${backtick}`);

  const all = injectBeforeHeadClose(html, jsonForInlineScript({ n: "$& $' $` $$" }));
  assert.deepEqual(JSON.parse(all.split("\n")[2]), { n: "$& $' $` $$" });
});

test("the snippet lands before </head> and the document is otherwise untouched", () => {
  const out = injectBeforeHeadClose("<head>\nA\n</head>\nB", "  X");
  assert.equal(out, "<head>\nA\n  X\n  </head>\nB");
});

// ── Attribute escaping ───────────────────────────────────────────────────────

test("attribute escaping closes the quote, not just the angle brackets", () => {
  // The deploy builds <meta content="..."> from organiser theme fields. An
  // escaper that omits `"` leaves the attribute breakable.
  const out = escapeHtmlAttribute('#000"><script>MARKER</script>');
  assert.ok(!out.includes('"'), "raw quote survived");
  assert.ok(!out.includes("<"), "raw < survived");
  assert.ok(!out.includes(">"), "raw > survived");
  assert.equal(escapeHtmlAttribute("O'Neill & Sons"), "O&#39;Neill &amp; Sons");
});

// ── Allowlist: origin equality is not enough on its own ──────────────────────

test("an allowed origin carrying a path is refused", () =>
  withEnv({ ETHERNA_GATEWAY_URL: "", FRONTEND_URL: "", NODE_ENV: "production" }, () => {
    // These values are not merely compared, they are CARRIED: gatewayUrl becomes
    // `${gatewayUrl}/bytes/${ref}` inside an href, wocoAppUrl becomes
    // `${wocoAppUrl}/#/legal/privacy`. Origin equality alone let the path through.
    assert.ok(!isAllowedGatewayUrl('https://gateway.woco-net.com/"><script>MARKER</script>'));
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com/some/path"));
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com/?q=1"));
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com/#frag"));
    assert.ok(!isAllowedAppUrl('https://woco.eth.limo/"><script>MARKER</script>'));

    // A bare origin, with or without the trailing slash, still passes.
    assert.ok(isAllowedGatewayUrl("https://gateway.woco-net.com"));
    assert.ok(isAllowedGatewayUrl("https://gateway.woco-net.com/"));
  }));

test("blob: and userinfo do not sneak past on a borrowed origin", () =>
  withEnv({ ETHERNA_GATEWAY_URL: "", FRONTEND_URL: "", NODE_ENV: "production" }, () => {
    // new URL("blob:https://gateway.woco-net.com/1").origin IS the allowed
    // origin — the bare-origin requirement is what rejects it.
    assert.ok(!isAllowedGatewayUrl("blob:https://gateway.woco-net.com/1234"));
    assert.ok(!isAllowedAppUrl("blob:https://woco.eth.limo/1234"));
    assert.ok(!isAllowedGatewayUrl("https://gateway.woco-net.com@not-our-host.example"));
    assert.ok(!isAllowedGatewayUrl("https://user:pw@gateway.woco-net.com"));
  }));

test("the composite resolver carries only the bare origin forward", () =>
  withEnv(
    { PUBLIC_API_BASE: "https://events-api.woco-net.com", FRONTEND_URL: "", ETHERNA_GATEWAY_URL: "", NODE_ENV: "production" },
    () => {
      const withPath = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: 'https://gateway.woco-net.com/"><script>MARKER</script>',
        wocoAppUrl: "https://woco.eth.limo",
      });
      assert.equal(withPath.ok, false, "a path on an allowed origin was accepted");

      const ok = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com/",
        wocoAppUrl: "https://woco.eth.limo/",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.ok && ok.urls.gatewayUrl, "https://gateway.woco-net.com");
      assert.equal(ok.ok && ok.urls.wocoAppUrl, "https://woco.eth.limo");
    },
  ));


// ── The emitted script element ───────────────────────────────────────────────

/** Evaluate the emitted element the way a browser would. */
function evalEmitted(el: string): unknown {
  const expr = el.replace(/^<script>window\.SITE_CONFIG=/, "").replace(/;<\/script>$/, "");
  // eslint-disable-next-line no-eval
  return (0, eval)(`(${expr})`);
}

test("__proto__ in the payload stays a property and does not become the prototype", () => {
  // Built with JSON.parse, exactly as the request body arrives: JSON.parse creates
  // __proto__ as an OWN property. Writing `{ __proto__: ... }` in source here would
  // instead set this object's prototype and stringify would never see the key —
  // which is the same asymmetry the emitted script has to avoid on the page.
  const site = JSON.parse('{"brandName":"ok","__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(site, "__proto__"), true, "test fixture is wrong");

  const value = evalEmitted(siteConfigScript({ site })) as { site: Record<string, unknown> };

  assert.equal(
    Object.prototype.hasOwnProperty.call(value.site, "__proto__"),
    true,
    "__proto__ was consumed as a prototype instead of surviving as a property",
  );
  assert.equal(Object.getPrototypeOf(value.site), Object.prototype, "the prototype was replaced");
  assert.equal((value.site as { polluted?: boolean }).polluted, undefined);
});

test("the emitted element assigns SITE_CONFIG and a closing tag in the data cannot end it", () => {
  const payload = { title: "</script><script>ignored</script>", n: 1 };
  const el = siteConfigScript(payload);

  assert.ok(el.startsWith("<script>window.SITE_CONFIG="), "assignment shape changed");
  // Exactly one closing tag: the element's own. The one in the data is escaped.
  assert.equal(el.match(/<\/script>/g)?.length, 1, "the data opened or closed a tag");
  assert.ok(el.includes("\\u003c"), "< was not escaped in the payload");
  assert.deepEqual(evalEmitted(el), payload);
});

test("the allowlist forwards the parsed origin, not the submitted bytes", () =>
  withEnv(
    { PUBLIC_API_BASE: "https://events-api.woco-net.com", FRONTEND_URL: "", ETHERNA_GATEWAY_URL: "", NODE_ENV: "production" },
    () => {
      // Validating a string then carrying it forward is the shape that let a
      // crafted path ride an allowed origin. Only the canonical origin travels.
      const res = resolveDeployUrls({
        apiUrl: "https://events-api.woco-net.com",
        gatewayUrl: "https://gateway.woco-net.com/",
        wocoAppUrl: "https://woco.eth.limo/",
      });
      assert.equal(res.ok, true);
      assert.equal(res.ok && res.urls.gatewayUrl, "https://gateway.woco-net.com");
      assert.equal(res.ok && res.urls.wocoAppUrl, "https://woco.eth.limo");
    },
  ));

test("an unset NODE_ENV is treated as production, not as development", () =>
  withEnv({ NODE_ENV: undefined, ETHERNA_GATEWAY_URL: "", FRONTEND_URL: "" }, () => {
    // Unset-means-dev is how a loopback allowance ends up live in production.
    assert.ok(!isAllowedGatewayUrl("http://localhost:1633"));
    assert.ok(!isAllowedAppUrl("http://localhost:5173"));
  }));

test("both deploy routes bake the canonical origin, not the submitted form", () =>
  withEnv({ ETHERNA_GATEWAY_URL: "", NODE_ENV: "production" }, () => {
    // routes/site.ts kept the submitted string after validating the parsed one,
    // so a trailing slash, an odd-case host or an explicit :443 was baked into a
    // page that cannot be edited afterwards.
    assert.equal(canonicalOrigin("https://gateway.woco-net.com/"), "https://gateway.woco-net.com");
    assert.equal(canonicalOrigin("https://GATEWAY.WOCO-NET.COM"), "https://gateway.woco-net.com");
    assert.equal(canonicalOrigin("https://gateway.woco-net.com:443"), "https://gateway.woco-net.com");
    assert.equal(canonicalOrigin("not a url"), null);
  }));
