/**
 * One-off: tar dist-multisite/, upload as /bzz collection on Etherna, then
 * GET /chunks/{rootRef} and report the root manifest chunk's payload size.
 * Tells us whether the inline-SOC fix (SOC payload ≤ 4096B) is viable for
 * real WoCo deployed sites.
 *
 * Uses Etherna because our local bee-proxy doesn't expose /chunks. Chunk
 * format is identical Swarm-wide so the measurement is the same.
 *
 * Run:
 *   cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *     && npx tsx scripts/measure-multisite-root-chunk.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync } from "node:fs";

const ETHERNA_GW = "https://gateway.etherna.io";
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const BATCH = "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";
const DIST = `${process.cwd()}/../web/dist-multisite`;

try { statSync(DIST); } catch { throw new Error(`dist not found: ${DIST}`); }

async function getToken(): Promise<string> {
  const apiKey = process.env.ETHERNA_API_KEY;
  if (!apiKey) throw new Error("ETHERNA_API_KEY env required");
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
  if (!res.ok) throw new Error(`token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const token = await getToken();
console.log("[01] auth ok");

const ts = Date.now();
const tarPath = `/tmp/woco-measure-${ts}.tar`;
console.log(`[02] tarring ${DIST} → ${tarPath}`);
execSync(`tar -cf ${tarPath} -C ${DIST} .`);
const tarSize = statSync(tarPath).size;
console.log(`     tar size: ${(tarSize / 1024 / 1024).toFixed(2)} MB`);

console.log("[03] uploading as /bzz collection to Etherna…");
const tarData = readFileSync(tarPath);
const up = await fetch(`${ETHERNA_GW}/bzz?name=multi-site.html`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/x-tar",
    "Swarm-Postage-Batch-Id": BATCH,
    "Swarm-Index-Document": "multi-site.html",
    "Swarm-Error-Document": "multi-site.html",
    "Swarm-Collection": "true",
    "Swarm-Deferred-Upload": "true",
  },
  // @ts-ignore
  duplex: "half",
  body: tarData,
});
if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);
const { reference: rootRef } = (await up.json()) as { reference: string };
console.log(`     rootRef: ${rootRef}`);
unlinkSync(tarPath);

console.log("[04] GET /chunks/{rootRef}…");
let chunkBytes: Uint8Array | undefined;
for (let i = 0; i < 8; i++) {
  const res = await fetch(`${ETHERNA_GW}/chunks/${rootRef}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    chunkBytes = new Uint8Array(await res.arrayBuffer());
    break;
  }
  console.log(`     attempt ${i + 1}: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 3000));
}
if (!chunkBytes) throw new Error("failed to fetch root chunk");

const span = Number(new DataView(chunkBytes.buffer).getBigUint64(0, true));
const payload = chunkBytes.subarray(8);

console.log("\n=== Root manifest chunk measurement ===");
console.log(`  total chunk bytes:   ${chunkBytes.length}`);
console.log(`  span (declared):     ${span}`);
console.log(`  payload bytes:       ${payload.length}`);
console.log(`  SOC max payload:     4096`);
console.log(`  fits inline?         ${payload.length <= 4096 ? "YES ✅" : "NO ❌ — inline fix won't work for this site as-is"}`);
console.log(`  headroom:            ${4096 - payload.length} bytes`);
