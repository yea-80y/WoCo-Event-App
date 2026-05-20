/**
 * Etherna SOC inline-vs-legacy probe.
 *
 * Mirko (2026-05-12) said our deployed-site feed SOCs use the *legacy*
 * inner-chunk format (SOC payload = 32-byte reference to a separate
 * manifest chunk) and Beehive no longer resolves that anonymously
 * through `/bzz/{feedManifest}/...`. Two questions to answer here:
 *
 *   A.  CONFIRM legacy fails on Beehive: write a feed exactly like
 *       apps/server/src/routes/sites.ts:565 — `writer.upload(batchId, new
 *       Reference(contentHash))`, i.e. uploadReference — then offer every
 *       chunk in the resolution chain and try anonymous /bzz reads.
 *
 *   B.  CHECK whether inline embedding works: write a SECOND feed where the
 *       SOC payload is the raw bytes of a directory-manifest chunk (so the
 *       gateway can parse the SOC's inner payload directly as a manifest
 *       without an extra hop). Offer + anonymous read the same way.
 *
 * Result matrix tells us whether we can fix this client-side (switch to
 * inline) or must wait for Mirko's beehive align.
 *
 * Run:
 *   cd apps/server && export $(grep -v '^#' .env | grep ETHERNA_API_KEY | xargs) \
 *     && npx tsx scripts/etherna-soc-legacy-probe.ts
 */

import { Bee, PrivateKey, Reference, Topic } from "@ethersphere/bee-js";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

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

async function offer(token: string, ref: string): Promise<void> {
  const url = `${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`  offer ${ref.slice(0, 12)}: ${res.status} ${txt.slice(0, 80)}`);
  }
}

async function anonGet(url: string): Promise<{ status: number; body: string; len: number }> {
  const res = await fetch(url, { redirect: "manual" });
  const body = await res.text().catch(() => "");
  return { status: res.status, body: body.slice(0, 80), len: body.length };
}

/** Build a small /bzz directory containing one file. Returns { dirRef, fileBody }. */
async function buildTinyDir(bee: Bee): Promise<{ dirRef: string; fileBody: string }> {
  const fileBody = `WOCO-PROBE-${Date.now()}`;
  const up = await bee.uploadFile(BATCH_ID, new TextEncoder().encode(fileBody), "index.html", {
    deferred: true,
    contentType: "text/html",
  });
  return { dirRef: up.reference.toString().toLowerCase().replace(/^0x/, ""), fileBody };
}

/** Fetch the raw chunk bytes (8-byte span + payload) for a given reference. */
async function downloadChunkBytes(token: string, ref: string): Promise<Uint8Array> {
  const res = await fetch(`${ETHERNA_GW}/chunks/${ref}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`downloadChunk ${ref}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function main() {
  const token = await getToken();
  console.log("[init] auth ok");

  beeAxios.interceptors.request.use((cfg: any) => {
    const url = `${cfg.baseURL ?? ""}${cfg.url ?? ""}`;
    if (url.startsWith(ETHERNA_GW)) {
      cfg.headers = cfg.headers ?? {};
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });

  const bee = new Bee(ETHERNA_GW);

  // ====================================================================
  // CASE A — legacy SOC (uploadReference). Mirrors sites.ts:565.
  // ====================================================================
  console.log("\n=== CASE A: legacy SOC (uploadReference → dirRef) ===");
  const aSigner = new PrivateKey(("0x" + randomBytes(32).toString("hex")) as `0x${string}`);
  const aOwner = aSigner.publicKey().address();
  const aTopic = Topic.fromString(`woco-probe-legacy-${Date.now()}`);

  const aDir = await buildTinyDir(bee);
  console.log(`  dirRef:        ${aDir.dirRef}`);

  const aManifest = await bee.createFeedManifest(BATCH_ID, aTopic, aOwner);
  const aManifestRef = aManifest.toString().toLowerCase().replace(/^0x/, "");
  console.log(`  feedManifest:  ${aManifestRef}`);

  const aWriter = bee.makeFeedWriter(aTopic, aSigner);
  const aUpload = await aWriter.uploadReference(BATCH_ID, new Reference(aDir.dirRef));
  const aSocRef = aUpload.reference.toString().toLowerCase().replace(/^0x/, "");
  console.log(`  soc ref:       ${aSocRef}`);

  // Offer every hop in the resolution chain so the only variable is whether
  // /bzz traversal through the legacy SOC inner chunk works.
  for (const r of [aManifestRef, aSocRef, aDir.dirRef]) await offer(token, r);
  console.log("  offered:       manifest + soc + dirRef");
  await new Promise((r) => setTimeout(r, 4000));

  for (const { label, url } of [
    { label: "/bzz/{feedManifest}/index.html", url: `${ETHERNA_GW}/bzz/${aManifestRef}/index.html` },
    { label: "/bzz/{feedManifest}/",            url: `${ETHERNA_GW}/bzz/${aManifestRef}/` },
    { label: "/bzz/{dirRef}/index.html (control)", url: `${ETHERNA_GW}/bzz/${aDir.dirRef}/index.html` },
    { label: "/bytes/{feedManifest} (raw)",     url: `${ETHERNA_GW}/bytes/${aManifestRef}` },
  ]) {
    const r = await anonGet(url);
    console.log(`  ${label.padEnd(45)} → ${r.status}  (${r.len}B)  "${r.body}"`);
  }

  // ====================================================================
  // CASE B — inline SOC (uploadPayload with raw manifest chunk bytes).
  // SOC inner chunk's payload IS the manifest, no extra hop required.
  // ====================================================================
  console.log("\n=== CASE B: inline SOC (uploadPayload → raw manifest chunk bytes) ===");
  const bSigner = new PrivateKey(("0x" + randomBytes(32).toString("hex")) as `0x${string}`);
  const bOwner = bSigner.publicKey().address();
  const bTopic = Topic.fromString(`woco-probe-inline-${Date.now()}`);

  const bDir = await buildTinyDir(bee);
  console.log(`  dirRef:        ${bDir.dirRef}`);

  // Fetch the raw bytes of the dir manifest's root chunk (span + payload).
  // Strip the 8-byte span — SOC's payload param is just the data portion.
  const dirChunkBytes = await downloadChunkBytes(token, bDir.dirRef);
  if (dirChunkBytes.length < 9) throw new Error("dir chunk unexpectedly small");
  const dirManifestPayload = dirChunkBytes.slice(8);
  console.log(`  manifest payload bytes: ${dirManifestPayload.length} (max 4096 fits in SOC)`);

  const bManifest = await bee.createFeedManifest(BATCH_ID, bTopic, bOwner);
  const bManifestRef = bManifest.toString().toLowerCase().replace(/^0x/, "");
  console.log(`  feedManifest:  ${bManifestRef}`);

  const bWriter = bee.makeFeedWriter(bTopic, bSigner);
  let bSocRef = "";
  try {
    const bUpload = await bWriter.uploadPayload(BATCH_ID, dirManifestPayload);
    bSocRef = bUpload.reference.toString().toLowerCase().replace(/^0x/, "");
    console.log(`  soc ref:       ${bSocRef}`);
  } catch (e: any) {
    console.warn(`  uploadPayload failed (payload may exceed 4096B): ${e?.message ?? e}`);
  }

  if (bSocRef) {
    for (const r of [bManifestRef, bSocRef, bDir.dirRef]) await offer(token, r);
    console.log("  offered:       manifest + soc + dirRef");
    await new Promise((r) => setTimeout(r, 4000));

    for (const { label, url } of [
      { label: "/bzz/{feedManifest}/index.html", url: `${ETHERNA_GW}/bzz/${bManifestRef}/index.html` },
      { label: "/bzz/{feedManifest}/",            url: `${ETHERNA_GW}/bzz/${bManifestRef}/` },
      { label: "/bytes/{feedManifest} (raw)",     url: `${ETHERNA_GW}/bytes/${bManifestRef}` },
    ]) {
      const r = await anonGet(url);
      console.log(`  ${label.padEnd(45)} → ${r.status}  (${r.len}B)  "${r.body}"`);
    }
  }

  console.log("\n=== Interpretation ===");
  console.log("  CASE A 200 on /bzz/{feedManifest}/... → legacy resolution works, no fix needed.");
  console.log("  CASE A non-200 + CASE B 200 → switch site-pointer feeds to inline writes.");
  console.log("  Both non-200 → wait on beehive align OR change ENS resolution shape.");
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
});
