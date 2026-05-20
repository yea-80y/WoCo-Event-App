/**
 * Upload + download throughput comparison: woco gateway vs Etherna gateway.
 *
 * For each size, uploads random bytes via /bytes to both gateways, then
 * downloads the resulting ref back via anonymous /bytes/{ref}. Reports
 * MB/s and wall-clock per leg.
 *
 * Etherna gotcha: anonymous reads require an offer registered against the
 * ref. We register one after upload (POST /resources/{ref}/offers) before
 * timing the download. Woco-proxy auto-whitelists uploaded refs, so its
 * anonymous read works immediately.
 *
 * Run:
 *   cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *     && npx tsx scripts/gateway-speed-test.ts
 *
 * Cost: ~tiny against existing depth-20 batch (a few MB of random bytes).
 */
import { randomBytes } from "node:crypto";

const WOCO_GW = "https://gateway.woco-net.com";
const ETHERNA_GW = "https://gateway.etherna.io";
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const WOCO_BATCH = "5b915b7bbeb9908ffc0fc4c68aadaf4cea63c6e951299ad67f058b1e7ae8cfe9";
const ETHERNA_BATCH = "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";
const SIZES_MB = [0.1, 1, 5];
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
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

type Leg = { ms: number; mbps: number };

async function timeUploadWoco(payload: Uint8Array): Promise<{ ref: string; leg: Leg }> {
  const t0 = performance.now();
  const r = await fetch(`${WOCO_GW}/bytes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "swarm-postage-batch-id": WOCO_BATCH,
    },
    body: payload,
  });
  if (!r.ok) throw new Error(`woco upload ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { reference: string };
  const ms = performance.now() - t0;
  return { ref: j.reference, leg: { ms, mbps: (payload.length / 1e6) / (ms / 1000) } };
}

async function timeUploadEtherna(payload: Uint8Array, token: string): Promise<{ ref: string; leg: Leg }> {
  const t0 = performance.now();
  const r = await fetch(`${ETHERNA_GW}/bytes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "swarm-postage-batch-id": ETHERNA_BATCH,
      "Authorization": `Bearer ${token}`,
    },
    body: payload,
  });
  if (!r.ok) throw new Error(`etherna upload ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { reference: string };
  const ms = performance.now() - t0;
  return { ref: j.reference, leg: { ms, mbps: (payload.length / 1e6) / (ms / 1000) } };
}

async function registerEthernaOffer(ref: string, token: string): Promise<void> {
  const r = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 409) {
    console.warn(`  ⚠ offer register ${r.status}: ${await r.text()}`);
  }
}

async function timeDownload(gw: string, ref: string, size: number): Promise<Leg> {
  const t0 = performance.now();
  const r = await fetch(`${gw}/bytes/${ref}`);
  if (!r.ok) throw new Error(`download ${gw} → ${r.status}`);
  const buf = await r.arrayBuffer();
  const ms = performance.now() - t0;
  if (buf.byteLength !== size) console.warn(`  ⚠ size mismatch: got ${buf.byteLength}, expected ${size}`);
  return { ms, mbps: (size / 1e6) / (ms / 1000) };
}

function fmt(leg: Leg) {
  return `${leg.ms.toFixed(0)}ms (${leg.mbps.toFixed(2)} MB/s)`;
}

async function main() {
  const token = await ethernaToken();
  console.log("[auth] etherna token ok");
  console.log(`[config] woco-batch=${WOCO_BATCH.slice(0, 10)}… etherna-batch=${ETHERNA_BATCH.slice(0, 10)}… sizes=${SIZES_MB.join("/")}MB runs=${RUNS_PER_SIZE}\n`);

  type Row = { size: number; wocoUp: Leg[]; wocoDown: Leg[]; ethUp: Leg[]; ethDown: Leg[] };
  const rows: Row[] = [];

  for (const sizeMB of SIZES_MB) {
    const bytes = Math.round(sizeMB * 1e6);
    const row: Row = { size: sizeMB, wocoUp: [], wocoDown: [], ethUp: [], ethDown: [] };

    for (let i = 0; i < RUNS_PER_SIZE; i++) {
      const payload = randomBytes(bytes);
      console.log(`[${sizeMB}MB run ${i + 1}/${RUNS_PER_SIZE}]`);

      const wU = await timeUploadWoco(payload);
      console.log(`  woco UP   ${fmt(wU.leg)}  → ${wU.ref.slice(0, 12)}…`);
      row.wocoUp.push(wU.leg);

      const wD = await timeDownload(WOCO_GW, wU.ref, bytes);
      console.log(`  woco DOWN ${fmt(wD)}`);
      row.wocoDown.push(wD);

      const eU = await timeUploadEtherna(payload, token);
      console.log(`  ethr UP   ${fmt(eU.leg)}  → ${eU.ref.slice(0, 12)}…`);
      row.ethUp.push(eU.leg);

      await registerEthernaOffer(eU.ref, token);
      const eD = await timeDownload(ETHERNA_GW, eU.ref, bytes);
      console.log(`  ethr DOWN ${fmt(eD)}\n`);
      row.ethDown.push(eD);
    }
    rows.push(row);
  }

  const avg = (a: Leg[]) => ({ ms: a.reduce((s, x) => s + x.ms, 0) / a.length, mbps: a.reduce((s, x) => s + x.mbps, 0) / a.length });

  console.log("=== SUMMARY (avg per size) ===");
  console.log("size      woco UP            woco DOWN          etherna UP         etherna DOWN");
  for (const r of rows) {
    console.log(
      `${r.size}MB     `,
      fmt(avg(r.wocoUp)).padEnd(20),
      fmt(avg(r.wocoDown)).padEnd(20),
      fmt(avg(r.ethUp)).padEnd(20),
      fmt(avg(r.ethDown)),
    );
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
