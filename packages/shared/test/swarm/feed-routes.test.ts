/**
 * The shared family table and the one host rule (#657). Client and server both
 * read these, so the pins here are the ones that hold for both ends at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ETHERNA_GATEWAY_URL,
  FEED_FAMILIES,
  FEED_FAMILY_POLICY,
  FEED_FAMILY_STAMPS,
  FEED_FAMILY_STORES,
  feedStampForName,
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
  assert.deepEqual(onEtherna, ["event", "manifest", "profile", "referral", "site", "social"]);
  const onWoco = FEED_FAMILIES.filter((f) => FEED_FAMILY_STORES[f] === "woco").sort();
  assert.deepEqual(onWoco, [
    "campaignIssuer", "cert", "credits", "evidence", "guardianIndex",
    "recoveryEnvelope", "recoveryPortability",
  ]);
  assert.ok(Object.isFrozen(FEED_FAMILIES));
});

test("which batch pays - recovery material and server output never ride an account's own batch (#689)", () => {
  const platform = FEED_FAMILIES.filter((f) => FEED_FAMILY_STAMPS[f] === "platform").sort();
  assert.deepEqual(platform, ["campaignIssuer", "evidence", "guardianIndex", "recoveryEnvelope", "recoveryPortability"]);
  const owner = FEED_FAMILIES.filter((f) => FEED_FAMILY_STAMPS[f] === "owner").sort();
  assert.deepEqual(owner, ["cert", "credits", "event", "manifest", "profile", "referral", "site", "social"]);
});

test("the two columns are read off the one policy row", () => {
  for (const f of FEED_FAMILIES) {
    assert.equal(FEED_FAMILY_STORES[f], FEED_FAMILY_POLICY[f].store, f);
    assert.equal(FEED_FAMILY_STAMPS[f], FEED_FAMILY_POLICY[f].stamp, f);
  }
  assert.deepEqual(Object.keys(FEED_FAMILY_STORES), [...FEED_FAMILIES]);
  assert.ok(Object.isFrozen(FEED_FAMILY_STORES));
  assert.ok(Object.isFrozen(FEED_FAMILY_STAMPS));
});

test("a client's family name picks a stamp only when it IS a family", () => {
  assert.equal(feedStampForName("recoveryEnvelope"), "platform");
  assert.equal(feedStampForName("guardianIndex"), "platform");
  assert.equal(feedStampForName("profile"), "owner");
  for (const junk of [undefined, null, 7, "", "nonsense", "__proto__", "constructor", "toString", "etherna", "woco"]) {
    assert.equal(feedStampForName(junk), "owner", String(junk));
  }
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
