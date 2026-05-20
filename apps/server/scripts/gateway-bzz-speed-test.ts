/**
 * /bzz collection upload + anonymous read comparison: woco vs Etherna.
 *
 * Closer to real site deploys than /bytes — sends tar-encoded collections
 * with Swarm-Collection, Swarm-Index-Document headers; reads back via
 * anonymous /bzz/{ref} (the path real visitors hit).
 *
 * For Etherna we register an offer after upload (anonymous /bzz reads
 * require this). For woco the proxy auto-whitelists uploaded refs.
 *
 * Run:
 *   cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *     && npx tsx scripts/gateway-bzz-speed-test.ts
 *
 * Cost: tiny — ~17MB total across both batches.
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WOCO_GW = "https://gateway.woco-net.com";
const ETHERNA_GW = "https://gateway.etherna.io";
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const WOCO_BATCH = "5b915b7bbeb9908ffc0fc4c68aadaf4cea63c6e951299ad67f058b1e7ae8cfe9";
const ETHERNA_BATCH = "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";
const SIZES_MB = [0.5, 2, 5];
const RUNS_PER_SIZE = 2;

async function ethernaToken(): Promise<string> {
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
  const r = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

type Leg = { ms: number; mbps: number };

function buildTar(sizeBytes: number): { tar: Buffer; tarSize: number; payloadSize: number } {
  const dir = mkdtempSync(join(tmpdir(), "woco-bzz-"));
  // index.html small + a "data" file with random bytes that dominates size — keeps
  // the tar comparable across sizes and ensures real chunk splitting.
  const indexHtml = `<!doctype html><meta charset=utf-8><title>perf</title><p>perf-${Date.now()}</p>`;
  writeFileSync(join(dir, "index.html"), indexHtml);
  const blob = randomBytes(Math.max(0, sizeBytes - indexHtml.length));
  writeFileSync(join(dir, "asset.bin"), blob);
  const tarPath = join(dir, "out.tar");
  execSync(`tar -cf ${tarPath} -C ${dir} index.html asset.bin`);
  const tar = readFileSync(tarPath);
  const tarSize = statSync(tarPath).size;
  rmSync(dir, { recursive: true, force: true });
  return { tar, tarSize, payloadSize: sizeBytes };
}

async function uploadCollection(gw: string, batch: string, tar: Buffer, token?: string): Promise<{ ref: string; ms: number }> {
  const t0 = performance.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-tar",
    "swarm-postage-batch-id": batch,
    "swarm-index-document": "index.html",
    "swarm-error-document": "index.html",
    "swarm-collection": "true",
    "swarm-deferred-upload": "true",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(`${gw}/bzz`, { method: "POST", headers, body: tar });
  if (!r.ok) throw new Error(`upload ${gw} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { reference: string };
  return { ref: j.reference, ms: performance.now() - t0 };
}

async function registerEthernaOffer(ref: string, token: string): Promise<void> {
  const r = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 409) console.warn(`  ⚠ offer register ${r.status}: ${(await r.text()).slice(0, 100)}`);
}

async function downloadIndex(gw: string, ref: string): Promise<{ ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(`${gw}/bzz/${ref}/`);
  if (!r.ok) throw new Error(`download ${gw}/bzz/${ref}/ → ${r.status}`);
  const buf = await r.arrayBuffer();
  return { ms: performance.now() - t0, bytes: buf.byteLength };
}

async function downloadAsset(gw: string, ref: string): Promise<{ ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(`${gw}/bzz/${ref}/asset.bin`);
  if (!r.ok) throw new Error(`download ${gw}/bzz/${ref}/asset.bin → ${r.status}`);
  const buf = await r.arrayBuffer();
  return { ms: performance.now() - t0, bytes: buf.byteLength };
}

function leg(ms: number, bytes: number): Leg { return { ms, mbps: (bytes / 1e6) / (ms / 1000) }; }
function fmt(l: Leg) { return `${l.ms.toFixed(0)}ms (${l.mbps.toFixed(2)} MB/s)`; }
function avg(a: Leg[]): Leg { return { ms: a.reduce((s, x) => s + x.ms, 0) / a.length, mbps: a.reduce((s, x) => s + x.mbps, 0) / a.length }; }

async function main() {
  const token = await ethernaToken();
  console.log("[auth] etherna token ok");
  console.log(`[config] woco-batch=${WOCO_BATCH.slice(0, 10)}… etherna-batch=${ETHERNA_BATCH.slice(0, 10)}… sizes=${SIZES_MB.join("/")}MB runs=${RUNS_PER_SIZE}\n`);

  type Row = { size: number; wocoUp: Leg[]; wocoIdx: Leg[]; wocoAsset: Leg[]; ethUp: Leg[]; ethIdx: Leg[]; ethAsset: Leg[] };
  const rows: Row[] = [];

  for (const sizeMB of SIZES_MB) {
    const sizeBytes = Math.round(sizeMB * 1e6);
    const row: Row = { size: sizeMB, wocoUp: [], wocoIdx: [], wocoAsset: [], ethUp: [], ethIdx: [], ethAsset: [] };

    for (let i = 0; i < RUNS_PER_SIZE; i++) {
      const { tar, tarSize } = buildTar(sizeBytes);
      console.log(`[${sizeMB}MB run ${i + 1}/${RUNS_PER_SIZE}]  tar=${(tarSize / 1e6).toFixed(2)}MB`);

      const wU = await uploadCollection(WOCO_GW, WOCO_BATCH, tar);
      const wULeg = leg(wU.ms, tarSize);
      console.log(`  woco UP    ${fmt(wULeg)}  → ${wU.ref.slice(0, 12)}…`);
      row.wocoUp.push(wULeg);

      const wIdx = await downloadIndex(WOCO_GW, wU.ref);
      const wIdxLeg = leg(wIdx.ms, wIdx.bytes);
      console.log(`  woco GET / ${fmt(wIdxLeg)}  (${wIdx.bytes}B)`);
      row.wocoIdx.push(wIdxLeg);

      const wAsset = await downloadAsset(WOCO_GW, wU.ref);
      const wAssetLeg = leg(wAsset.ms, wAsset.bytes);
      console.log(`  woco GET asset ${fmt(wAssetLeg)}`);
      row.wocoAsset.push(wAssetLeg);

      const eU = await uploadCollection(ETHERNA_GW, ETHERNA_BATCH, tar, token);
      const eULeg = leg(eU.ms, tarSize);
      console.log(`  ethr UP    ${fmt(eULeg)}  → ${eU.ref.slice(0, 12)}…`);
      row.ethUp.push(eULeg);

      await registerEthernaOffer(eU.ref, token);

      const eIdx = await downloadIndex(ETHERNA_GW, eU.ref);
      const eIdxLeg = leg(eIdx.ms, eIdx.bytes);
      console.log(`  ethr GET / ${fmt(eIdxLeg)}  (${eIdx.bytes}B)`);
      row.ethIdx.push(eIdxLeg);

      const eAsset = await downloadAsset(ETHERNA_GW, eU.ref);
      const eAssetLeg = leg(eAsset.ms, eAsset.bytes);
      console.log(`  ethr GET asset ${fmt(eAssetLeg)}\n`);
      row.ethAsset.push(eAssetLeg);
    }
    rows.push(row);
  }

  console.log("=== SUMMARY (avg per size) ===");
  console.log("size     woco UP             woco GET /          woco GET asset      etherna UP          etherna GET /       etherna GET asset");
  for (const r of rows) {
    console.log(
      `${r.size}MB    `,
      fmt(avg(r.wocoUp)).padEnd(20),
      fmt(avg(r.wocoIdx)).padEnd(20),
      fmt(avg(r.wocoAsset)).padEnd(20),
      fmt(avg(r.ethUp)).padEnd(20),
      fmt(avg(r.ethIdx)).padEnd(20),
      fmt(avg(r.ethAsset)),
    );
  }
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
