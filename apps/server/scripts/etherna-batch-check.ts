// One-shot: verify ETHERNA platform-batch candidate is alive + usable.
import { ensureEthernaToken, getCachedEthernaToken } from "../src/lib/etherna/auth.js";

const GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
const BATCH = process.argv[2] ?? "fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a";

async function main() {
  await ensureEthernaToken();
  const tok = getCachedEthernaToken();
  if (!tok) {
    console.error("NO TOKEN (set ETHERNA_ENABLED=true + ETHERNA_API_KEY)");
    process.exit(1);
  }
  const r = await fetch(`${GW}/stamps/${BATCH}`, { headers: { Authorization: `Bearer ${tok}` } });
  console.log("HTTP", r.status);
  const text = await r.text();
  console.log(text.slice(0, 800));
}

main().catch((e) => { console.error(e); process.exit(1); });
