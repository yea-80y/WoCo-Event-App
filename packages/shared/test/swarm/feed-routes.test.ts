/**
 * The shared family table and the one host rule (#657). Client and server both
 * read these, so the pins here are the ones that hold for both ends at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETHERNA_GATEWAY_URL,
  FEED_FAMILIES,
  FEED_FAMILY_STORES,
  WOCO_GATEWAY_URL,
  gatewayHostMatches,
  isEthernaGatewayUrl,
  isWocoGatewayUrl,
} from "../../src/swarm/feed-routes.js";

test("the canonical gateways", () => {
  assert.equal(ETHERNA_GATEWAY_URL, "https://gateway.etherna.io");
  assert.equal(WOCO_GATEWAY_URL, "https://gateway.woco-net.com");
});

test("each family is stamped where the table says - a move is a deliberate diff here", () => {
  const onEtherna = FEED_FAMILIES.filter((f) => FEED_FAMILY_STORES[f] === "etherna").sort();
  assert.deepEqual(onEtherna, [
    "event", "manifest", "profile", "recoveryEnvelope", "recoveryPortability", "referral", "site", "social",
  ]);
  const onWoco = FEED_FAMILIES.filter((f) => FEED_FAMILY_STORES[f] === "woco").sort();
  assert.deepEqual(onWoco, ["campaignIssuer", "cert", "credits", "evidence", "guardianIndex"]);
  assert.ok(Object.isFrozen(FEED_FAMILIES));
});

test("the host rule: the host or a subdomain of it, never a look-alike", () => {
  assert.ok(isEthernaGatewayUrl(ETHERNA_GATEWAY_URL));
  assert.ok(isEthernaGatewayUrl(`${ETHERNA_GATEWAY_URL}/`));
  assert.ok(isEthernaGatewayUrl(`${ETHERNA_GATEWAY_URL}/bzz/abc`));
  assert.ok(isEthernaGatewayUrl("https://GATEWAY.ETHERNA.IO"));
  assert.ok(isEthernaGatewayUrl("https://eu.gateway.etherna.io"));
  // #657 item 3: a suffix match with no dot boundary let these through.
  assert.ok(!isEthernaGatewayUrl("https://xgateway.etherna.io"));
  assert.ok(!isEthernaGatewayUrl("https://gateway.etherna.io.example.com"));
  assert.ok(!isEthernaGatewayUrl("https://etherna.io"));
  assert.ok(!isEthernaGatewayUrl(WOCO_GATEWAY_URL));
  assert.ok(!isEthernaGatewayUrl(undefined));
  assert.ok(!isEthernaGatewayUrl(""));
  assert.ok(!isEthernaGatewayUrl("gateway.etherna.io"), "not a URL");

  assert.ok(isWocoGatewayUrl(WOCO_GATEWAY_URL));
  assert.ok(!isWocoGatewayUrl("https://evilgateway.woco-net.com"));
  assert.ok(!isWocoGatewayUrl(ETHERNA_GATEWAY_URL));
});

test("the rule compares hosts, so a port is part of the host", () => {
  assert.ok(!gatewayHostMatches("https://gateway.etherna.io:8443", ETHERNA_GATEWAY_URL));
  assert.ok(gatewayHostMatches("http://localhost:1633", "http://localhost:1633/"));
});
