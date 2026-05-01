/**
 * Validation test: does Etherna's "offer a feed manifest" cover ALL future
 * chunks the feed points to, or only the manifest + the chunk at offer-time?
 *
 * Pattern under test:
 *   1. Create feed manifest (woner+topic) → manifestRef
 *   2. POST /api/v0.3/resources/{manifestRef}/offers   ← ONCE
 *   3. Anonymous GET /bzz/{manifestRef}/  → expect payload v1
 *   4. Update feed (new index, new payload v2) — NO further offer call
 *   5. Anonymous GET /bzz/{manifestRef}/  → does it return v2?
 *
 * PASS = offer-once is sufficient → backend wires "offer manifest at feed
 *        creation" only.
 * FAIL = manifest is offered but feed updates aren't → backend must offer
 *        each new chunk after every feed write.
 *
 * Run: ETHERNA_API_KEY=<rotated> npx tsx scripts/etherna-feed-test.ts
 */

import { Bee, PrivateKey, Topic, type FeedWriter } from "@ethersphere/bee-js";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

// bee-js v11 ships its own nested copy of axios — root-level axios interceptors
// don't fire for its requests. Resolve bee-js's axios and register on THAT.
const beeRequire = createRequire(
  new URL("../../../node_modules/@ethersphere/bee-js/", import.meta.url),
);
const beeAxios = beeRequire("axios");

const ETHERNA_GW = "https://gateway.etherna.io";
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const BATCH_ID = "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";

async function getToken(): Promise<string> {
  const apiKey = process.env.ETHERNA_API_KEY;
  if (!apiKey) throw new Error("ETHERNA_API_KEY env var required");
  const dot = apiKey.indexOf(".");
  if (dot === -1) throw new Error("ETHERNA_API_KEY must be <id>.<secret>");

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "apiKeyClientId",
    username: apiKey.slice(0, dot),
    password: apiKey.slice(dot + 1),
    scope: "openid profile offline_access ether_accounts role userApi.gateway",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

async function offerResource(token: string, ref: string): Promise<void> {
  const url = `${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`offer ${ref.slice(0, 12)}: ${res.status} ${txt}`);
  }
}

async function anonRead(ref: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${ETHERNA_GW}/bzz/${ref}/`);
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

async function writeAndRefFeed(
  bee: Bee,
  writer: FeedWriter,
  payload: string,
): Promise<string> {
  // Upload as a /bzz manifest (single-file) so /bzz resolution can cascade
  // through the chain. /bytes (uploadData) returns a raw chunk ref, which
  // /bzz can't resolve as the next step in feedManifest → feed → ref.
  const bytes = new TextEncoder().encode(payload);
  const up = await bee.uploadFile(BATCH_ID, bytes, "payload", {
    deferred: true,
    contentType: "text/plain",
  });
  const ref = up.reference.toString().toLowerCase();
  await writer.uploadReference(BATCH_ID, ref);
  return ref;
}

async function main() {
  const token = await getToken();
  console.log("[01] auth ok");

  // Inject auth on bee-js's own axios instance.
  beeAxios.interceptors.request.use((cfg: any) => {
    const url = `${cfg.baseURL ?? ""}${cfg.url ?? ""}`;
    if (url.startsWith(ETHERNA_GW)) {
      cfg.headers = cfg.headers ?? {};
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });

  const bee = new Bee(ETHERNA_GW);

  // Fresh test signer — never use the production FEED_PRIVATE_KEY
  const signer = new PrivateKey(("0x" + randomBytes(32).toString("hex")) as `0x${string}`);
  const owner = signer.publicKey().address();
  console.log("[02] test signer:", owner.toHex());

  // Unique topic per run — first 32 bytes of a string hash
  const topic = Topic.fromString(`woco-etherna-feedtest-${Date.now()}`);
  console.log("[03] topic:", topic.toHex().slice(0, 16) + "…");

  // --- Round 1: create manifest, write v1, offer, read ---
  const manifestResult = await bee.createFeedManifest(BATCH_ID, topic, owner);
  const manifestRef = manifestResult.toString().toLowerCase().replace(/^0x/, "");
  console.log("[04] feed manifest ref:", manifestRef);

  const writer = bee.makeFeedWriter(topic, signer);

  // Write v1 data + reference into feed at index 0
  const v1Ref = await writeAndRefFeed(bee, writer, "WOCO-ETHERNA-TEST-V1");
  console.log("[05] feed @0 → /bytes ref:", v1Ref.slice(0, 16) + "…");

  // Offer the manifest (ONE TIME)
  await offerResource(token, manifestRef);
  console.log("[06] offered manifest");

  // Some content also needs offering — try offering the v1 payload ref too
  // so the test isolates "does the offer cover future feed updates?" from
  // "does manifest offer cascade to current resolution chain?"
  // We offer v1 here, deliberately do NOT offer v2 below.
  await offerResource(token, v1Ref);
  console.log("[07] offered v1 ref (control)");

  // Allow propagation
  await new Promise((r) => setTimeout(r, 3000));

  const r1 = await anonRead(manifestRef);
  console.log(`[08] anon read after v1 + offers → HTTP ${r1.status}: "${r1.body.slice(0, 60)}"`);

  // --- Round 2: write v2 to same feed (new index), NO further offer ---
  const v2Ref = await writeAndRefFeed(bee, writer, "WOCO-ETHERNA-TEST-V2-AFTER-OFFER");
  console.log("[09] feed @1 → /bytes ref:", v2Ref.slice(0, 16) + "… (NOT offered)");

  await new Promise((r) => setTimeout(r, 3000));

  // ALSO offer v2 so the resolution chain has all hops anonymously available.
  // This isolates "does /bzz feed-manifest resolution work end-to-end" from
  // "does offer-cascade cover future updates".
  await offerResource(token, v2Ref);
  console.log("[10b] offered v2 ref (so chain has all parts public)");

  await new Promise((r) => setTimeout(r, 3000));

  // Try several read paths to identify the supported pattern
  const readPaths = [
    { label: "/bzz/{manifest}",          url: `${ETHERNA_GW}/bzz/${manifestRef}` },
    { label: "/bzz/{manifest}/",         url: `${ETHERNA_GW}/bzz/${manifestRef}/` },
    { label: "/bzz/{manifest}/payload",  url: `${ETHERNA_GW}/bzz/${manifestRef}/payload` },
    { label: "/bytes/{manifest}",        url: `${ETHERNA_GW}/bytes/${manifestRef}` },
  ];
  console.log("\n=== anon reads of feed manifest with v1+v2 offered ===");
  for (const { label, url } of readPaths) {
    const res = await fetch(url, { redirect: "manual" });
    const body = await res.text().catch(() => "");
    console.log(`  ${label.padEnd(28)} → HTTP ${res.status} ${res.headers.get("swarm-feed-index") ? `[idx ${res.headers.get("swarm-feed-index")}]` : ""} body="${body.slice(0, 50)}"`);
  }

  // --- Diagnose ---
  console.log("\n=== Diagnostic checks ===");
  // direct check — un-offered read should always 402
  const v2DirectCheck = await anonRead(v2Ref);
  console.log(`  v2 ref direct (now offered) → HTTP ${v2DirectCheck.status} body="${v2DirectCheck.body.slice(0, 50)}"`);
  // v1 also should still be 200
  const v1DirectCheck = await anonRead(v1Ref);
  console.log(`  v1 ref direct (offered)     → HTTP ${v1DirectCheck.status} body="${v1DirectCheck.body.slice(0, 50)}"`);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
});
