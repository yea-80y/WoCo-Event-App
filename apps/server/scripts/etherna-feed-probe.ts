/**
 * Focused probe: why does /bzz/{feedManifest}/ return 400 on Etherna even
 * after every chunk in the chain is offered?
 *
 * Hypotheses we test, in order:
 *  H1. bee-js's `writer.uploadReference()` wraps the 32-byte ref in extra
 *      bytes that /bzz can't parse. Test: write raw 32-byte ref via
 *      `bee.uploadData()` + `writer.upload()` (low-level) instead.
 *  H2. The /bzz manifest at v_n needs an explicit `indexDocument` for
 *      directory-style resolution. Test: re-upload with `indexDocument: "payload"`.
 *  H3. Etherna's v1 path (`/v1/bzz/`) handles feed-manifest resolution differently.
 *
 * Run: ETHERNA_API_KEY=<id>.<secret> npx tsx scripts/etherna-feed-probe.ts
 */

import { Bee, PrivateKey, Topic, Reference } from "@ethersphere/bee-js";
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
  return ((await res.json()) as { access_token: string }).access_token;
}

async function offer(token: string, ref: string): Promise<void> {
  const res = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`offer ${ref.slice(0, 12)}: ${res.status} ${await res.text()}`);
}

async function probe(label: string, url: string): Promise<void> {
  const res = await fetch(url, { redirect: "manual" });
  const body = await res.text().catch(() => "");
  const idx = res.headers.get("swarm-feed-index");
  const ct = res.headers.get("content-type");
  console.log(`  ${label.padEnd(40)} → HTTP ${res.status} ${idx ? `[idx ${idx}]` : ""} ${ct ? `[ct ${ct}]` : ""} body="${body.slice(0, 60).replace(/\n/g, "\\n")}"`);
}

async function main() {
  const token = await getToken();
  console.log("[01] auth ok");

  beeAxios.interceptors.request.use((cfg: any) => {
    const url = `${cfg.baseURL ?? ""}${cfg.url ?? ""}`;
    if (url.startsWith(ETHERNA_GW)) {
      cfg.headers = cfg.headers ?? {};
      cfg.headers.Authorization = `Bearer ${token}`;
    }
    return cfg;
  });

  const bee = new Bee(ETHERNA_GW);
  const signer = new PrivateKey(("0x" + randomBytes(32).toString("hex")) as `0x${string}`);
  const owner = signer.publicKey().address();
  const topic = Topic.fromString(`woco-probe-${Date.now()}`);
  console.log("[02] owner:", owner.toHex(), "topic:", topic.toHex().slice(0, 16) + "…");

  const manifestResult = await bee.createFeedManifest(BATCH_ID, topic, owner);
  const manifestRef = manifestResult.toString().toLowerCase().replace(/^0x/, "");
  console.log("[03] feed manifest:", manifestRef);
  await offer(token, manifestRef);

  const writer = bee.makeFeedWriter(topic, signer);

  // --- H1: write feed payload as RAW 32-byte ref via low-level writer.upload() ---
  // This bypasses any wrapping that uploadReference() might add. We point at a
  // /bzz manifest so the cascade has a chance.
  const payload = new TextEncoder().encode("WOCO-PROBE-RAW");
  const upBzz = await bee.uploadFile(BATCH_ID, payload, "payload", {
    deferred: true,
    contentType: "text/plain",
  });
  const bzzRef = upBzz.reference.toString().toLowerCase();
  console.log("[04] /bzz file ref:", bzzRef);
  await offer(token, bzzRef);

  // writer.upload(BATCH_ID, Reference) — sends 32-byte raw payload. Compare
  // with writer.uploadReference() which is the same in bee-js v11 but worth
  // verifying by inspecting both.
  await writer.upload(BATCH_ID, new Reference(bzzRef));
  console.log("[05] feed @0 written via writer.upload(Reference)");

  // --- H2: also upload a /bzz folder containing the payload AS index ---
  const upDir = await bee.uploadFiles(
    BATCH_ID,
    [new File([payload], "index.html", { type: "text/plain" })],
    { deferred: true, indexDocument: "index.html" },
  );
  const dirRef = upDir.reference.toString().toLowerCase();
  console.log("[06] /bzz dir ref (index.html):", dirRef);
  await offer(token, dirRef);

  // Write feed @1 pointing at dir manifest with indexDocument
  await writer.upload(BATCH_ID, new Reference(dirRef));
  console.log("[07] feed @1 → dir manifest with indexDocument");

  await new Promise((r) => setTimeout(r, 4000));

  // --- Read probes ---
  console.log("\n=== read probes ===");
  await probe("/bytes/{manifest}",            `${ETHERNA_GW}/bytes/${manifestRef}`);
  await probe("/bzz/{manifest}",              `${ETHERNA_GW}/bzz/${manifestRef}`);
  await probe("/bzz/{manifest}/",             `${ETHERNA_GW}/bzz/${manifestRef}/`);
  await probe("/bzz/{manifest}/index.html",   `${ETHERNA_GW}/bzz/${manifestRef}/index.html`);
  await probe("/bzz/{manifest}/payload",      `${ETHERNA_GW}/bzz/${manifestRef}/payload`);
  await probe("/v1/bzz/{manifest}/",          `${ETHERNA_GW}/v1/bzz/${manifestRef}/`);
  await probe("/ev1/bzz/{manifest}/",         `${ETHERNA_GW}/ev1/bzz/${manifestRef}/`);

  console.log("\n=== sanity: direct refs (already offered) ===");
  await probe("/bzz/{bzzRef}",                `${ETHERNA_GW}/bzz/${bzzRef}`);
  await probe("/bzz/{dirRef}/",               `${ETHERNA_GW}/bzz/${dirRef}/`);
  await probe("/bzz/{dirRef}/index.html",     `${ETHERNA_GW}/bzz/${dirRef}/index.html`);

  console.log("\n=== feed read via /feeds (auth required, expect 401 anon) ===");
  await probe(
    "/feeds/{owner}/{topic}",
    `${ETHERNA_GW}/feeds/${owner.toHex().replace(/^0x/, "")}/${topic.toHex()}`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
