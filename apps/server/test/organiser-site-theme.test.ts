/**
 * #983: mail about an event uses a site's theme and contact address only when the site
 * is that event's organiser's. The siteId on a sale is the buyer's checkout pointer.
 *
 * MUTATION: drop the owner comparison and "another organiser's site" goes red; read the
 * theme before checking the record and "no record, no read" goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { organiserSiteTheme } from "../src/lib/ticket-hold/organiser-site.js";

const ORG = "0x" + "aa".repeat(20);
const theme = (ownerAddress?: string) => async () => ({ palette: {} as never, brandName: "Venue", contactEmail: "hello@venue.example", ...(ownerAddress ? { ownerAddress } : {}) });

test("the organiser's own site: its theme and contact", async () => {
  const t = await organiserSiteTheme("site-1", "e1", { creator: () => ORG.toUpperCase().replace("0X", "0x"), theme: theme(ORG) });
  assert.equal(t?.contactEmail, "hello@venue.example");
});

test("another organiser's site, or one with no owner: nothing", async () => {
  assert.equal(await organiserSiteTheme("site-2", "e1", { creator: () => ORG, theme: theme("0x" + "bb".repeat(20)) }), null);
  assert.equal(await organiserSiteTheme("site-3", "e1", { creator: () => ORG, theme: theme() }), null);
});

test("no record of who made the event: nothing, and the site is never read", async () => {
  let read = false;
  const t = await organiserSiteTheme("site-1", "e1", {
    creator: () => undefined,
    theme: async () => {
      read = true;
      return null;
    },
  });
  assert.equal(t, null);
  assert.equal(read, false);
});
