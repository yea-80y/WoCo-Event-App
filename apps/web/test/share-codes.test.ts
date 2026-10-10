/**
 * Which codes the share sheet offers and where each one goes (owner's phone
 * test, 2026-09-15). The rules under test:
 *   - an address link carries no name, and a name link only a name this account holds;
 *   - a name is used as a web address only once the chain shows it loads;
 *   - the profile name is the person, never a page, and a page name is offered once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { subEnsName, subEnsWebUrl } from "@woco/shared";
import { canonicalUrl } from "../src/lib/sub-ens/host-label.js";
import { referralLink, shareCodes } from "../src/lib/campaign/share-codes.js";

const ADDRESS = "0xAbCdEf0000000000000000000000000000000001";
const address = ADDRESS.toLowerCase();

test("with no name, both codes are app links that carry no name", () => {
  const codes = shareCodes({ address: ADDRESS, profileName: null, held: [] });
  assert.deepEqual(codes.map((c) => c.id), ["invite", "follow"]);
  assert.equal(codes[0]!.link, canonicalUrl(`#/ref/${address}`));
  assert.equal(codes[1]!.link, canonicalUrl(`#/profile/${address}`));
  assert.deepEqual(codes.map((c) => c.name), [null, null]);
});

test("the invite carries the profile name", () => {
  const [invite] = shareCodes({ address: ADDRESS, profileName: "nabil", held: [] });
  assert.equal(invite!.link, referralLink("nabil"));
  assert.equal(invite!.name, "nabil");
});

test("the follow code uses the name's own address only once the chain shows it loads", () => {
  const notSet = shareCodes({ address: ADDRESS, profileName: "nabil", held: [{ label: "nabil", points: false }] })[1]!;
  assert.equal(notSet.link, canonicalUrl(`#/profile/${address}`));
  assert.equal(notSet.name, null);

  const unread = shareCodes({ address: ADDRESS, profileName: "nabil", held: [] })[1]!;
  assert.equal(unread.link, canonicalUrl(`#/profile/${address}`));

  const loads = shareCodes({ address: ADDRESS, profileName: "Nabil", held: [{ label: "nabil", points: true }] })[1]!;
  assert.equal(loads.link, subEnsWebUrl("nabil"));
  assert.equal(loads.name, "nabil");
});

test("a page is offered only for a name this account holds that loads", () => {
  const codes = shareCodes({
    address: ADDRESS,
    profileName: null,
    held: [{ label: "punkpub", points: true }, { label: "spare", points: false }],
    pages: [
      { label: "punkpub", title: "Punk Pub" },
      { label: "spare", title: "Not pointed anywhere" },
      { label: "notmine", title: "Claimed by a feed, held by someone else" },
    ],
  });
  const pages = codes.filter((c) => c.kind === "page");
  assert.deepEqual(pages.map((c) => [c.title, c.link, c.name]), [["Punk Pub", subEnsWebUrl("punkpub"), "punkpub"]]);
});

test("the profile name is never a page, and a name two feeds claim is offered once", () => {
  const codes = shareCodes({
    address: ADDRESS,
    profileName: "nabil",
    held: [{ label: "nabil", points: true }, { label: "punkpub", points: true }],
    pages: [
      { label: "nabil", title: "Also my profile" },
      // A feed may carry any case; the chain holds lower case.
      { label: "PunkPub", title: "Punk Pub" },
      { label: "punkpub", title: "Friday gig" },
    ],
  });
  assert.deepEqual(codes.map((c) => c.id), ["invite", "follow", "punkpub"]);
  assert.equal(codes[2]!.title, "Punk Pub");
});

test("a page with no title shows its name", () => {
  const codes = shareCodes({
    address: ADDRESS,
    profileName: null,
    held: [{ label: "punkpub", points: true }],
    pages: [{ label: "punkpub", title: "" }],
  });
  assert.equal(codes[2]!.title, subEnsName("punkpub"));
});
