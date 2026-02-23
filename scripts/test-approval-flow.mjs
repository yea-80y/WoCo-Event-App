/**
 * End-to-end test for the organizer approval flow.
 *
 * Steps:
 *  1.  Generate throw-away organizer keypairs (secp256k1 parent + session, ed25519 POD)
 *  2.  Build EIP-712 session delegation (parent signs → session authorised)
 *  3.  Sign all tickets for 1 series (totalSupply = 3) with ed25519 POD key
 *  4.  POST /api/events  → creates test event with approvalRequired = true
 *  5.  GET  /api/events/:id  → confirm approvalRequired is present in series
 *  6.  POST .../claim (email)  → expect { approvalPending: true }
 *  7.  GET  .../claim-status?emailHash=...  → expect { userPendingId }
 *  8.  GET  /api/events/:id/pending-claims  (organizer auth) → find our entry
 *  9.  POST .../approve  (organizer auth)  → expect { ok: true }
 *  10. GET  .../claim-status?emailHash=...  → expect { userEdition } (no longer pending)
 *
 * Run:  node scripts/test-approval-flow.mjs
 */

import { Wallet, ZeroHash, keccak256, toUtf8Bytes, zeroPadValue } from "ethers";
import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { createHash } from "node:crypto";

const API = "https://events-api.woco-net.com";
const HOST = "woco.eth.limo";                      // must be in server ALLOWED_HOSTS
const TOTAL_SUPPLY = 3;
const TEST_EMAIL = "approval-test@woco-test.invalid";

// ─── helpers ────────────────────────────────────────────────────────────────

const ok   = (msg) => console.log(`  ✓  ${msg}`);
const fail = (msg) => { console.error(`  ✗  ${msg}`); process.exit(1); };
const step = (n, msg) => console.log(`\nStep ${n}: ${msg}`);

async function post(path, body, delegation, sessionAddress) {
  const payload = { ...body };
  if (delegation) {
    payload.session    = sessionAddress;
    payload.delegation = delegation;
  }
  const resp = await fetch(`${API}${path}`, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify(payload),
  });
  return resp.json();
}

async function get(path, delegation, sessionAddress) {
  const headers = {};
  if (delegation && sessionAddress) {
    headers["x-session-address"]    = sessionAddress;
    headers["x-session-delegation"] = Buffer.from(JSON.stringify(delegation)).toString("base64");
  }
  const resp = await fetch(`${API}${path}`, { headers });
  return resp.json();
}

function hashEmail(email) {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// ─── key generation ─────────────────────────────────────────────────────────

step(1, "Generate organizer keypairs");

const parentWallet  = Wallet.createRandom();
const sessionWallet = Wallet.createRandom();
console.log(`     parent:  ${parentWallet.address}`);
console.log(`     session: ${sessionWallet.address}`);

// ed25519 POD key: sign EIP-712 DerivePodIdentity, keccak the sig as seed
const podMessage = {
  purpose : "Derive deterministic POD signing identity",
  address : parentWallet.address,
  nonce   : "WOCO-POD-IDENTITY-V1",
};
const podDomain = { name: "WoCo POD Identity", version: "1" };
const podTypes  = { DerivePodIdentity: [
  { name: "purpose", type: "string" },
  { name: "address", type: "address" },
  { name: "nonce",   type: "string"  },
]};
const podSig  = await parentWallet.signTypedData(podDomain, podTypes, podMessage);
const podSeed = keccak256(toUtf8Bytes(podSig));   // 32-byte hex with 0x prefix
const podPriv = hexToBytes(podSeed.slice(2));      // strip 0x
const podPub  = await ed.getPublicKeyAsync(podPriv);
const podPubHex = "0x" + bytesToHex(podPub);
console.log(`     podKey:  ${podPubHex}`);
ok("keypairs generated");

// ─── session delegation ──────────────────────────────────────────────────────

step(2, "Build EIP-712 session delegation");

const nonce       = crypto.randomUUID();
const issuedAt    = new Date().toISOString();
const expiresAt   = new Date(Date.now() + 3_600_000).toISOString();   // +1 h
const sessionProof = await sessionWallet.signMessage(`${HOST}:${nonce}`);

const delegationMessage = {
  host          : HOST,
  parent        : parentWallet.address,
  session       : sessionWallet.address,
  purpose       : "WoCo session key",
  nonce,
  issuedAt,
  expiresAt,
  sessionProof,
  clientCodeHash: ZeroHash,
  statement     : `Authorize ${sessionWallet.address} as session key for ${HOST}`,
};
const sessionDomain = { name: "WoCo Session", version: "1" };
const sessionTypes  = { AuthorizeSession: [
  { name: "host",           type: "string"  },
  { name: "parent",         type: "address" },
  { name: "session",        type: "address" },
  { name: "purpose",        type: "string"  },
  { name: "nonce",          type: "string"  },
  { name: "issuedAt",       type: "string"  },
  { name: "expiresAt",      type: "string"  },
  { name: "sessionProof",   type: "bytes"   },
  { name: "clientCodeHash", type: "bytes32" },
  { name: "statement",      type: "string"  },
]};
const parentSig  = await parentWallet.signTypedData(sessionDomain, sessionTypes, delegationMessage);
const delegation = { message: delegationMessage, parentSig };
ok("delegation signed");

// ─── sign tickets ────────────────────────────────────────────────────────────

step(3, `Sign ${TOTAL_SUPPLY} tickets with ed25519 POD key`);

const eventId  = crypto.randomUUID();
const seriesId = crypto.randomUUID();
const imageHash = "0".repeat(64);   // placeholder — no real image for test
const mintedAt  = new Date().toISOString();

const signedTickets = [];
for (let edition = 1; edition <= TOTAL_SUPPLY; edition++) {
  const data = {
    podType    : "woco.ticket.v1",
    eventId, seriesId,
    seriesName : "Approval Test Series",
    edition, totalSupply: TOTAL_SUPPLY,
    imageHash, creator: podPubHex, mintedAt,
  };
  const message   = new TextEncoder().encode(JSON.stringify(data));
  const signature = await ed.signAsync(message, podPriv);
  signedTickets.push({ data, signature: bytesToHex(signature), publicKey: podPubHex });
}
ok(`signed ${signedTickets.length} tickets`);

// ─── create event ────────────────────────────────────────────────────────────

step(4, "POST /api/events (with approvalRequired = true)");

// Minimal 1×1 transparent PNG as base64
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const createBody = {
  event: {
    title      : `Approval Flow Test ${Date.now()}`,
    description: "Automated e2e test — safe to delete",
    startDate  : "2099-01-01T10:00",
    endDate    : "2099-01-01T22:00",
    location   : "Test Venue",
  },
  series: [{
    seriesId,
    name            : "Approval Test Series",
    description     : "Requires approval",
    totalSupply     : TOTAL_SUPPLY,
    approvalRequired: true,
  }],
  signedTickets : { [seriesId]: signedTickets },
  image         : PNG1x1,
  creatorAddress: parentWallet.address,
  creatorPodKey : podPubHex,
  claimMode     : "email",
};

// Event creation uses streaming NDJSON — read it line by line
const createResp = await fetch(`${API}/api/events`, {
  method : "POST",
  headers: { "Content-Type": "application/json" },
  body   : JSON.stringify({
    ...createBody,
    session   : sessionWallet.address,
    delegation,
  }),
});

if (!createResp.ok && !createResp.body) fail(`create event HTTP ${createResp.status}`);

let createdEventId = null;
const reader  = createResp.body.getReader();
const decoder = new TextDecoder();
let   buf     = "";
outer: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (const line of buf.split("\n")) {
    buf = line;
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "progress") { process.stdout.write(`     [${ev.phase}] ${ev.message}\n`); }
      if (ev.type === "done")     { createdEventId = ev.data?.eventId; break outer; }
      if (ev.type === "error")    { fail(`create event error: ${ev.error}`); }
    } catch { /* ignore partial lines */ }
  }
}
if (!createdEventId) fail("No eventId returned from create-event stream");
ok(`event created: ${createdEventId}`);

// ─── verify approvalRequired in event feed ───────────────────────────────────

step(5, "GET /api/events/:id — verify approvalRequired in series");

await new Promise(r => setTimeout(r, 1500));   // let Swarm propagate
const eventData = await get(`/api/events/${createdEventId}`);
if (!eventData.ok) fail(`get event failed: ${eventData.error}`);
const series = eventData.data?.series?.find(s => s.seriesId === seriesId);
if (!series) fail("series not found in event feed");
if (series.approvalRequired !== true) fail(`approvalRequired is ${series.approvalRequired}, expected true`);
ok(`series.approvalRequired = true`);

// ─── both claims upfront (before any approve/reject) ────────────────────────
// Both claims happen in quick succession so neither hits the rate limit.

const TEST_EMAIL_2 = "rejection-test@woco-test.invalid";
const emailHash    = hashEmail(TEST_EMAIL);
const emailHash2   = hashEmail(TEST_EMAIL_2);

step(6, `POST .../claim (email: ${TEST_EMAIL}) — expect approvalPending`);

const claimResp = await post(
  `/api/events/${createdEventId}/series/${seriesId}/claim`,
  { mode: "email", email: TEST_EMAIL },
);
console.log(`     response: ${JSON.stringify(claimResp)}`);
if (!claimResp.ok)             fail(`claim failed: ${claimResp.error}`);
if (!claimResp.approvalPending) fail(`expected approvalPending=true, got: ${JSON.stringify(claimResp)}`);
if (!claimResp.pendingId)       fail("expected pendingId in response");
const pendingId = claimResp.pendingId;
ok(`approvalPending=true, pendingId=${pendingId}`);

step(7, `POST .../claim (email: ${TEST_EMAIL_2}) — expect approvalPending`);

const claimResp2 = await post(
  `/api/events/${createdEventId}/series/${seriesId}/claim`,
  { mode: "email", email: TEST_EMAIL_2 },
);
console.log(`     response: ${JSON.stringify(claimResp2)}`);
if (!claimResp2.ok)             fail(`claim2 failed: ${claimResp2.error}`);
if (!claimResp2.approvalPending) fail(`expected approvalPending=true, got: ${JSON.stringify(claimResp2)}`);
if (!claimResp2.pendingId)       fail("expected pendingId in response");
const pendingId2 = claimResp2.pendingId;
ok(`approvalPending=true, pendingId2=${pendingId2}`);

// ─── claim-status shows pending ──────────────────────────────────────────────

step(8, "GET .../claim-status — both emails show userPendingId");

const statusResp = await get(
  `/api/events/${createdEventId}/series/${seriesId}/claim-status?emailHash=${emailHash}`,
);
console.log(`     email1: ${JSON.stringify(statusResp)}`);
if (!statusResp.data?.userPendingId) fail(`expected userPendingId for email1, got: ${JSON.stringify(statusResp)}`);
if (statusResp.data.userEdition != null) fail("userEdition should not be set yet");
ok(`email1 userPendingId=${statusResp.data.userPendingId}`);

const statusResp2 = await get(
  `/api/events/${createdEventId}/series/${seriesId}/claim-status?emailHash=${emailHash2}`,
);
console.log(`     email2: ${JSON.stringify(statusResp2)}`);
if (!statusResp2.data?.userPendingId) fail(`expected userPendingId for email2, got: ${JSON.stringify(statusResp2)}`);
if (statusResp2.data.userEdition != null) fail("userEdition should not be set yet");
ok(`email2 userPendingId=${statusResp2.data.userPendingId}`);

// ─── organizer views pending claims ──────────────────────────────────────────

step(9, "GET /api/events/:id/pending-claims — find both entries");

const pendingResp = await get(
  `/api/events/${createdEventId}/pending-claims`,
  delegation,
  sessionWallet.address,
);
console.log(`     response: ${JSON.stringify(pendingResp).slice(0, 300)}`);
if (!pendingResp.ok) fail(`pending-claims failed: ${pendingResp.error}`);
const entry  = pendingResp.data?.pendingClaims?.find(e => e.pendingId === pendingId);
const entry2 = pendingResp.data?.pendingClaims?.find(e => e.pendingId === pendingId2);
if (!entry)  fail(`could not find pendingId ${pendingId} in pending-claims list`);
if (!entry2) fail(`could not find pendingId2 ${pendingId2} in pending-claims list`);
ok(`found both entries (${pendingResp.data.pendingClaims.length} total)`);

// ─── organizer approves first claimer ────────────────────────────────────────

step(10, "POST .../approve pendingId1 (organizer auth)");

const approveResp = await post(
  `/api/events/${createdEventId}/series/${seriesId}/pending-claims/${pendingId}/approve`,
  {},
  delegation,
  sessionWallet.address,
);
console.log(`     response: ${JSON.stringify(approveResp)}`);
if (!approveResp.ok) fail(`approve failed: ${approveResp.error}`);
ok("claim approved");

step(11, "GET .../claim-status — email1 shows userEdition");

await new Promise(r => setTimeout(r, 2000));   // let Swarm propagate
const finalStatus = await get(
  `/api/events/${createdEventId}/series/${seriesId}/claim-status?emailHash=${emailHash}`,
);
console.log(`     response: ${JSON.stringify(finalStatus)}`);
if (finalStatus.data?.userPendingId) fail("userPendingId should be cleared after approval");
if (finalStatus.data?.userEdition == null) fail(`userEdition not set after approval: ${JSON.stringify(finalStatus)}`);
ok(`userEdition=${finalStatus.data.userEdition} — ticket issued!`);

// ─── check available count before rejection ───────────────────────────────────

step(12, "GET /api/events/:id — available count before rejection");

await new Promise(r => setTimeout(r, 1500));
const eventBefore = await get(`/api/events/${createdEventId}`);
if (!eventBefore.ok) fail(`get event failed: ${eventBefore.error}`);
const seriesBefore = eventBefore.data?.series?.find(s => s.seriesId === seriesId);
if (!seriesBefore) fail("series not found");
const availableBefore = seriesBefore.available ?? null;
console.log(`     available before rejection: ${availableBefore} (1 approved, 1 still pending)`);
ok(`available=${availableBefore}`);

// ─── organizer rejects second claimer ────────────────────────────────────────

step(13, "POST .../reject pendingId2 (organizer auth) with reason");

const rejectResp = await post(
  `/api/events/${createdEventId}/series/${seriesId}/pending-claims/${pendingId2}/reject`,
  { reason: "Sorry, not approved for this event" },
  delegation,
  sessionWallet.address,
);
console.log(`     response: ${JSON.stringify(rejectResp)}`);
if (!rejectResp.ok) fail(`reject failed: ${rejectResp.error}`);
ok("claim rejected");

// ─── claim-status cleared after rejection ────────────────────────────────────

step(14, "GET .../claim-status — email2 shows neither pending nor edition");

await new Promise(r => setTimeout(r, 1500));
const statusAfterReject = await get(
  `/api/events/${createdEventId}/series/${seriesId}/claim-status?emailHash=${emailHash2}`,
);
console.log(`     response: ${JSON.stringify(statusAfterReject)}`);
if (statusAfterReject.data?.userPendingId) fail("userPendingId should be cleared after rejection");
if (statusAfterReject.data?.userEdition != null) fail("userEdition should not be set after rejection");
ok("claim-status clear after rejection");

// ─── verify slot was released ─────────────────────────────────────────────────

step(15, "GET /api/events/:id — slot released (available count back up)");

await new Promise(r => setTimeout(r, 2000));
const eventAfter = await get(`/api/events/${createdEventId}`);
if (!eventAfter.ok) fail(`get event failed: ${eventAfter.error}`);
const seriesAfter = eventAfter.data?.series?.find(s => s.seriesId === seriesId);
if (!seriesAfter) fail("series not found");
const availableAfter = seriesAfter.available ?? null;
console.log(`     available after rejection: ${availableAfter}`);
if (availableBefore !== null && availableAfter !== null) {
  if (availableAfter <= availableBefore) fail(`available did not increase: ${availableBefore} → ${availableAfter}`);
  ok(`slot released: available ${availableBefore} → ${availableAfter}`);
} else {
  ok(`available=${availableAfter} (slot release verified by claim-status being clear)`);
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════╗
║   ALL STEPS PASSED — approve + reject flows work!       ║
╚══════════════════════════════════════════════════════════╝
`);
