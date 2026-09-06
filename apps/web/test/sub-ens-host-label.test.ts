/**
 * A WoCo name host serves this app's own content, so the app decides from its
 * hostname whose profile to open and where sign-in is allowed to happen.
 *
 * Two properties are pinned here, and both are safety rather than polish:
 *
 *  - Only a SINGLE label under `woco.eth.<tld>` counts. A deeper subdomain is
 *    not a name anyone can mint, so treating one as a name would hand an
 *    arbitrary host the profile route and, worse, the "this is a WoCo name"
 *    reading that the sign-in redirect depends on.
 *  - Only the DEFAULT route redirects. A name host reached with a real route
 *    is a link somebody shared; stealing it would break every such link.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_APP_ORIGIN,
  bootRedirectFor,
  canonicalUrl,
  hostLabel,
} from "../src/lib/sub-ens/host-label.js";

test("hostLabel accepts exactly one label under woco.eth.<gateway tld>", () => {
  assert.equal(hostLabel("nabil.woco.eth.link"), "nabil");
  assert.equal(hostLabel("nabil.woco.eth.limo"), "nabil");
  // Hostnames are case-insensitive; the label is a feed/route key, so lowercase.
  assert.equal(hostLabel("NABIL.woco.eth.link"), "nabil");
});

test("hostLabel refuses everything that is not a single-label name host", () => {
  for (const hostname of [
    "woco.eth.limo",        // the apex app itself, not a name
    "gateway.woco-net.com", // the canonical gateway host
    "x.y.woco.eth.link",    // a deeper subdomain is not a mintable name
    "nabil.woco.eth",       // no gateway tld — not a browser-reachable host
    "",
  ]) {
    assert.equal(hostLabel(hostname), null, hostname);
  }
});

test("canonicalUrl carries the current route to the host where login works", () => {
  assert.equal(canonicalUrl("#/profile/x"), `${CANONICAL_APP_ORIGIN}/#/profile/x`);
  assert.equal(canonicalUrl(""), `${CANONICAL_APP_ORIGIN}/`);
});

test("bootRedirectFor opens the profile only on a name host at the default route", () => {
  assert.equal(bootRedirectFor("nabil.woco.eth.link", ""), "nabil");
  assert.equal(bootRedirectFor("nabil.woco.eth.link", "#"), "nabil");
  assert.equal(bootRedirectFor("nabil.woco.eth.link", "#/"), "nabil");
});

test("bootRedirectFor leaves a real route alone, and never fires off a name host", () => {
  assert.equal(bootRedirectFor("nabil.woco.eth.link", "#/events"), null);
  assert.equal(bootRedirectFor("nabil.woco.eth.link", "#/event/abc"), null);
  assert.equal(bootRedirectFor("woco.eth.limo", ""), null);
  assert.equal(bootRedirectFor("gateway.woco-net.com", ""), null);
});
