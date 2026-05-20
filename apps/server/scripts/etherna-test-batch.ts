/**
 * Etherna test batch — observability run, not a "real" deploy.
 *
 * Goal: spend a tiny amount of credit to learn the EXACT xDai debit for a
 * known batch config. The Etherna API exposes credit balance but doesn't
 * publish a clean BZZ↔xDai rate, and `byteprice` has an ambiguous time
 * unit. Buying a small known-config batch and reading `balance_before /
 * balance_after` is the cleanest way to anchor our future per-user pricing.
 *
 * Config: depth 18 (~6.66 MB effective), 24h TTL — Bee's typical minimum.
 *
 * RUN ONLY WHEN APPROVED:
 *   cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *     && npx tsx scripts/etherna-test-batch.ts
 *
 * Safety:
 * - Hard cap: refuses to provision if estimated cost would exceed
 *   $TEST_BATCH_MAX_XDAI (default $1.00). Adjust below if needed.
 * - Prints what it WILL do and pauses 5s before calling /stamps so you can
 *   ^C out if a number looks wrong.
 * - Does NOT mark the batch usable yet — just provisions, then exits. Use
 *   the batchId returned to do something with it later (e.g. test upload).
 */

const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const GW = "https://gateway.etherna.io";

const DEPTH = 18;
const TTL_DAYS = 1;                    // 24 h
const MARGIN_PCT = 50;                 // matches existing depth-20 batch
const GNOSIS_BLOCK_SEC = 5;
const TEST_BATCH_MAX_XDAI = 1.0;       // hard safety cap — refuse if higher

async function getToken(): Promise<string> {
  const apiKey = process.env.ETHERNA_API_KEY!;
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
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return ((await r.json()) as any).access_token;
}

async function authGet(token: string, path: string) {
  const r = await fetch(`${GW}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function authPost(token: string, path: string) {
  const r = await fetch(`${GW}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

function readCreditWei(c: any): bigint {
  // credit2 returns balance as string wei; the deprecated credit returns
  // a decimal xDai. Prefer credit2 for precision.
  if (typeof c.balance === "string") return BigInt(c.balance);
  return BigInt(Math.round(Number(c.balance) * 1e18));
}

function xDaiHuman(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

async function main() {
  const token = await getToken();
  console.log("[01] auth ok");

  const chainstate = await authGet(token, "/api/v0.3/system/chainstate") as any;
  const currentPrice = BigInt(chainstate.currentPrice);
  const blockNumber = chainstate.block;
  console.log(`[02] chainstate: block=${blockNumber} currentPrice=${currentPrice} PLUR/chunk/block`);

  const blocksInTtl = BigInt(TTL_DAYS) * BigInt(86400 / GNOSIS_BLOCK_SEC);
  const baseAmount = currentPrice * blocksInTtl;
  const amountPerChunk = (baseAmount * BigInt(100 + MARGIN_PCT)) / 100n;
  const totalChunks = 1n << BigInt(DEPTH);
  const totalPlur = amountPerChunk * totalChunks;
  const totalBzz = Number(totalPlur) / 1e16;

  console.log(`[03] proposed config:`);
  console.log(`     depth:           ${DEPTH} (~6.66 MB effective, no EC)`);
  console.log(`     ttl:             ${TTL_DAYS}d (${blocksInTtl} blocks)`);
  console.log(`     margin:          +${MARGIN_PCT}%`);
  console.log(`     amount/chunk:    ${amountPerChunk} PLUR`);
  console.log(`     total chunks:    ${totalChunks}`);
  console.log(`     total commit:    ${totalPlur} PLUR  (= ${totalBzz.toFixed(6)} BZZ)`);

  const creditBefore = await authGet(token, "/api/v0.3/users/current/credit2") as any;
  const balBefore = readCreditWei(creditBefore);
  console.log(`[04] credit before:  ${xDaiHuman(balBefore)} xDai  (raw wei: ${balBefore})`);

  console.log(`\n[05] ABOUT TO PROVISION. Caps:`);
  console.log(`     - hard cap if debit > $${TEST_BATCH_MAX_XDAI} xDai (refuse)`);
  console.log(`     - 5s to ctrl-C before spend...`);
  await new Promise((r) => setTimeout(r, 5000));

  const url = `/stamps/${amountPerChunk}/${DEPTH}?label=woco-test-${Date.now()}`;
  console.log(`[06] POST ${url}`);
  const stamps = await authPost(token, url) as any;
  console.log(`     → batchID: ${stamps.batchID}`);
  console.log(`     → txHash:  ${stamps.txHash}`);

  // Settle a few seconds for the credit debit to register.
  console.log(`[07] waiting 8s for debit to register...`);
  await new Promise((r) => setTimeout(r, 8000));

  const creditAfter = await authGet(token, "/api/v0.3/users/current/credit2") as any;
  const balAfter = readCreditWei(creditAfter);
  const debit = balBefore - balAfter;

  console.log(`\n=== RESULT ===`);
  console.log(`  credit before:  ${xDaiHuman(balBefore)} xDai`);
  console.log(`  credit after:   ${xDaiHuman(balAfter)} xDai`);
  console.log(`  debit:          ${xDaiHuman(debit)} xDai  (= $${xDaiHuman(debit)} USD)`);
  console.log(`  BZZ committed:  ${totalBzz.toFixed(6)}`);
  console.log(`  → implied rate: 1 BZZ ≈ ${(Number(debit) / 1e18 / totalBzz).toFixed(4)} xDai`);
  console.log(`  batchID:        ${stamps.batchID}`);
  console.log(`  next: wait ~2 min for usable: true, or do nothing — it'll TTL out in 24h`);

  if (Number(debit) / 1e18 > TEST_BATCH_MAX_XDAI) {
    console.warn(`\n⚠ debit exceeded safety cap ($${TEST_BATCH_MAX_XDAI}). Reconsider before scaling up.`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
