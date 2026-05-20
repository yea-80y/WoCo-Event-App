/**
 * Fetch live Etherna chainstate + report batch cost at user-supplied depth/TTL.
 * Run: cd apps/server && export $(grep -v '^#' .env | xargs -d '\n') \
 *      && npx tsx scripts/etherna-chainstate.ts
 */
const TOKEN_ENDPOINT = "https://sso.etherna.io/connect/token";
const GW = "https://gateway.etherna.io";

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
  if (!r.ok) throw new Error(`token ${r.status}`);
  return ((await r.json()) as any).access_token;
}

const token = await getToken();
const cs = await fetch(`${GW}/api/v0.3/system/chainstate`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log("HTTP", cs.status);
const csJson = await cs.json();
console.log("chainstate:", JSON.stringify(csJson, null, 2));

const credit = await fetch(`${GW}/api/v0.3/users/current/credit`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log("\ncredit HTTP", credit.status);
console.log("credit:", JSON.stringify(await credit.json(), null, 2));

const price = BigInt(csJson.currentPrice ?? csJson.CurrentPrice ?? 0);
if (!price) { console.log("\n(no currentPrice field — inspect raw response above)"); process.exit(0); }

const GNOSIS_BLOCK_SEC = 5;
const SECONDS_PER_DAY = 86_400n;
const BZZ_PER_PLUR = 1e16; // 1 BZZ = 1e16 PLUR

function quote(depth: number, days: number, marginPct: number) {
  const blocks = (BigInt(days) * SECONDS_PER_DAY) / BigInt(GNOSIS_BLOCK_SEC);
  const baseAmountPerChunk = price * blocks;
  const margined = (baseAmountPerChunk * BigInt(100 + marginPct)) / 100n;
  const totalChunks = 1n << BigInt(depth);
  const totalPlur = margined * totalChunks;
  const totalBzz = Number(totalPlur) / BZZ_PER_PLUR;
  const effectiveMB =
    depth === 17 ? 0.0447 :
    depth === 18 ? 6.66 :
    depth === 19 ? 112 :
    depth === 20 ? 688 :
    depth === 21 ? 2_600 : NaN;
  return { depth, days, marginPct, blocks, baseAmountPerChunk, margined, totalChunks, totalPlur, totalBzz, effectiveMB };
}

console.log("\n=== Batch quotes ===");
console.log(`currentPrice: ${price} PLUR/chunk/block`);
console.log(`blocks/day @ ${GNOSIS_BLOCK_SEC}s: ${Number(SECONDS_PER_DAY / BigInt(GNOSIS_BLOCK_SEC))}`);
for (const cfg of [
  { depth: 19, days: 30, margin: 0 },
  { depth: 19, days: 30, margin: 25 },
  { depth: 19, days: 30, margin: 50 },
  { depth: 19, days: 60, margin: 25 },
  { depth: 18, days: 30, margin: 25 },
]) {
  const q = quote(cfg.depth, cfg.days, cfg.margin);
  console.log(
    `\n  depth ${q.depth} (~${q.effectiveMB}MB), ${q.days}d TTL, +${q.marginPct}% margin:`,
    `\n    amount/chunk: ${q.margined}`,
    `\n    total PLUR:   ${q.totalPlur}`,
    `\n    total BZZ:    ${q.totalBzz.toFixed(4)}`,
  );
}
