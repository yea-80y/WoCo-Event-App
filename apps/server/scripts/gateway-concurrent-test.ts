/**
 * Concurrent multi-asset fetch comparison: woco vs Etherna.
 *
 * Closest test to real-site UX — uploads a single tar collection with N
 * asset files, then fires GETs in parallel and measures wall-clock to
 * first-byte and total. Real sites issue 10-50 parallel asset fetches.
 *
 * Run:
 *   cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *     && npx tsx scripts/gateway-concurrent-test.ts
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WOCO_GW = "https://gateway.woco-net.com";
const ETHERNA_GW = "https://gateway.etherna.io";
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const WOCO_BATCH = "5b915b7bbeb9908ffc0fc4c68aadaf4cea63c6e951299ad67f058b1e7ae8cfe9";
const ETHERNA_BATCH = "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";

// Realistic mix: small JS/CSS-ish files + medium image-ish files + few large bundles.
const ASSET_PROFILES = [
  { count: 10, sizeBytes: 50_000, label: "10× ~50KB" },     // CSS/JS chunks
  { count: 8, sizeBytes: 200_000, label: "8× ~200KB" },     // images
  { count: 2, sizeBytes: 1_500_000, label: "2× ~1.5MB" },   // large image / hero
];
const RUNS = 2;

async function ethernaToken(): Promise<string> {
  const apiKey = process.env.ETHERNA_API_KEY!;
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

function buildSiteTar(): { tar: Buffer; assetNames: string[]; totalBytes: number } {
  const dir = mkdtempSync(join(tmpdir(), "woco-conc-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>perf</title>`);
  const assetNames: string[] = [];
  let totalBytes = 0;
  let idx = 0;
  for (const p of ASSET_PROFILES) {
    for (let i = 0; i < p.count; i++) {
      const name = `asset-${idx++}.bin`;
      writeFileSync(join(dir, name), randomBytes(p.sizeBytes));
      assetNames.push(name);
      totalBytes += p.sizeBytes;
    }
  }
  const tarPath = join(dir, "out.tar");
  execSync(`tar -cf ${tarPath} -C ${dir} index.html ${assetNames.join(" ")}`);
  const tar = readFileSync(tarPath);
  rmSync(dir, { recursive: true, force: true });
  return { tar, assetNames, totalBytes };
}

async function uploadCollection(gw: string, batch: string, tar: Buffer, token?: string): Promise<string> {
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
  return ((await r.json()) as { reference: string }).reference;
}

async function fetchAsset(gw: string, ref: string, name: string): Promise<{ ms: number; bytes: number; ok: boolean; status: number }> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${gw}/bzz/${ref}/${name}`);
    const buf = await r.arrayBuffer();
    return { ms: performance.now() - t0, bytes: buf.byteLength, ok: r.ok, status: r.status };
  } catch (e) {
    return { ms: performance.now() - t0, bytes: 0, ok: false, status: 0 };
  }
}

async function concurrentFetch(gw: string, ref: string, names: string[]): Promise<{ wallMs: number; perReq: number[]; failures: number; bytesTotal: number }> {
  const start = performance.now();
  const results = await Promise.all(names.map((n) => fetchAsset(gw, ref, n)));
  const wallMs = performance.now() - start;
  const perReq = results.map((r) => r.ms);
  const failures = results.filter((r) => !r.ok).length;
  const bytesTotal = results.reduce((s, r) => s + r.bytes, 0);
  return { wallMs, perReq, failures, bytesTotal };
}

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.floor((sorted.length - 1) * p);
  return sorted[i];
}

async function main() {
  const token = await ethernaToken();
  console.log("[auth] etherna token ok");

  const profileSummary = ASSET_PROFILES.map((p) => p.label).join(", ");
  console.log(`[config] assets: ${profileSummary} = ${ASSET_PROFILES.reduce((s, p) => s + p.count, 0)} files`);
  console.log(`[config] runs: ${RUNS}\n`);

  type Row = { run: number; wocoWall: number; ethWall: number; wocoP50: number; wocoP95: number; ethP50: number; ethP95: number; wocoFail: number; ethFail: number; bytes: number };
  const rows: Row[] = [];

  for (let run = 1; run <= RUNS; run++) {
    const { tar, assetNames, totalBytes } = buildSiteTar();
    console.log(`[run ${run}/${RUNS}] tar=${(tar.length / 1e6).toFixed(2)}MB  assets=${assetNames.length}  total=${(totalBytes / 1e6).toFixed(2)}MB`);

    const wocoRef = await uploadCollection(WOCO_GW, WOCO_BATCH, tar);
    console.log(`  uploaded woco: ${wocoRef.slice(0, 12)}…`);

    const ethRef = await uploadCollection(ETHERNA_GW, ETHERNA_BATCH, tar, token);
    console.log(`  uploaded ethr: ${ethRef.slice(0, 12)}…`);

    // Register Etherna offer for anonymous access
    const offerRes = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ethRef}/offers`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (!offerRes.ok && offerRes.status !== 409) console.warn(`  ⚠ offer register ${offerRes.status}`);

    console.log(`  fanning out ${assetNames.length} parallel GETs to each gateway…`);

    const woco = await concurrentFetch(WOCO_GW, wocoRef, assetNames);
    console.log(`  woco:    wall=${woco.wallMs.toFixed(0)}ms  p50=${pct(woco.perReq, 0.5).toFixed(0)}ms  p95=${pct(woco.perReq, 0.95).toFixed(0)}ms  fail=${woco.failures}  recv=${(woco.bytesTotal / 1e6).toFixed(2)}MB`);

    const eth = await concurrentFetch(ETHERNA_GW, ethRef, assetNames);
    console.log(`  ethr:    wall=${eth.wallMs.toFixed(0)}ms  p50=${pct(eth.perReq, 0.5).toFixed(0)}ms  p95=${pct(eth.perReq, 0.95).toFixed(0)}ms  fail=${eth.failures}  recv=${(eth.bytesTotal / 1e6).toFixed(2)}MB\n`);

    rows.push({
      run, bytes: totalBytes,
      wocoWall: woco.wallMs, ethWall: eth.wallMs,
      wocoP50: pct(woco.perReq, 0.5), wocoP95: pct(woco.perReq, 0.95),
      ethP50: pct(eth.perReq, 0.5), ethP95: pct(eth.perReq, 0.95),
      wocoFail: woco.failures, ethFail: eth.failures,
    });
  }

  console.log("=== SUMMARY ===");
  const avg = (k: keyof Row) => (rows.reduce((s, r) => s + (r[k] as number), 0) / rows.length).toFixed(0);
  console.log(`woco:    wall=${avg("wocoWall")}ms  p50=${avg("wocoP50")}ms  p95=${avg("wocoP95")}ms  total_fail=${rows.reduce((s, r) => s + r.wocoFail, 0)}`);
  console.log(`ethr:    wall=${avg("ethWall")}ms  p50=${avg("ethP50")}ms  p95=${avg("ethP95")}ms  total_fail=${rows.reduce((s, r) => s + r.ethFail, 0)}`);
  const wocoMBps = (rows[0].bytes / 1e6) / (Number(avg("wocoWall")) / 1000);
  const ethMBps = (rows[0].bytes / 1e6) / (Number(avg("ethWall")) / 1000);
  console.log(`\neffective throughput (total bytes / wall):  woco=${wocoMBps.toFixed(2)} MB/s   ethr=${ethMBps.toFixed(2)} MB/s`);
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
