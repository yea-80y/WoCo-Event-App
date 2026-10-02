/**
 * #746: every organiser action confirms it's the account holder before it acts -
 * one passkey confirm per unlock window, then none. Actions that need the seed
 * anyway (publishing, attendee details, the audience list, cancelling) are gated
 * by that unlock already; these are the ones that would otherwise run on the
 * session or the cached feed signer alone, which an unlocked lost phone still has.
 *
 * Pinned at the source: the components cannot be mounted here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** From a function's signature to the first `until` inside it. */
function before(src: string, signature: string, until: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  const end = src.indexOf(until, start);
  assert.ok(end > start, `${until} must follow ${signature}`);
  return src.slice(start, end);
}

const GATED: Array<[file: string, signature: string, action: string]> = [
  ["creator/dashboard/Dashboard.svelte", "async function handleSendBroadcast", "startBroadcast("],
  ["creator/dashboard/Dashboard.svelte", "async function handleSendBroadcast", "if (!confirm("],
  ["creator/dashboard/Dashboard.svelte", "async function sendOne", "webhookRelay("],
  ["creator/dashboard/Dashboard.svelte", "async function updateCancelledPage", "auth.getContentFeedSigner()"],
  ["creator/audience/MarketingComposer.svelte", "async function handleSend(", "if (!confirm("],
  ["creator/audience/MarketingComposer.svelte", "async function handleSend(", "startBroadcast("],
  ["creator/dashboard/DashboardIndex.svelte", "async function handleList", "/list`"],
  ["creator/dashboard/DashboardIndex.svelte", "async function handleUnlist", "/unlist`"],
  ["creator/dashboard/StripeConnect.svelte", "async function handleConnect", "connectStripe()"],
  ["creator/dashboard/StripeConnectModal.svelte", "async function handleConnect", "connectStripe()"],
  ["creator/dashboard/CheckinPanel.svelte", "async function generatePass", "pushCheckinRoster("],
  ["creator/dashboard/CheckinPanel.svelte", "async function refreshRoster", "pushCheckinRoster("],
  ["creator/builder/tabs/EventsTab.svelte", "async function persistToggle", "await write()"],
  ["creator/sites/SiteEventsManager.svelte", "async function toggle", "SiteEvent(siteId"],
  ["creator/builder/DomainLinker.svelte", "async function connect", "registerSiteDomain("],
  ["creator/builder/DomainLinker.svelte", "async function disconnect", "removeDomain("],
  ["creator/audience/SendingDomainPanel.svelte", "async function connect", "createSendingDomain("],
  ["creator/audience/SendingDomainPanel.svelte", "async function disconnect", "removeSendingDomain("],
  ["creator/events/EditEventPanel.svelte", "async function save()", "auth.getContentFeedSigner()"],
  ["creator/events/EditEventPanel.svelte", "async function handleDelete", "auth.getContentFeedSigner()"],
  ["creator/builder/MultiSiteBuilder.svelte", "const publishSequence = async () => {", "uploadSiteImage("],
  ["creator/SiteBuilder.svelte", "async function handleDeploy", "deployToSwarm()"],
];

for (const [file, signature, action] of GATED) {
  test(`${file}: ${signature} confirms before ${action}`, () => {
    const src = read(`../src/lib/${file}`);
    assert.match(before(src, signature, action), /await auth\.ensureOrganiserUnlock\(\);/);
  });
}

test("every gated component imports the auth store it calls", () => {
  for (const file of new Set(GATED.map(([f]) => f))) {
    assert.match(read(`../src/lib/${file}`), /import \{ auth \} from ["'][./]+\/auth\/auth-store\.svelte\.js["'];/, file);
  }
});

test("a declined confirm is shown where the action reports its errors", () => {
  const dash = read("../src/lib/creator/dashboard/Dashboard.svelte");
  assert.match(
    before(dash, "async function handleSendBroadcast", "getEmailRecipients("),
    /catch \(e\) \{\s*broadcastError = e instanceof Error \? e\.message/,
  );
  const composer = read("../src/lib/creator/audience/MarketingComposer.svelte");
  assert.match(before(composer, "async function handleSend(", "if (!confirm("), /catch \(e\) \{\s*error = e instanceof Error \? e\.message/);
});

test("the organiser decline names no mechanism and uses the spaced hyphen", () => {
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  const message = before(store, "function _organiserLockedMessage", "\n}\n");
  assert.match(message, /Organiser actions stay locked until you confirm it's you - try again when you're ready\./);
  assert.doesNotMatch(message, /fingerprint|biometric|\bPRF\b|quantum|—/i);
});
